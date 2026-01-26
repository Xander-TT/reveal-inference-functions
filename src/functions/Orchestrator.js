const df = require("durable-functions");

const orchestratorName = "RevealInferenceOrchestrator";

df.app.orchestration(orchestratorName, function* (context) {
  const input = context.df.getInput() || {};
  const { client_name, slug } = input;

  context.df.setCustomStatus({ stage: "starting", client_name, slug });

  try {
    // 1) Discover project + floors
    const { project, floors } = yield context.df.callActivity("GetProjectAndFloors", {
      client_name,
      slug,
    });

    // 2) Set totalFloors
    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Running",
      totalFloors: floors.length,
      processedFloors: 0,
    });

    context.df.setCustomStatus({
      stage: "processing",
      projectId: project.id,
      processed: 0,
      total: floors.length,
    });

    // 3) Sequential loop (no per-floor work yet)
    for (let i = 0; i < floors.length; i++) {
      const floor = floors[i];

      context.df.setCustomStatus({
        stage: "processing",
        floorId: floor.id,
        floorName: floor.name,
        processed: i,
        total: floors.length,
      });

      // For Phase 4, we only record progress; real work starts in Phase 5
      yield context.df.callActivity("UpdateInferenceRunStatus", {
        client_name,
        slug,
        processedFloors: i + 1,
      });
    }

    // 4) Mark completed
    yield context.df.callActivity("UpdateInferenceRunStatus", {
      client_name,
      slug,
      status: "Completed",
    });

    context.df.setCustomStatus({ stage: "completed", processed: floors.length, total: floors.length });

    return { ok: true, project, floorsProcessed: floors.length };
  } catch (e) {
    // Best effort: mark failed
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
