// src/shared/createInferenceRunGuard.js
const { getBuildingContainer, pkBuilding } = require("./cosmos");
const { buildInferenceRunDoc, inferenceRunIdForSlug } = require("./inferenceRun");

async function createInferenceRunGuard({ client_name, slug, requestedBy }) {
  const container = getBuildingContainer();
  const partitionKey = pkBuilding(client_name, slug);

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
  const runId = inferenceRunIdForSlug(client_name, slug);

  try {
    const { resource: existing } = await container.item(runId, partitionKey).read();
    if (existing) {
      if (existing.status === "Completed") return { alreadyProcessed: true };
      return { alreadyProcessed: false, projectId: project.id, runId: existing.id };
    }
  } catch (e) {
    if (!(e.statusCode === 404 || e.code === 404)) throw e;
  }

  const guardDoc = buildInferenceRunDoc({ client_name, slug, projectId: project.id, requestedBy });

  try {
    const { resource } = await container.items.create(guardDoc, { partitionKey });
    return { alreadyProcessed: false, projectId: project.id, runId: resource.id };
  } catch (e) {
    if (e.code === 409) {
      const { resource: existing } = await container.item(runId, partitionKey).read();
      if (existing?.status === "Completed") return { alreadyProcessed: true };
      return { alreadyProcessed: false, projectId: project.id, runId };
    }
    throw e;
  }
}

module.exports = { createInferenceRunGuard };
