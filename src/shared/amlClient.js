// src/shared/amlClient.js
const axios = require("axios");
const { config } = require("./config");

/**
 * Call AML endpoint. Expects JSON payload and returns parsed JSON.
 * Throws on non-2xx.
 */
async function callAml(payload, context) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.aml.apiKey}`,
  };

  if (config.aml.deployment) {
    headers["azureml-model-deployment"] = config.aml.deployment;
  }

  const timeout = config.aml.timeoutMs || 120000;

  try {
    const res = await axios.post(config.aml.endpoint, payload, { headers, timeout });
    return res.data;
  } catch (err) {
    // Attach more info for logs
    const details = err?.response?.data ?? err.message;
    if (context && context.log && typeof context.log.error === "function") {
      context.log.error("AML call failed:", details);
    }
    // Re-throw to let durable activity handle retries/mark failed
    throw err;
  }
}

module.exports = { callAml };
