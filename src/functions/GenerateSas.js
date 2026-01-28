// src/functions/GenerateSas.js
const df = require("durable-functions");
const { generateReadSas } = require("../shared/blobSas");
const { config } = require("../shared/config");

df.app.activity("GenerateSas", {
  handler: async (input, context) => {
    const { container = config.blob.containerUploads, blobPath, ttlSeconds } = input || {};
    if (!blobPath) throw new Error("GenerateSas requires { blobPath }");

    const sas = await generateReadSas(container, blobPath, ttlSeconds || 300);

    // Helpful log while testing locally; logs truncated SAS to avoid spamming secrets in logs.
    if (context && context.log && typeof context.log.info === "function") {
      const safe = sas.length > 160 ? sas.slice(0, 120) + "..." + sas.slice(-40) : sas;
      context.log.info("Generated SAS (truncated):", safe);
    }

    return { sasUrl: sas };
  },
});
