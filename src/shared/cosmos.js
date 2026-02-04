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

function getBuildingContainer() {
  const client = getCosmosClient();
  return client.database(config.cosmos.database).container(config.cosmos.containerBuilding);
}

function getEditorDocsContainer() {
  const client = getCosmosClient();
  return client.database(config.cosmos.database).container(config.cosmos.containerEditorDocs);
}

function getEditorEventsContainer() {
  const client = getCosmosClient();
  return client.database(config.cosmos.database).container(config.cosmos.containerEditorEvents);
}

// Hierarchical PK for building container
function pkBuilding(client_name, slug) {
  return [client_name, slug];
}

// Single PK for editor containers
function pkFloorKey(floorKey) {
  return floorKey;
}

module.exports = {
  getBuildingContainer,
  getEditorDocsContainer,
  getEditorEventsContainer,
  pkBuilding,
  pkFloorKey,
};
