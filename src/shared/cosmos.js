// src/shared/cosmos.js
const { CosmosClient } = require("@azure/cosmos");
const { config } = require("./config");

let _client;

/**
 * Lazy singleton Cosmos client.
 */
function getCosmosClient() {
  if (!_client) {
    _client = new CosmosClient({
      endpoint: config.cosmos.endpoint,
      key: config.cosmos.key,
    });
  }
  return _client;
}

function getContainer() {
  const client = getCosmosClient();
  return client.database(config.cosmos.database).container(config.cosmos.container);
}

/**
 * For hierarchical PK ["client_name","slug"], the JS SDK accepts partition key values as an array.
 */
function pk(client_name, slug) {
  return [client_name, slug];
}

module.exports = { getContainer, pk };
