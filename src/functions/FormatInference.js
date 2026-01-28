// src/functions/FormatInference.js
const df = require("durable-functions");
const { formatInferenceIntoEditor } = require("../shared/formatInference");

df.app.activity("FormatInference", {
  handler: async (input) => {
    const { latest, raw, runId, model } = input || {};
    const { updatedLatest, counts } = formatInferenceIntoEditor(latest, raw, { runId, model });
    return { updatedLatest, counts };
  },
});

