// src/functions/HttpStart.js
const { app } = require("@azure/functions");
const df = require("durable-functions");
const { createInferenceRunGuard } = require("../shared/createInferenceRunGuard");

const orchestratorName = "RevealInferenceOrchestrator";

app.http("HttpStart", {
  methods: ["POST"],
  authLevel: "function",

  // ✅ REQUIRED for df.getClient(context) in Node v4
  extraInputs: [df.input.durableClient()],

  handler: async (request, context) => {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const client_name = body.client_name;
    const slug = body.slug;

    if (!client_name || !slug) {
      return {
        status: 400,
        jsonBody: { error: "Missing required fields: client_name, slug" },
      };
    }

    // 1) Create guard doc in Cosmos (permanent one-and-done)
    let guard;
    try {
      guard = await createInferenceRunGuard({
        client_name,
        slug,
        requestedBy: body.requestedBy || null,
      });
    } catch (e) {
      const status = e.statusCode || 500;
      context.log.error("Guard creation failed:", e.message);
      return { status, jsonBody: { error: e.message } };
    }

    if (guard.alreadyProcessed) {
      return {
        status: 409,
        jsonBody: {
          error: "Inference already executed for this project.",
          client_name,
          slug,
        },
      };
    }

    // 2) Start orchestration (use runId as the canonical ID)
    const durableClient = df.getClient(context);
    const instanceId = guard.runId;

    const input = {
      client_name,
      slug,
      projectId: guard.projectId,
      runId: guard.runId,
      requestedBy: body.requestedBy || null,
    };

    const startedInstanceId = await durableClient.startNew(orchestratorName, {
      instanceId,
      input,
    });

    context.log(
      `Started orchestration '${orchestratorName}' with ID='${startedInstanceId}' for ${client_name}/${slug}`
    );

    return durableClient.createCheckStatusResponse(request, startedInstanceId);
  },
});
