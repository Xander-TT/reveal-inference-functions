// src/shared/formatInference.js
/**
 * Production-grade formatter:
 * Raw AML -> EditorState-compatible patch + detection counts.
 *
 * Supports AML shapes like:
 *  raw = { ok: true, results: [ { detections: [{cls, score, box:[x1,y1,x2,y2]}], image_size:{w,h} } ] }
 *
 * Class mapping (per user):
 *   0: column
 *   1: staircase-opening
 *   2: floor-plate-opening
 *
 * Output:
 *   { updatedLatest, counts }
 */

const CLASS_LABELS = {
  0: "column",
  1: "staircase-opening",
  2: "floor-plate-opening",
};

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj ?? {}));
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function asNumber(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function bboxFromXYXY(box, score, label) {
  // box = [x1,y1,x2,y2]
  const x1 = asNumber(box?.[0]) ?? 0;
  const y1 = asNumber(box?.[1]) ?? 0;
  const x2 = asNumber(box?.[2]) ?? 0;
  const y2 = asNumber(box?.[3]) ?? 0;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  const out = { x, y, w, h };
  if (typeof score === "number") out.score = score;
  if (typeof label === "string") out.label = label;
  return out;
}

function centerOfBBox(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function rectPointsFromBBox(b) {
  // Editor polygons are Vec2 points, min 3. We use rectangle corners.
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

/**
 * Replace non-userEdited items with new machine items.
 * Preserve userEdited items (manual corrections).
 */
function mergeKeepingUserEdited(existing, machine) {
  const keep = ensureArray(existing).filter((x) => isPlainObject(x) && x.userEdited === true);
  return [...keep, ...machine];
}

function extractDetections(raw) {
  // Most robust: flatten all results[].detections
  const results = ensureArray(raw?.results);
  const dets = [];
  for (const r of results) {
    for (const d of ensureArray(r?.detections)) dets.push(d);
  }

  // Fallback: raw.detections if ever returned
  if (dets.length === 0) {
    for (const d of ensureArray(raw?.detections)) dets.push(d);
  }

  return dets;
}

function pickImageSize(raw) {
  const r0 = ensureArray(raw?.results)?.[0];
  const w = asNumber(r0?.image_size?.w) ?? asNumber(raw?.image_size?.w);
  const h = asNumber(r0?.image_size?.h) ?? asNumber(raw?.image_size?.h);
  return { w, h };
}

function formatInferenceIntoEditor(latestJson = {}, raw = {}, { runId, model } = {}) {
  const updated = deepClone(latestJson);

  // Ensure minimum EditorState shape (don’t assume upstream)
  updated.schemaVersion = Number(updated.schemaVersion) || 1;
  updated.mode = updated.mode || "columns";
  updated.basemaps = ensureArray(updated.basemaps);
  updated.activeBasemap = Number.isFinite(updated.activeBasemap) ? updated.activeBasemap : 0;

  updated.columns = ensureArray(updated.columns);
  updated.beams = ensureArray(updated.beams);
  updated.polygons = ensureArray(updated.polygons);
  updated.comments = ensureArray(updated.comments);
  updated.meta = isPlainObject(updated.meta) ? updated.meta : {};

  const now = new Date().toISOString();

  const dets = extractDetections(raw);
  const { w: imgW, h: imgH } = pickImageSize(raw);

  // ---- Build machine outputs from detections ----
  const machineColumns = [];
  const machineOpenings = [];

  for (let i = 0; i < dets.length; i++) {
    const d = dets[i] || {};
    const cls = asNumber(d.cls);
    const score = typeof d.score === "number" ? d.score : asNumber(d.score);
    const label = CLASS_LABELS[cls] ?? (cls != null ? `cls_${cls}` : "unknown");
    const box = d.box;

    // Defensive: ignore malformed boxes
    if (!Array.isArray(box) || box.length < 4) continue;

    const bbox = bboxFromXYXY(box, score, label);

    // Optional clamp to image bounds if known
    if (typeof imgW === "number" && typeof imgH === "number") {
      bbox.x = clamp(bbox.x, 0, imgW);
      bbox.y = clamp(bbox.y, 0, imgH);
      bbox.w = clamp(bbox.w, 0, imgW);
      bbox.h = clamp(bbox.h, 0, imgH);
    }

    if (cls === 0) {
      // Columns: mapped to EditorState Column schema (x,y,size,sourceBBox)
      const c = centerOfBBox(bbox);
      const size = clamp(Math.max(bbox.w, bbox.h), 8, 60);
      machineColumns.push({
        id: `ml_col_${i}`,
        x: c.x,
        y: c.y,
        size,
        userEdited: false,
        sourceBBox: bbox,
      });
    } else if (cls === 1 || cls === 2) {
      // Openings: map to polygons.kind="opening"
      // Use bbox rectangle as a conservative polygon.
      machineOpenings.push({
        id: `ml_opening_${cls}_${i}`,
        kind: "opening",
        points: rectPointsFromBBox(bbox),
        userEdited: false,
        sourceMaskId: undefined,
      });
    } else {
      // Unknown class: ignore for now but keep trace via meta counts/keys
      continue;
    }
  }

  // ---- Counts (detected by model only) ----
  const counts = {
    columnsDetected: machineColumns.length,
    beamsDetected: 0, // beams come from separate function, so keep 0 here
    polygonsDetected: machineOpenings.length,
  };

  // ---- Merge into latest, preserving user edits ----
  updated.columns = mergeKeepingUserEdited(updated.columns, machineColumns);

  // Beams untouched here (separate pipeline)
  updated.beams = ensureArray(updated.beams);

  // Polygons: preserve user-edited floorplate/openings, replace machine openings
  // Keep userEdited polygons, then append machine openings
  updated.polygons = mergeKeepingUserEdited(updated.polygons, machineOpenings);

  // ---- Meta: inference provenance ----
  updated.meta.inference = {
    runId: runId || null,
    model: model || null,
    timestamp: now,
    classLabels: CLASS_LABELS,
    counts,
    rawSummary: {
      keys: Object.keys(raw || {}).slice(0, 25),
      resultsCount: ensureArray(raw?.results).length,
      detectionsCount: dets.length,
    },
  };

  return { updatedLatest: updated, counts };
}

module.exports = { formatInferenceIntoEditor };
