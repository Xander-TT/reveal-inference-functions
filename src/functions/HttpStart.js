// src/functions/HttpStart.js
const { app } = require("@azure/functions");
const df = require("durable-functions");
const { createInferenceRunGuard } = require("../shared/createInferenceRunGuard");
const { getInferenceRunsContainer, pkBuilding } = require("../shared/cosmos");
const { config } = require("../shared/config");
const { inferenceRunIdForSlug } = require("../shared/inferenceRun");

const orchestratorName = "RevealInferenceOrchestrator";

async function markRunFailed(client_name, slug, runId, errorMessage, context) {
  try {
    const container = getInferenceRunsContainer();
    const partitionKey = pkBuilding(client_name, slug);
    const { resource: doc } = await container.item(runId, partitionKey).read();
    if (!doc) {
      context.log.error(
        `[HttpStart] Cannot mark run failed – doc not found: runId=${runId} client_name=${client_name} slug=${slug}`
      );
      return;
    }
    const now = new Date().toISOString();
    doc.status = "Failed";
    doc.error = String(errorMessage).slice(0, 500); // avoid writing huge traces to Cosmos
    doc.completedAt = now;
    doc.updatedAt = now;
    await container.item(runId, partitionKey).replace(doc);
    context.log(`[HttpStart] Marked inference run as Failed: runId=${runId}`);
  } catch (err) {
    context.log.error(
      `[HttpStart] Failed to mark run as Failed (runId=${runId}): ${err.message}`
    );
  }
}

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

    context.log(
      `[HttpStart] Received request: client_name=${client_name}, slug=${slug}, requestedBy=${body.requestedBy || "(none)"}`
    );
    context.log(
      `[HttpStart] Cosmos database=${config.cosmos.database} ` +
        `inferenceRuns=${config.cosmos.containerInferenceRuns} ` +
        `projects=${config.cosmos.containerProjects} ` +
        `editorDocs=${config.cosmos.containerEditorDocs} ` +
        `editorEvents=${config.cosmos.containerEditorEvents}`
    );

    if (!client_name || !slug) {
      return {
        status: 400,
        jsonBody: { error: "Missing required fields: client_name, slug" },
      };
    }

    // 1) Create / verify guard doc in inference-runs container
    let guard;
    try {
      guard = await createInferenceRunGuard({
        client_name,
        slug,
        requestedBy: body.requestedBy || null,
      });
    } catch (e) {
      const httpStatus = e.statusCode || 500;
      context.log.error(
        `[HttpStart] Guard creation failed for ${client_name}/${slug}: ${e.message}`
      );
      // Attempt to mark existing run as Failed (best-effort; run may not exist yet)
      const runId = inferenceRunIdForSlug(client_name, slug);
      await markRunFailed(client_name, slug, runId, e.message, context);
      return { status: httpStatus, jsonBody: { error: e.message } };
    }

    if (guard.alreadyProcessed) {
      context.log(
        `[HttpStart] Inference already processed for ${client_name}/${slug} – returning 409`
      );
      return {
        status: 409,
        jsonBody: {
          error: "Inference already executed for this project.",
          client_name,
          slug,
        },
      };
    }

    context.log(
      `[HttpStart] Guard OK: runId=${guard.runId}, projectId=${guard.projectId} – starting orchestration`
    );

    // 2) Start orchestration (use runId as the canonical durable instance ID)
    const durableClient = df.getClient(context);
    const instanceId = guard.runId;

    const input = {
      client_name,
      slug,
      projectId: guard.projectId,
      runId: guard.runId,
      requestedBy: body.requestedBy || null,
    };

    let startedInstanceId;
    try {
      startedInstanceId = await durableClient.startNew(orchestratorName, {
        instanceId,
        input,
      });
    } catch (e) {
      context.log.error(
        `[HttpStart] Failed to start orchestration for ${client_name}/${slug}: ${e.message}`
      );
      await markRunFailed(
        client_name,
        slug,
        guard.runId,
        `Orchestration start failed: ${e.message}`,
        context
      );
      return {
        status: 500,
        jsonBody: { error: "Failed to start inference orchestration." },
      };
    }

    context.log(
      `[HttpStart] Orchestration started: orchestrator=${orchestratorName} instanceId=${startedInstanceId} client_name=${client_name} slug=${slug}`
    );

    return durableClient.createCheckStatusResponse(request, startedInstanceId);
  },
});
