// src/shared/inferenceRun.js
function inferenceRunIdForSlug(client_name, slug) {
  return `infer::${client_name}::${slug}`;
}

function buildInferenceRunDoc({ client_name, slug, projectId, requestedBy }) {
  const now = new Date().toISOString();

  return {
    id: inferenceRunIdForSlug(client_name, slug),
    docType: "inferenceRun",
    client_name,
    slug,
    projectId,

    status: "Running",

    requestedBy: requestedBy || null,

    startedAt: now,
    completedAt: null,

    totalFloors: null,
    processedFloors: 0,

    totals: {
      columnsDetected: 0,
      beamsDetected: 0,
      polygonsDetected: 0,
    },

    rawOutputsPrefix: `projects/${slug}/inference/`,
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  inferenceRunIdForSlug,
  buildInferenceRunDoc,
};
