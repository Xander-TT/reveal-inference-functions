// src/shared/editorIds.js

function createEventId(floorKey, timestampMs) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt::${floorKey}::${timestampMs}::${rand}`;
}

function createEditorDocId(floorKey) {
  return `editor::${floorKey}`;
}

function createFloorKey(clientName, projectSlug, floorId) {
  return `${clientName}:${projectSlug}:${floorId}`;
}

module.exports = {
  createEventId,
  createEditorDocId,
  createFloorKey,
};
