// src/shared/amlClient.js
const axios = require("axios");
const { config } = require("./config");

/**
 * Small async sleep helper (OK inside an Activity function).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide if an error is retryable.
 * We retry on:
 * - network errors / timeouts
 * - 408 (Request Timeout)
 * - 429 (Too Many Requests)
 * - 5xx (server errors / gateway timeouts)
 */
function isRetryableAmlError(err) {
  const status = err?.response?.status;
  const code = err?.code;

  // Axios timeout / network issues
  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }

  // If we got an HTTP response, decide by status code
  if (typeof status === "number") {
    if (status === 408) return true;
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false; // e.g. 400/401/403/404 -> don't retry
  }

  // No status and no known code: treat as retryable once or twice
  // (rare, but helps with transient socket errors)
  return true;
}

/**
 * Compute exponential backoff with jitter.
 */
function computeDelayMs(attemptIndex, baseDelayMs, maxDelayMs) {
  // attemptIndex: 0 for first retry, 1 for second retry, ...
  const exp = Math.min(10, attemptIndex); // cap exponent growth
  const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp));

  // jitter: +/- 20%
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.floor(raw + jitter));
}

/**
 * Call AML endpoint. Expects JSON payload and returns parsed JSON.
 * Throws on non-2xx after retries.
 *
 * Config knobs (optional, via config.aml):
 * - timeoutMs: request timeout (default 120000)
 * - maxAttempts: total attempts including first (default 4)
 * - baseDelayMs: initial retry delay (default 1000)
 * - maxDelayMs: cap for retry delay (default 15000)
 */
async function callAml(payload, context) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.aml.apiKey}`,
  };

  if (config.aml.deployment) {
    headers["azureml-model-deployment"] = config.aml.deployment;
  }

  const endpoint = config.aml.endpoint;
  if (!endpoint) {
    throw new Error("AML endpoint is not configured (config.aml.endpoint missing).");
  }
  if (!config.aml.apiKey) {
    throw new Error("AML apiKey is not configured (config.aml.apiKey missing).");
  }

  const timeout = config.aml.timeoutMs;
  const maxAttempts = config.aml.maxAttempts;   // should default to 1 in config.js
  const baseDelayMs = config.aml.baseDelayMs;
  const maxDelayMs = config.aml.maxDelayMs;


  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();

    try {
      if (context?.log?.info) {
        context.log.info(
          `AML call attempt ${attempt}/${maxAttempts} (timeout=${timeout}ms)`
        );
      }

      const res = await axios.post(endpoint, payload, {
        headers,
        timeout,
        // Keep default validateStatus (non-2xx throws) so we handle retryable statuses
      });

      const ms = Date.now() - started;
      if (context?.log?.info) {
        context.log.info(`AML call succeeded (attempt ${attempt}) in ${ms}ms`);
      }

      return res.data;
    } catch (err) {
      lastErr = err;

      const ms = Date.now() - started;
      const status = err?.response?.status;
      const code = err?.code;
      const retryable = isRetryableAmlError(err);

      // Log a compact failure summary (do NOT dump SAS URLs / secrets)
      const detail =
        err?.response?.data ??
        err?.message ??
        (status ? `HTTP ${status}` : "Unknown AML error");

      if (context?.log?.warn) {
        context.log.warn(
          `AML call failed (attempt ${attempt}/${maxAttempts}) after ${ms}ms` +
            (status ? ` status=${status}` : "") +
            (code ? ` code=${code}` : "") +
            ` retryable=${retryable}`
        );
      }
      if (context?.log?.warn) {
        // keep this short; detail may contain structured JSON
        context.log.warn("AML error detail:", detail);
      }

      // If not retryable, fail fast
      if (!retryable) throw err;

      // If we've exhausted attempts, rethrow
      if (attempt === maxAttempts) throw err;

      // Backoff then retry
      const delay = computeDelayMs(attempt - 1, baseDelayMs, maxDelayMs);
      if (context?.log?.info) {
        context.log.info(`Retrying AML in ${delay}ms...`);
      }
      await sleep(delay);
    }
  }

  // Should never get here, but just in case:
  throw lastErr || new Error("AML call failed.");
}

module.exports = { callAml };
