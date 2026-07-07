// src/functions/RunYoloInferenceForFloor.js
//
// Single activity that:
//   1. Downloads the floor-plan image from Azure Blob Storage
//   2. Base64-encodes it
//   3. Sends it directly to the AML YOLO endpoint
//   4. Returns the compact AML result
//
// The base64 payload is constructed and consumed entirely within this activity.
// It is never returned to the Orchestrator, so it never enters Durable Functions
// history state — avoiding orchestration payload bloat.
//
// AML request schema (image_base64 variant):
//   { image_base64: "<base64 string>", meta: { client_name, slug, floorId, imageBlobPath } }
//
// NOTE: The AML scoring script (score.py) must be updated to handle the
// `image_base64` field in its _normalize_images / run() function.
// The old `image_url` field should no longer be sent — AML must not call Storage.

const df = require("durable-functions");
const { downloadBlobImage } = require("../shared/blobImage");
const { callAml } = require("../shared/amlClient");
const { config } = require("../shared/config");

df.app.activity("RunYoloInferenceForFloor", {
  handler: async (input, context) => {
    const { floorId, imageBlobPath, client_name, slug } = input || {};

    if (!floorId) throw new Error("RunYoloInferenceForFloor requires { floorId }");
    if (!imageBlobPath) throw new Error("RunYoloInferenceForFloor requires { imageBlobPath }");
    if (!client_name) throw new Error("RunYoloInferenceForFloor requires { client_name }");
    if (!slug) throw new Error("RunYoloInferenceForFloor requires { slug }");

    context.log(
      `[RunYoloInferenceForFloor] Starting: floorId=${floorId} ` +
        `container=${config.blob.containerUploads} path=${imageBlobPath}`
    );

    // ── 1. Download image from Blob Storage ──────────────────────────────────
    const image = await downloadBlobImage(
      config.blob.containerUploads,
      imageBlobPath,
      context
    );

    context.log(
      `[RunYoloInferenceForFloor] Image ready: floorId=${floorId} ` +
        `bytes=${image.byteLength} contentType=${image.contentType}`
    );

    // ── 2. Build AML payload ──────────────────────────────────────────────────
    // base64 is scoped here — not returned, never written to orchestration history.
    const payload = {
      image_base64: image.base64,
      meta: { client_name, slug, floorId, imageBlobPath },
    };

    context.log(
      `[RunYoloInferenceForFloor] Calling AML: floorId=${floorId} ` +
        `payloadBytes≈${Math.round((image.byteLength * 4) / 3)} endpoint=${config.aml.endpoint}`
    );

    // ── 3. Call AML ───────────────────────────────────────────────────────────
    const result = await callAml(payload, context);

    context.log(
      `[RunYoloInferenceForFloor] AML returned: floorId=${floorId} ` +
        `resultKeys=${Object.keys(result || {}).join(",")}`
    );

    // base64 is NOT included in the return value
    return result;
  },
});
