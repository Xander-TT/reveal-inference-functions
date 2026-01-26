const df = require("durable-functions");
const { getContainer, pk } = require("../shared/cosmos");

/**
 * Returns { project, floors } for a given client_name + slug.
 */
df.app.activity("GetProjectAndFloors", {
  handler: async (input) => {
    const { client_name, slug } = input || {};
    if (!client_name || !slug) {
      throw new Error("GetProjectAndFloors requires { client_name, slug }");
    }

    const container = getContainer();
    const partitionKey = pk(client_name, slug);

    // 1) project
    const projectQuery = {
      query:
        "SELECT TOP 1 * FROM c WHERE c.docType = 'project' AND c.client_name = @client_name AND c.slug = @slug",
      parameters: [
        { name: "@client_name", value: client_name },
        { name: "@slug", value: slug },
      ],
    };

    const { resources: projects } = await container.items
      .query(projectQuery, { partitionKey })
      .fetchAll();

    if (!projects || projects.length === 0) {
      const err = new Error(`Project not found for client_name='${client_name}', slug='${slug}'`);
      err.statusCode = 404;
      throw err;
    }

    const project = projects[0];

    // 2) floors
    const floorsQuery = {
      query:
        "SELECT * FROM c WHERE c.docType = 'floor' AND c.client_name = @client_name AND c.slug = @slug ORDER BY c.createdAt",
      parameters: [
        { name: "@client_name", value: client_name },
        { name: "@slug", value: slug },
      ],
    };

    const { resources: floors } = await container.items
      .query(floorsQuery, { partitionKey })
      .fetchAll();

    // Return a trimmed work list (avoid dragging _rid/_etag, etc. through durable history)
    const floorWork = (floors || []).map((f) => ({
      id: f.id,
      name: f.name,
      planUrl: f.planUrl,
      imageWidth: f.imageWidth,
      imageHeight: f.imageHeight,
      paperScaleDenominator: f.paperScaleDenominator,
      paperScaleText: f.paperScaleText,
    }));

    return {
      project: {
        id: project.id,
        client_name: project.client_name,
        slug: project.slug,
        name: project.name,
        projectNumber: project.projectNumber,
      },
      floors: floorWork,
    };
  },
});
