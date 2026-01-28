// src/shared/blobSas.js (UDS-only, production-grade)
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const { config } = require("./config");

async function generateReadSas(containerName, blobPath, ttlSeconds = 300) {
  const cs = config.blob.connectionString || "";
  const matchAccount = /AccountName=([^;]+)/.exec(cs);

  if (!matchAccount) {
    throw new Error(
      "Connection string must include AccountName to generate a User Delegation SAS (UDS). " +
      "Set REVEALBLOB_CONNECTION_STRING to include AccountName."
    );
  }
  const accountName = matchAccount[1];

  // Backdate start time to tolerate clock skew between AML + Storage
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + ttlSeconds * 1000);

  const blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );

  const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobPath);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    },
    userDelegationKey,
    accountName
  ).toString();

  return `${blobClient.url}?${sasToken}`;
}

module.exports = { generateReadSas };
