// src/shared/formatAmlToEditorFeatures.js

function asNumber(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function bboxFromXYXY(box) {
  const x1 = asNumber(box?.[0]) ?? 0;
  const y1 = asNumber(box?.[1]) ?? 0;
  const x2 = asNumber(box?.[2]) ?? 0;
  const y2 = asNumber(box?.[3]) ?? 0;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return { x, y, w, h };
}

function centerOfBBox(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function rectPointsFromBBox(b) {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

function extractDetections(raw) {
  const results = ensureArray(raw?.results);
  const dets = [];
  for (const r of results) for (const d of ensureArray(r?.detections)) dets.push(d);
  if (dets.length === 0) for (const d of ensureArray(raw?.detections)) dets.push(d);
  return dets;
}

// AML class mapping (based on your current output)
function classToFeatureType(cls) {
  if (cls === 0) return "column";
  if (cls === 1) return "staircaseOpening";
  if (cls === 2) return "floorPlateOpening";
  return null;
}


function systemActor() {
  return {
    userId: "system",
    email: "system@buildingreveal.com",
    displayName: "Reveal Inference",
  };
}


function buildMlFeaturesFromAml(raw, { runId, model }) {
  const now = new Date().toISOString();
  const actor = systemActor();

  const dets = extractDetections(raw);

  let columnsDetected = 0;
  let polygonsDetected = 0;

  const features = [];

  for (let i = 0; i < dets.length; i++) {
    const d = dets[i] || {};
    const cls = asNumber(d.cls);
    const type = classToFeatureType(cls);
    if (!type) continue;

    const score = typeof d.score === "number" ? d.score : asNumber(d.score);
    const box = d.box;
    if (!Array.isArray(box) || box.length < 4) continue;

    const bbox = bboxFromXYXY(box);

    if (type === "column") {
      const p = centerOfBBox(bbox);
      const id = `ml::${runId}::column::${columnsDetected}`;
      features.push({
        id,
        type: "column",
        geometry: { kind: "point", position: { x: p.x, y: p.y } },
        source: "ml",
        audit: { createdBy: actor, createdAt: now },
        ml: { runId, model: model || undefined, classId: 0, score, sourceBBox: bbox },
      });
      columnsDetected++;
    } else {
      const id = `ml::${runId}::${type}::${polygonsDetected}`;
      features.push({
        id,
        type,
        geometry: { kind: "polygon", points: rectPointsFromBBox(bbox), closed: true },
        source: "ml",
        audit: { createdBy: actor, createdAt: now },
        ml: { runId, model: model || undefined, classId: cls, score, sourceBBox: bbox },
      });
      polygonsDetected++;
    }
  }

  return {
    features,
    counts: {
      columnsDetected,
      beamsDetected: 0,
      polygonsDetected,
    },
  };
}

module.exports = { buildMlFeaturesFromAml };
