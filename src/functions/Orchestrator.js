// src/functions/Orchestrator.js
const df = require("durable-functions");

const orchestratorName = "RevealInferenceOrchestrator";

df.app.orchestration(orchestratorName, function* (context) {
  const input = context.df.getInput() || {};
  const { client_name, slug, runId } = input;

  context.df.setCustomStatus({ stage: "starting", client_name, slug });

  let totals = { columnsDetected: 0, beamsDetected: 0, polygonsDetected: 0 };

  const amlRetry = new df.RetryOptions(2000, 4);
  amlRetry.backoffCoefficient = 2;
  amlRetry.maxRetryIntervalInMilliseconds = 30000;
  amlRetry.retryTimeoutInMilliseconds = 5 * 60 * 1000;

  try {
    const { project, floors } = yield context.df.callActivity("GetProjectAndFloors", {
      client_name,
      slug,
    });

    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Processing",
      totalFloors: floors.length,
      processedFloors: 0,
      totals,
    });

    context.df.setCustomStatus({ stage: "processing", total: floors.length, processed: 0 });

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const floorId = floor.id;

      // 1) Download image from Blob Storage and call AML — all inside one activity.
      // base64 never passes through orchestration history.
      const raw = yield context.df.callActivityWithRetry("RunYoloInferenceForFloor", amlRetry, {
        floorId,
        imageBlobPath: floor.planUrl,
        client_name,
        slug,
      });

      // 2) Write raw inference JSON to blob
      yield context.df.callActivity("WriteRawInference", { slug, floorId, raw });

      // 3) Upsert Cosmos editorDoc + write editorEvents (+ optional legacy blob latest.json)
      const upserted = yield context.df.callActivity("UpsertEditorDocFromInference", {
        clientName: client_name, // your editorDoc examples use "AMC"
        projectSlug: slug,
        floorId,
        basemapKey: floor.planUrl,
        width: floor.imageWidth,
        height: floor.imageHeight,
        paperScaleDenominator: floor.paperScaleDenominator,
        legacyEditorStateUrl: floor.editorStateUrl || null,
        raw,
        runId: runId || context.df.instanceId,
        model: raw?.model || null,
      });

      // 4) Update floor metrics in projects container
      yield context.df.callActivity("UpdateFloorMetrics", {
        client_name,
        slug,
        floorId,
        counts: upserted.counts,
      });

      // 5) Accumulate totals
      totals = {
        columnsDetected: (totals.columnsDetected || 0) + (upserted.counts.columnsDetected || 0),
        beamsDetected: (totals.beamsDetected || 0) + (upserted.counts.beamsDetected || 0),
        polygonsDetected: (totals.polygonsDetected || 0) + (upserted.counts.polygonsDetected || 0),
      };

      // 6) Persist run progress & cumulative totals
      yield context.df.callActivity("UpdateInferenceRunStatus", {
        client_name,
        slug,
        processedFloors: i + 1,
        totals,
      });

      context.df.setCustomStatus({
        stage: "processing",
        processed: i + 1,
        total: floors.length,
      });
    }

    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Completed",
      totals,
    });

    context.df.setCustomStatus({
      stage: "completed",
      processed: floors.length,
      total: floors.length,
      totals,
    });

    return { ok: true, projectId: project.id, floorsProcessed: floors.length, totals };
  } catch (e) {
    try {
      yield context.df.callActivity("UpdateInferenceRunStatus", {
        client_name,
        slug,
        status: "Failed",
        error: e.message || String(e),
      });
    } catch (_) {}
    throw e;
  }
});
