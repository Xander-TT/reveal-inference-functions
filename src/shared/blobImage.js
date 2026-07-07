// src/shared/blobImage.js
//
// Downloads a blob from Azure Storage and returns it as a Buffer + base64 string.
// Used by RunYoloInferenceForFloor to fetch floor-plan images before calling AML,
// so AML never needs to reach Storage directly.

const { BlobServiceClient } = require("@azure/storage-blob");
const { config } = require("./config");

let _blobServiceClient;

function getBlobServiceClient() {
  if (!_blobServiceClient) {
    _blobServiceClient = BlobServiceClient.fromConnectionString(config.blob.connectionString);
  }
  return _blobServiceClient;
}

/**
 * Download a blob as a Buffer and derive base64.
 *
 * @param {string} containerName  - Blob container name
 * @param {string} blobPath       - Blob path within the container
 * @param {object} [context]      - Azure Functions context (for logging)
 * @returns {{ buffer: Buffer, base64: string, contentType: string, byteLength: number, blobPath: string }}
 */
async function downloadBlobImage(containerName, blobPath, context) {
  if (!containerName) throw new Error("downloadBlobImage requires containerName");
  if (!blobPath) throw new Error("downloadBlobImage requires blobPath");

  const startMs = Date.now();
  context?.log?.(
    `[blobImage] Downloading: container=${containerName} path=${blobPath}`
  );

  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobPath);

  let downloadResponse;
  try {
    downloadResponse = await blobClient.download();
  } catch (e) {
    const httpStatus = e.statusCode ?? e.status;
    throw new Error(
      `[blobImage] Blob download failed ` +
        `(container=${containerName} path=${blobPath}` +
        (httpStatus ? ` status=${httpStatus}` : "") +
        `): ${e.message}`
    );
  }

  const contentType = downloadResponse.contentType || "application/octet-stream";

  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const buffer = Buffer.concat(chunks);
  const base64 = buffer.toString("base64");
  const elapsedMs = Date.now() - startMs;

  context?.log?.(
    `[blobImage] Download complete: container=${containerName} path=${blobPath} ` +
      `bytes=${buffer.byteLength} contentType=${contentType} elapsed=${elapsedMs}ms`
  );

  if (buffer.byteLength === 0) {
    throw new Error(
      `[blobImage] Blob is empty (container=${containerName} path=${blobPath})`
    );
  }

  return {
    buffer,
    base64,
    contentType,
    byteLength: buffer.byteLength,
    blobPath,
  };
}

module.exports = { downloadBlobImage };
