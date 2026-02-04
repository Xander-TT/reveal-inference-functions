// src/functions/UpsertEditorDocFromInference.js
const df = require("durable-functions");
const { getEditorDocsContainer, getEditorEventsContainer, pkFloorKey } = require("../shared/cosmos");
const { buildMlFeaturesFromAml } = require("../shared/formatAmlToEditorFeatures");
const { createEventId, createEditorDocId, createFloorKey } = require("../shared/editorIds");
const { uploadText } = require("../shared/blobClient");
const { editorLatestPath, editorHistoryPath } = require("../shared/paths");
const { config } = require("../shared/config");

const PRODUCED_TYPES = new Set(["column", "staircaseOpening", "floorPlateOpening"]);

function systemActor() {
  return { userId: "system", email: "system@reveal", displayName: "Reveal Inference" };
}

function safeIsoForFilename(iso) {
  return String(iso).replace(/[:.]/g, "-");
}

function shouldWriteLegacyBlob() {
  const v = process.env.WRITE_LEGACY_EDITOR_JSON || "false";
  return String(v).toLowerCase() === "true";
}

function createEditorDoc({
  clientName,
  projectSlug,
  floorId,
  basemapKey,
  width,
  height,
  paperScaleDenominator,
  legacyEditorStateUrl,
}) {
  const now = new Date().toISOString();
  const actor = systemActor();
  const floorKey = createFloorKey(clientName, projectSlug, floorId);

  const transform =
    typeof paperScaleDenominator === "number" && paperScaleDenominator > 0
      ? { mode: "declared", declared: { scaleDenominator: paperScaleDenominator } }
      : { mode: "unknown" };

  return {
    id: createEditorDocId(floorKey),
    schemaVersion: 1,

    clientName,
    projectSlug,
    floorId,
    floorKey,

    basemap: {
      key: basemapKey,
      width,
      height,
    },

    transform,
    features: {},
    meta: legacyEditorStateUrl
      ? { legacy: { editorStateUrl: legacyEditorStateUrl } }
      : {},

    revision: 0,
    updatedAt: now,
    updatedBy: actor,
  };
}

async function readOrCreateEditorDoc(input) {
  const {
    clientName,
    projectSlug,
    floorId,
    basemapKey,
    width,
    height,
    paperScaleDenominator,
    legacyEditorStateUrl,
  } = input;

  const floorKey = createFloorKey(clientName, projectSlug, floorId);
  const id = createEditorDocId(floorKey);

  const docs = getEditorDocsContainer();
  const pk = pkFloorKey(floorKey);

  try {
    const { resource, etag } = await docs.item(id, pk).read();
    if (resource) return { doc: resource, etag, created: false };
  } catch (e) {
    if (!(e.code === 404 || e.statusCode === 404)) throw e;
  }

  if (!basemapKey || !width || !height) {
    throw new Error(`EditorDoc missing and cannot init (floorKey=${floorKey}) - basemapKey/width/height required`);
  }

  const doc = createEditorDoc({
    clientName,
    projectSlug,
    floorId,
    basemapKey,
    width,
    height,
    paperScaleDenominator,
    legacyEditorStateUrl,
  });

  await docs.items.create(doc, { partitionKey: pk });

  const { resource: reread, etag } = await docs.item(id, pk).read();
  return { doc: reread || doc, etag, created: true };
}

function mergeMlIntoDoc(doc, mlFeatures, { runId, model }) {
  const now = new Date().toISOString();
  const actor = systemActor();

  // Remove old ML features of produced types
  const nextFeatures = {};
  for (const [id, f] of Object.entries(doc.features || {})) {
    const isMl = f?.source === "ml";
    const isProduced = PRODUCED_TYPES.has(f?.type);
    if (isMl && isProduced) continue;
    nextFeatures[id] = f;
  }

  // Add new ML features
  for (const f of mlFeatures) nextFeatures[f.id] = f;

  const prevInference = doc?.meta?.inference || {};

  return {
    ...doc,
    features: nextFeatures,
    meta: {
      ...(doc.meta || {}),
      inference: {
        ...prevInference,
        lastRunId: runId,
        model: model || prevInference.model,
        runAt: now,
        source: "aml",
      },
    },
    // inference should NOT bump revision
    updatedAt: now,
    updatedBy: actor,
  };
}

async function writeEditorEvents({ floorKey, docBefore, docAfter, runId, counts, created }) {
  const events = getEditorEventsContainer();
  const pk = pkFloorKey(floorKey);

  const nowIso = new Date().toISOString();
  const actor = systemActor();
  const tsMs = Date.now();

  // If created, emit doc.init first (audit only)
  if (created) {
    await events.items.create(
      {
        id: createEventId(floorKey, tsMs),
        clientName: docAfter.clientName,
        projectSlug: docAfter.projectSlug,
        floorId: docAfter.floorId,
        floorKey,
        type: "doc.init",
        actor,
        timestamp: nowIso,
        payload: {},
        docRevisionBefore: undefined,
        docRevisionAfter: docAfter.revision,
      },
      { partitionKey: pk }
    );
  }

  // Emit ml.importFeatures
  await events.items.create(
    {
      id: createEventId(floorKey, tsMs + 1),
      clientName: docAfter.clientName,
      projectSlug: docAfter.projectSlug,
      floorId: docAfter.floorId,
      floorKey,
      type: "ml.importFeatures",
      actor,
      timestamp: nowIso,
      payload: {
        runId,
        counts,
      },
      docRevisionBefore: docBefore?.revision,
      docRevisionAfter: docAfter.revision,
      runId,
    },
    { partitionKey: pk }
  );
}

