// src/functions/WriteEditorLatest.js
const df = require("durable-functions");
const { uploadText } = require("../shared/blobClient");
const { editorLatestPath, editorHistoryPath } = require("../shared/paths");
const { config } = require("../shared/config");

/**
 * Writes updated latest.json and (optionally) a history entry.
 *
 * Input:
 *   {
 *     slug: string,
 *     floorId: string,
 *     latestJson: object
 *   }
 *
 * Output:
 *   {
 *     ok: true,
 *     latestPath: string,
 *     historyPath?: string,
 *     updatedAt: string,
 *     historyWritten?: boolean
 *   }
 *
 * Notes:
 * - latest.json write is the priority; history is best-effort.
 * - Validates slug/floorId to avoid path traversal or accidental slashes.
 */

// Allow toggling history in prod (default: true)
function shouldWriteHistory() {
  const v =
    process.env.WRITE_EDITOR_HISTORY ??
    process.env.EDITOR_WRITE_HISTORY ??
    "true";
  return String(v).toLowerCase() !== "false";
}

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

/**
 * Strict id guard: reject anything that could alter paths.
 * Adjust if you truly need other chars, but do not allow "/" "\" ".." etc.
 */
function assertSafeId(name, value) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const v = value.trim();

  // No slashes, backslashes, or dot-dot traversal
  if (v.includes("/") || v.includes("\\") || v.includes("..")) {
    throw new Error(`${name} contains unsafe path characters`);
  }

  // Keep it fairly permissive but sane (letters, numbers, underscore, dash)
  // If your floorId is UUID, this passes.
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new Error(`${name} contains invalid characters`);
  }

  return v;
}

function ensurePlainObject(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) {
    throw new Error("latestJson must be a JSON object");
  }
  return x;
}

function safeIsoForFilename(iso) {
  // 2026-01-28T14:29:42.653Z -> 2026-01-28T14-29-42-653Z
  return String(iso).replace(/[:.]/g, "-");
}

df.app.activity("WriteEditorLatest", {
  handler: async (input) => {
    const slug = assertSafeId("slug", input?.slug);
    const floorId = assertSafeId("floorId", input?.floorId);
    const latestJson = ensurePlainObject(input?.latestJson);

    const latestPath = editorLatestPath(slug, floorId);
    const now = new Date().toISOString();

    // Ensure we can stringify (and keep it human-readable for debugging)
    let content;
    try {
      content = JSON.stringify(latestJson, null, 2);
    } catch (e) {
      throw new Error("latestJson is not serialisable JSON");
    }

    // 1) Write latest.json (must succeed)
    await uploadText(
      config.blob.containerUploads,
      latestPath,
      content,
      "application/json"
    );

    // 2) Write history (best-effort, configurable)
    let historyPath;
    let historyWritten = false;

    if (shouldWriteHistory()) {
      try {
        const stamp = safeIsoForFilename(now);
        historyPath = editorHistoryPath(slug, floorId, stamp);

        await uploadText(
          config.blob.containerUploads,
          historyPath,
          content,
          "application/json"
        );

        historyWritten = true;
      } catch (e) {
        // Do NOT fail the activity if history fails.
        // Keep logs non-sensitive: no SAS, no payload dump.
        console.warn(
          `[WriteEditorLatest] history write failed slug=${slug} floorId=${floorId}:`,
          e?.message ?? e
        );
      }
    }

    return {
      ok: true,
      latestPath,
      ...(historyPath ? { historyPath } : {}),
      updatedAt: now,
      ...(shouldWriteHistory() ? { historyWritten } : {}),
    };
  },
});
