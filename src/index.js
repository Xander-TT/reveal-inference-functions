require("./functions/HttpStart");
require("./functions/Orchestrator");
require("./functions/GetProjectAndFloors");
require("./functions/UpdateInferenceRunStatus");

// Phase 5 activities
require("./functions/GenerateSas");
require("./functions/ReadEditorLatest");
require("./functions/CallAmlInference");

require("./functions/WriteRawInference");
require("./functions/FormatInference");
require("./functions/WriteEditorLatest");
require("./functions/UpdateFloorMetrics");