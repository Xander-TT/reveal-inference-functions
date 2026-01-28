// src/functions/ReadEditorLatest.js
const df = require("durable-functions");
const { downloadText } = require("../shared/blobClient");
const { editorLatestPath } = require("../shared/paths");
const { config } = require("../shared/config");

/**
 * Reads projects/<slug>/editor/<floorId>/latest.json from the uploads container.
 * Returns parsed JSON.
 */
df.app.activity("ReadEditorLatest", {
  handler: async (input) => {
    const { slug, floorId } = input || {};
    if (!slug || !floorId) throw new Error("ReadEditorLatest requires { slug, floorId }");

    const path = editorLatestPath(slug, floorId);
    const text = await downloadText(config.blob.containerUploads, path);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse latest.json for ${slug}/${floorId}: ${e.message}`);
    }
  },
});
