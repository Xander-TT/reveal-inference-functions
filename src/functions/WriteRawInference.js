// src/functions/WriteRawInference.js
const df = require("durable-functions");
const { uploadText } = require("../shared/blobClient");
const { inferenceRawPath } = require("../shared/paths");
const { config } = require("../shared/config");

/**
 * Writes the raw AML response JSON to a configurable inference container.
 * Input: { slug, floorId, raw }
 */
df.app.activity("WriteRawInference", {
  handler: async (input) => {
    const { slug, floorId, raw } = input || {};
    if (!slug || !floorId || raw === undefined) {
      throw new Error("WriteRawInference requires { slug, floorId, raw }");
    }

    // Container name is configurable via config.blob.containerInference; fallback to "inference"
    const containerName = (config.blob && config.blob.containerInference) || "inference";

    const path = inferenceRawPath(slug, floorId); // projects/<slug>/inference/<floorId>/score.raw.json
    const content = JSON.stringify(raw, null, 2);

    await uploadText(containerName, path, content, "application/json");

    return { container: containerName, path };
  },
});