async function writeLegacyEditorJson({ projectSlug, floorId, doc, counts, runId }) {
  // This writes something compatible-ish with your old latest.json contract
  // so anything still depending on it doesn’t explode.
  // It is intentionally minimal and only covers the ML outputs (columns + openings).
  const now = new Date().toISOString();

  const columns = [];
  const polygons = [];

  for (const f of Object.values(doc.features || {})) {
    if (f?.source !== "ml") continue;

    if (f.type === "column" && f.geometry?.kind === "point") {
      columns.push({
        id: f.id,
        x: f.geometry.position.x,
        y: f.geometry.position.y,
        size: 60,
        userEdited: false,
        sourceBBox: f.ml?.sourceBBox,
      });
    }

    if (
      (f.type === "staircaseOpening" || f.type === "floorPlateOpening") &&
      f.geometry?.kind === "polygon"
    ) {
      polygons.push({
        id: f.id,
        kind: "opening",
        points: f.geometry.points,
        userEdited: false,
      });
    }
  }

  const legacy = {
    schemaVersion: 1,
    mode: "columns",
    basemaps: [
      {
        id: "bm1",
        url: "",
        width: doc.basemap.width,
        height: doc.basemap.height,
      },
    ],
    activeBasemap: 0,
    columns,
    beams: [],
    polygons,
    meta: {
      inference: {
        runId,
        model: doc?.meta?.inference?.model || null,
        timestamp: now,
        classLabels: {
          0: "column",
          1: "staircase-opening",
          2: "floor-plate-opening",
        },
        counts,
        rawSummary: {},
      },
    },
    comments: [],
  };

  const latestPath = editorLatestPath(projectSlug, floorId);
  const content = JSON.stringify(legacy, null, 2);

  await uploadText(config.blob.containerUploads, latestPath, content, "application/json");

  // history best-effort
  try {
    const stamp = safeIsoForFilename(now);
    const historyPath = editorHistoryPath(projectSlug, floorId, stamp);
    await uploadText(config.blob.containerUploads, historyPath, content, "application/json");
  } catch {
    // ignore
  }
}

df.app.activity("UpsertEditorDocFromInference", {
  handler: async (input, context) => {
    const {
      clientName,
      projectSlug,
      floorId,
      basemapKey,
      width,
      height,
      paperScaleDenominator,
      legacyEditorStateUrl,
      raw,
      runId,
      model,
    } = input || {};

    if (!clientName || !projectSlug || !floorId || !raw || !runId) {
      throw new Error("UpsertEditorDocFromInference requires { clientName, projectSlug, floorId, raw, runId }");
    }

    const floorKey = createFloorKey(clientName, projectSlug, floorId);

    // 1) Read or create editor doc
    const { doc: current, etag: currentEtag, created } = await readOrCreateEditorDoc({
      clientName,
      projectSlug,
      floorId,
      basemapKey,
      width,
      height,
      paperScaleDenominator,
      legacyEditorStateUrl,
    });

    // 2) Build ML features from AML
    const { features: mlFeatures, counts } = buildMlFeaturesFromAml(raw, { runId, model });

    // 3) Optimistic concurrency loop (handles concurrent user edits)
    const docs = getEditorDocsContainer();
    const pk = pkFloorKey(floorKey);

    let attempts = 0;
    let docBefore = current;
    let etag = currentEtag;

    while (attempts < 4) {
      attempts++;

      const nextDoc = mergeMlIntoDoc(docBefore, mlFeatures, { runId, model });

      try {
        const options = etag
          ? { accessCondition: { type: "IfMatch", condition: etag } }
          : undefined;

        const { resource: saved } = await docs.item(nextDoc.id, pk).replace(nextDoc, options);

        // re-read for new etag
        const { etag: newEtag } = await docs.item(nextDoc.id, pk).read();

        // 4) Write events (doc.init if created, then ml.importFeatures)
        await writeEditorEvents({
          floorKey,
          docBefore,
          docAfter: saved,
          runId,
          counts,
          created,
        });

        // 5) Optional legacy blob output (compat)
        if (shouldWriteLegacyBlob()) {
          await writeLegacyEditorJson({ projectSlug, floorId, doc: saved, counts, runId });
        }

        return {
          ok: true,
          floorKey,
          editorDocId: saved.id,
          counts,
          etag: newEtag,
          attempts,
        };
      } catch (e) {
        // 412 = precondition failed (etag mismatch)
        const status = e.code || e.statusCode;
        if (status === 412 || status === 409) {
          // re-read latest and retry
          const { resource: latest, etag: latestEtag } = await docs.item(docBefore.id, pk).read();
          docBefore = latest || docBefore;
          etag = latestEtag || etag;

          if (context?.log?.warn) {
            context.log.warn(
              `UpsertEditorDocFromInference concurrency retry ${attempts}/4 floorKey=${floorKey}`
            );
          }
          continue;
        }
        throw e;
      }
    }

    throw new Error(`UpsertEditorDocFromInference failed after retries floorKey=${floorKey}`);
  },
});
