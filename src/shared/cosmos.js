// src/shared/cosmos.js
const { CosmosClient } = require("@azure/cosmos");
const { config } = require("./config");

let _client;

function getCosmosClient() {
  if (!_client) {
    _client = new CosmosClient({
      endpoint: config.cosmos.endpoint,
      key: config.cosmos.key,
    });
  }
  return _client;
}

function getDatabase() {
  return getCosmosClient().database(config.cosmos.database);
}

function getInferenceRunsContainer() {
  return getDatabase().container(config.cosmos.containerInferenceRuns);
}

function getProjectsContainer() {
  return getDatabase().container(config.cosmos.containerProjects);
}

function getEditorDocsContainer() {
  return getDatabase().container(config.cosmos.containerEditorDocs);
}

function getEditorEventsContainer() {
  return getDatabase().container(config.cosmos.containerEditorEvents);
}

// Hierarchical PK for projects / inference-runs containers: [client_name, slug]
function pkBuilding(client_name, slug) {
  return [client_name, slug];
}

// Single PK for editor containers
function pkFloorKey(floorKey) {
  return floorKey;
}

module.exports = {
  getInferenceRunsContainer,
  getProjectsContainer,
  getEditorDocsContainer,
  getEditorEventsContainer,
  pkBuilding,
  pkFloorKey,
};

