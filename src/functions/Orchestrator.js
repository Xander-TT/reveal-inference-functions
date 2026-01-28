// src/functions/Orchestrator.js
const df = require("durable-functions");

const orchestratorName = "RevealInferenceOrchestrator";

df.app.orchestration(orchestratorName, function* (context) {
  const input = context.df.getInput() || {};
  const { client_name, slug, runId } = input;

  context.df.setCustomStatus({ stage: "starting", client_name, slug });

  // Deterministic accumulator (safe in orchestrator)
  let totals = { columnsDetected: 0, beamsDetected: 0, polygonsDetected: 0 };

  try {
    const { project, floors } = yield context.df.callActivity("GetProjectAndFloors", {
      client_name,
      slug,
    });

    // Initialize run status
    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Running",
      totalFloors: floors.length,
      processedFloors: 0,
      totals, // set to zeros
    });

    context.df.setCustomStatus({ stage: "processing", total: floors.length, processed: 0 });

    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];
      const floorId = floor.id;

      // 1) Read editor latest.json
      const latest = yield context.df.callActivity("ReadEditorLatest", { slug, floorId });

      // 2) Generate SAS for the plan image
      const { sasUrl } = yield context.df.callActivity("GenerateSas", {
        blobPath: floor.planUrl,
      });

      // 3) Call AML with SAS
      const raw = yield context.df.callActivity("CallAmlInference", {
        sasUrl,
        client_name,
        slug,
        floorId,
        planUrl: floor.planUrl,
      });

      // 4) Write raw inference JSON to inference container
      yield context.df.callActivity("WriteRawInference", { slug, floorId, raw });

      // 5) Format raw into editor update
      const formatted = yield context.df.callActivity("FormatInference", {
        latest,
        raw,
        runId: runId || context.df.instanceId,
      });
      // formatted => { updatedLatest, counts }

      // 6) Write updated latest.json (+history)
      yield context.df.callActivity("WriteEditorLatest", {
        slug,
        floorId,
        latestJson: formatted.updatedLatest,
      });

      // 7) Update floor metrics in Cosmos
      yield context.df.callActivity("UpdateFloorMetrics", {
        client_name,
        slug,
        floorId,
        counts: formatted.counts,
      });

      // 8) Accumulate totals deterministically
      totals = {
        columnsDetected: (totals.columnsDetected || 0) + (formatted.counts.columnsDetected || 0),
        beamsDetected: (totals.beamsDetected || 0) + (formatted.counts.beamsDetected || 0),
        polygonsDetected:
          (totals.polygonsDetected || 0) + (formatted.counts.polygonsDetected || 0),
      };

      // 9) Persist run progress & cumulative totals
      yield context.df.callActivity("UpdateInferenceRunStatus", {
        client_name,
        slug,
        processedFloors: i + 1,
        totals, // <-- cumulative now
      });

      context.df.setCustomStatus({
        stage: "processing",
        processed: i + 1,
        total: floors.length,
      });
    }

    // Finalize run
    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Completed",
      totals, // persist final totals
    });

    context.df.setCustomStatus({
      stage: "completed",
      processed: floors.length,
      total: floors.length,
      totals,
    });

    return { ok: true, projectId: project.id, floorsProcessed: floors.length, totals };
  } catch (e) {
    // Mark failed, then rethrow
    try {
      yield context.df.callActivity("UpdateInferenceRunStatus", {
        client_name,
        slug,
        status: "Failed",
      });
    } catch (_) {}

    throw e;
  }
});
