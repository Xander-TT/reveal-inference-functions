// src/shared/blobClient.js
const { BlobServiceClient } = require("@azure/storage-blob");
const { config } = require("./config");

let _client;

function getBlobServiceClient() {
  if (!_client) {
    _client = BlobServiceClient.fromConnectionString(config.blob.connectionString);
  }
  return _client;
}

/**
 * Download blob content as string. Returns empty string if blob doesn't exist.
 */
async function downloadText(containerName, blobPath) {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(containerName);
  const blob = container.getBlobClient(blobPath);

  try {
    const resp = await blob.download();
    const stream = resp.readableStreamBody;
    if (!stream) return "";
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (e) {
    // If not found, return empty (caller can decide)
    if (e.statusCode === 404 || e.status === 404) return "";
    throw e;
  }
}

/**
 * Upload text to blob (creates container if missing).
 */
async function uploadText(containerName, blobPath, content, contentType = "application/json") {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(containerName);
  await container.createIfNotExists();

  const block = container.getBlockBlobClient(blobPath);
  const data = typeof content === "string" ? content : JSON.stringify(content);
  await block.upload(data, Buffer.byteLength(data), {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

module.exports = { downloadText, uploadText };
