const { app } = require("@azure/functions");
const df = require("durable-functions");

const orchestratorName = "RevealInferenceOrchestrator";

app.http("HttpStart", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    const client = df.getClient(context);

    let input = {};
    try {
      input = await request.json();
    } catch {
      input = {};
    }

    const instanceId = await client.startNew(orchestratorName, { input });

    context.log(`Started orchestration '${orchestratorName}' with ID = '${instanceId}'.`);

    return client.createCheckStatusResponse(request, instanceId);
  }
});
