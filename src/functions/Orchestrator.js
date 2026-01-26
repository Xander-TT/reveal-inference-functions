const df = require("durable-functions");

// Name of the orchestrator function
const orchestratorName = "RevealInferenceOrchestrator";

df.app.orchestration(orchestratorName, function* (context) {
  const input = context.df.getInput() || {};
  // For now just echo input so we can validate plumbing end-to-end.
  return { ok: true, input };
});
