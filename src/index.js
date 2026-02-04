// src/index.js
require("./functions/HttpStart");
require("./functions/Orchestrator");
require("./functions/GetProjectAndFloors");
require("./functions/UpdateInferenceRunStatus");

require("./functions/GenerateSas");
require("./functions/CallAmlInference");

require("./functions/WriteRawInference");
require("./functions/UpsertEditorDocFromInference");
require("./functions/UpdateFloorMetrics");
