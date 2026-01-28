// src/functions/CallAmlInference.js
const df = require("durable-functions");
const { callAml } = require("../shared/amlClient");

/**
 * Calls AML endpoint using the exact contract expected by score.py:
 * - single: { image_url: "..." }
 * - batch:  { images: [{ id, url }] }
 *
 * input: { sasUrl, client_name, slug, floorId, planUrl }
 */
df.app.activity("CallAmlInference", {
  handler: async (input, context) => {
    const { sasUrl, client_name, slug, floorId, planUrl } = input || {};
    if (!sasUrl) throw new Error("CallAmlInference requires { sasUrl }");

    // Match score.py (_normalize_images)
    const payload = {
      image_url: sasUrl,
      // optional metadata - score.py will ignore unknown keys safely
      meta: { client_name, slug, floorId, planUrl },
    };

    return await callAml(payload, context);
  },
});

