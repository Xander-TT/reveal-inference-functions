// src/shared/config.js
function mustGet(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getInt(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer (got: ${v})`);
  return n;
}

const config = Object.freeze({
  cosmos: {
    endpoint: mustGet("COSMOS_ENDPOINT"),
    key: mustGet("COSMOS_KEY"),
    database: mustGet("COSMOS_DATABASE"),
    container: mustGet("COSMOS_CONTAINER"),
  },
  blob: {
    connectionString: mustGet("REVEALBLOB_CONNECTION_STRING"),
    containerUploads: mustGet("REVEALBLOB_CONTAINER"),
    // New: inference outputs container (optional - required in production to be explicit)
    containerInference: process.env.REVEALBLOB_CONTAINER_INFERENCE || "inference",
  },
  aml: {
    endpoint: mustGet("AML_ENDPOINT"),
    apiKey: mustGet("AML_API_KEY"),

    // Optional. If set, adds header "azureml-model-deployment".
    deployment: process.env.AML_DEPLOYMENT || "",

    // Request timeout (ms)
    timeoutMs: getInt("AML_TIMEOUT_MS", 120000),

    // Axios-layer retry knobs (keep low; Durable retry is primary)
    // Total attempts including the first try.
    maxAttempts: getInt("AML_MAX_ATTEMPTS", 1),

    // Backoff controls for axios-layer retries (only used if maxAttempts > 1)
    baseDelayMs: getInt("AML_BASE_DELAY_MS", 1000),
    maxDelayMs: getInt("AML_MAX_DELAY_MS", 15000),
  },
});

module.exports = { config };
