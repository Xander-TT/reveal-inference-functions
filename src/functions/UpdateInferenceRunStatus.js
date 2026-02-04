// src/functions/UpdateInferenceRunStatus.js
const df = require("durable-functions");
const { getBuildingContainer, pkBuilding } = require("../shared/cosmos");

function runId(client_name, slug) {
  return `infer::${client_name}::${slug}`;
}

const TERMINAL = new Set(["Completed", "Failed"]);
const VALID = new Set(["Running", "Completed", "Failed"]);

df.app.activity("UpdateInferenceRunStatus", {
  handler: async (input) => {
    const { client_name, slug, status, totalFloors, processedFloors, totals } = input || {};
    if (!client_name || !slug) {
      throw new Error("UpdateInferenceRunStatus requires { client_name, slug, ... }");
    }
    if (status && !VALID.has(status)) {
      throw new Error(`Invalid status '${status}'. Allowed: Running, Completed, Failed`);
    }

    const container = getBuildingContainer();
    const id = runId(client_name, slug);
    const partitionKey = pkBuilding(client_name, slug);

    const { resource: doc } = await container.item(id, partitionKey).read();
    if (!doc) {
      throw new Error(`inferenceRun not found (id='${id}', client_name='${client_name}', slug='${slug}')`);
    }

    const now = new Date().toISOString();

    if (typeof totalFloors === "number") doc.totalFloors = totalFloors;
    if (typeof processedFloors === "number") doc.processedFloors = processedFloors;
    if (totals && typeof totals === "object") doc.totals = { ...doc.totals, ...totals };
    if (status) doc.status = status;

    doc.updatedAt = now;
    if (status && TERMINAL.has(status) && !doc.completedAt) doc.completedAt = now;

    const { resource: saved } = await container.item(id, partitionKey).replace(doc);

    return {
      id: saved.id,
      docType: saved.docType,
      client_name: saved.client_name,
      slug: saved.slug,
      projectId: saved.projectId,
      status: saved.status,
      startedAt: saved.startedAt,
      completedAt: saved.completedAt,
      totalFloors: saved.totalFloors,
      processedFloors: saved.processedFloors,
      totals: saved.totals,
      updatedAt: saved.updatedAt,
    };
  },
});
