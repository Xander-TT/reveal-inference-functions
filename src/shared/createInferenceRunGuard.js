// src/shared/createInferenceRunGuard.js
const { getProjectsContainer, getInferenceRunsContainer, pkBuilding } = require("./cosmos");
const { buildInferenceRunDoc, inferenceRunIdForSlug } = require("./inferenceRun");

async function createInferenceRunGuard({ client_name, slug, requestedBy }) {
  const projectsContainer = getProjectsContainer();
  const inferenceRunsContainer = getInferenceRunsContainer();
  const partitionKey = pkBuilding(client_name, slug);

  // 1) Look up the project in the projects container
  const projectQuery = {
    query:
      "SELECT TOP 1 * FROM c WHERE c.docType = 'project' AND c.client_name = @client_name AND c.slug = @slug",
    parameters: [
      { name: "@client_name", value: client_name },
      { name: "@slug", value: slug },
    ],
  };

  const { resources: projects } = await projectsContainer.items
    .query(projectQuery, { partitionKey })
    .fetchAll();

  if (!projects || projects.length === 0) {
    const err = new Error(`Project not found for client_name='${client_name}', slug='${slug}'`);
    err.statusCode = 404;
    throw err;
  }

  const project = projects[0];
  const runId = inferenceRunIdForSlug(client_name, slug);

  // 2) Check for an existing inference run in the inference-runs container
  try {
    const { resource: existing } = await inferenceRunsContainer.item(runId, partitionKey).read();
    if (existing) {
      if (existing.status === "Completed") return { alreadyProcessed: true };

      // Transition any non-terminal run (e.g. "Queued" created by the API) to "Processing"
      // so the doc reflects that the Function has taken ownership, regardless of what happens next.
      if (existing.status !== "Processing") {
        const now = new Date().toISOString();
        existing.status = "Processing";
        existing.updatedAt = now;
        try {
          await inferenceRunsContainer.item(runId, partitionKey).replace(existing);
        } catch (_) {
          // Best-effort — proceed even if this write fails; the Orchestrator will also write Processing.
        }
      }

      return { alreadyProcessed: false, projectId: project.id, runId: existing.id };
    }
  } catch (e) {
    if (!(e.statusCode === 404 || e.code === 404)) throw e;
  }

  // 3) Create a new inference run doc in the inference-runs container
  const guardDoc = buildInferenceRunDoc({ client_name, slug, projectId: project.id, requestedBy });

  try {
    const { resource } = await inferenceRunsContainer.items.create(guardDoc, { partitionKey });
    return { alreadyProcessed: false, projectId: project.id, runId: resource.id };
  } catch (e) {
    if (e.code === 409) {
      const { resource: existing } = await inferenceRunsContainer.item(runId, partitionKey).read();
      if (existing?.status === "Completed") return { alreadyProcessed: true };
      return { alreadyProcessed: false, projectId: project.id, runId };
    }
    throw e;
  }
}

module.exports = { createInferenceRunGuard };
