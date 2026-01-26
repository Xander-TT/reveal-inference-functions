// src/shared/createInferenceRunGuard.js
const { getContainer, pk } = require("./cosmos");
const { buildInferenceRunDoc } = require("./inferenceRun");

/**
 * Creates an inferenceRun guard document.
 * If it already exists => returns { alreadyProcessed: true }.
 *
 * Also fetches the Project doc to obtain projectId.
 */
async function createInferenceRunGuard({ client_name, slug, requestedBy }) {
  const container = getContainer();

  // 1) Fetch project doc (within the same hierarchical partition)
  const querySpec = {
    query:
      "SELECT TOP 1 * FROM c WHERE c.docType = 'project' AND c.client_name = @client_name AND c.slug = @slug",
    parameters: [
      { name: "@client_name", value: client_name },
      { name: "@slug", value: slug },
    ],
  };

  const { resources: projects } = await container.items
    .query(querySpec, { partitionKey: pk(client_name, slug) })
    .fetchAll();

  if (!projects || projects.length === 0) {
    const err = new Error(`Project not found for client_name='${client_name}', slug='${slug}'`);
    err.statusCode = 404;
    throw err;
  }

  const project = projects[0];

  // 2) Create inferenceRun guard doc
  const guardDoc = buildInferenceRunDoc({
    client_name,
    slug,
    projectId: project.id,
    requestedBy,
  });

  try {
    const { resource } = await container.items.create(guardDoc, {
      partitionKey: pk(client_name, slug),
    });

    return {
      alreadyProcessed: false,
      projectId: project.id,
      runId: resource.id,
    };
  } catch (e) {
    // Cosmos conflict => already exists
    if (e.code === 409) {
      return { alreadyProcessed: true };
    }
    throw e;
  }
}

module.exports = { createInferenceRunGuard };
