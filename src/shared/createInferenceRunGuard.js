// src/shared/createInferenceRunGuard.js
const { getContainer, pk } = require("./cosmos");
const { buildInferenceRunDoc, inferenceRunIdForSlug } = require("./inferenceRun");

/**
 * Creates (or reuses) an inferenceRun guard document.
 *
 * Rules:
 * - If an inferenceRun exists with status === "Completed" => block (one-and-done).
 * - If it exists but status !== "Completed" (e.g. Failed/Running) => allow rerun and reuse the same runId.
 * - If it doesn't exist => create it (status Running).
 *
 * Also fetches the Project doc to obtain projectId.
 */
async function createInferenceRunGuard({ client_name, slug, requestedBy }) {
  const container = getContainer();
  const partitionKey = pk(client_name, slug);

  // 1) Fetch project doc (within the same hierarchical partition)
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
    const err = new Error(
      `Project not found for client_name='${client_name}', slug='${slug}'`
    );
    err.statusCode = 404;
    throw err;
  }

  const project = projects[0];

  // Canonical run id (also used as durable instance id)
  const runId = inferenceRunIdForSlug(client_name, slug);

  // 2) If an inferenceRun doc already exists, decide if we can rerun
  try {
    const { resource: existing } = await container.item(runId, partitionKey).read();
    if (existing) {
      if (existing.status === "Completed") {
        return { alreadyProcessed: true };
      }

      // Failed/Running/other => allow rerun, reuse same id
      return {
        alreadyProcessed: false,
        projectId: project.id,
        runId: existing.id,
      };
    }
  } catch (e) {
    // 404 means it doesn't exist, proceed to create
    if (!(e.statusCode === 404 || e.code === 404)) throw e;
  }

  // 3) Create inferenceRun guard doc
  const guardDoc = buildInferenceRunDoc({
    client_name,
    slug,
    projectId: project.id,
    requestedBy,
  });

  try {
    const { resource } = await container.items.create(guardDoc, { partitionKey });
    return {
      alreadyProcessed: false,
      projectId: project.id,
      runId: resource.id,
    };
  } catch (e) {
    // Cosmos conflict => someone created it between our read and create
    if (e.code === 409) {
      const { resource: existing } = await container.item(runId, partitionKey).read();
      if (existing?.status === "Completed") return { alreadyProcessed: true };
      return {
        alreadyProcessed: false,
        projectId: project.id,
        runId,
      };
    }
    throw e;
  }
}

module.exports = { createInferenceRunGuard };
