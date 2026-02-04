// src/functions/UpdateFloorMetrics.js
const df = require("durable-functions");
const { getBuildingContainer, pkBuilding } = require("../shared/cosmos");

df.app.activity("UpdateFloorMetrics", {
  handler: async (input) => {
    const { client_name, slug, floorId, counts } = input || {};
    if (!client_name || !slug || !floorId || !counts) {
      throw new Error("UpdateFloorMetrics requires { client_name, slug, floorId, counts }");
    }

    const container = getBuildingContainer();
    const partitionKey = pkBuilding(client_name, slug);

    const { resource: floorDoc } = await container.item(floorId, partitionKey).read();
    if (!floorDoc) throw new Error(`Floor doc not found: ${floorId}`);

    floorDoc.metrics = floorDoc.metrics || {};
    floorDoc.metrics.columnsDetected = counts.columnsDetected || 0;
    floorDoc.metrics.beamsDetected = counts.beamsDetected || 0;
    floorDoc.metrics.polygonsDetected = counts.polygonsDetected || 0;
    floorDoc.updatedAt = new Date().toISOString();

    const { resource: saved } = await container.item(floorId, partitionKey).replace(floorDoc);

    return { id: saved.id, metrics: saved.metrics, updatedAt: saved.updatedAt };
  },
});
