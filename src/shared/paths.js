// src/shared/paths.js
// Simple helpers to construct blob paths used by the pipeline.
// Keep paths deterministic and minimal.

function editorLatestPath(slug, floorId) {
  if (!slug || !floorId) throw new Error("editorLatestPath requires slug and floorId");
  return `projects/${slug}/editor/${floorId}/latest.json`;
}

function editorHistoryPath(slug, floorId, timestamp) {
  if (!slug || !floorId || !timestamp) throw new Error("editorHistoryPath requires slug, floorId, timestamp");
  // timestamp should be URL-safe, caller replaces ":" and "." with "-" before calling
  return `projects/${slug}/editor/${floorId}/history/${timestamp}.json`;
}

function inferenceRawPath(slug, floorId) {
  if (!slug || !floorId) throw new Error("inferenceRawPath requires slug and floorId");
  // raw outputs per-floor
  return `projects/${slug}/inference/${floorId}/score.raw.json`;
}

module.exports = {
  editorLatestPath,
  editorHistoryPath,
  inferenceRawPath,
};
