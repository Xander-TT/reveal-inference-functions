# score.py
import os
import io
import json
import math
import time
from typing import Any, Dict, List, Tuple, Optional

import base64

import numpy as np
import cv2

from ultralytics import YOLO


# ----------------------------
# Globals initialized in init()
# ----------------------------
MODEL: Optional[YOLO] = None
MODEL_NAME: str = ""  # populated in init(), included in responses

# Defaults (can be overridden per request)
DEFAULT_TILE_SIZE = 1024
DEFAULT_OVERLAP = 0.25  # 25% overlap
DEFAULT_CONF = 0.25
DEFAULT_IOU = 0.50
DEFAULT_MAX_DET = 300  # per tile
DEFAULT_BATCH = 16     # tune based on GPU/CPU memory

# Content crop params
DEFAULT_INK_THRESH = 245   # grayscale threshold; lower = more "ink"
DEFAULT_CROP_PAD = 32      # pixels padding around detected content
DEFAULT_MIN_CONTENT_AREA = 5000  # skip crop if content is too small


# ----------------------------
# Utility: parse request
# ----------------------------
def _parse_request(raw_data: Any) -> Dict[str, Any]:
    """
    AzureML can pass raw_data as str or bytes. Expect JSON.

    Expected JSON (sent by the Azure Function App):
    {
      "image_base64": "<base64-encoded image bytes>",
      "meta": {"client_name": "...", "slug": "...", "floorId": "...", "imageBlobPath": "..."},
      "tile": {"size": 1024, "overlap": 0.25},
      "yolo": {"conf": 0.25, "iou": 0.5, "imgsz": 1024, "max_det": 300, "batch": 16},
      "crop": {"enabled": true, "ink_thresh": 245, "pad": 32}
    }

    The Function App downloads the image from Blob Storage and encodes it as base64
    before calling this endpoint — AML never contacts Blob Storage directly.
    """
    if raw_data is None:
        raise ValueError("Empty request body")

    if isinstance(raw_data, (bytes, bytearray)):
        raw_data = raw_data.decode("utf-8", errors="ignore")

    if isinstance(raw_data, str):
        raw_data = raw_data.strip()
        return json.loads(raw_data)

    # Sometimes AzureML passes already-parsed dict
    if isinstance(raw_data, dict):
        return raw_data

    raise TypeError(f"Unsupported request type: {type(raw_data)}")


# ----------------------------
# Decode image bytes
# ----------------------------
def _decode_base64_image(image_base64: str) -> bytes:
    """
    Decode a base64-encoded image string to raw bytes.
    Raises ValueError on invalid base64 or empty result.
    """
    if not image_base64:
        raise ValueError("image_base64 is empty")
    try:
        img_bytes = base64.b64decode(image_base64, validate=True)
    except Exception as e:
        raise ValueError(f"Failed to decode image_base64: {e}")
    if len(img_bytes) == 0:
        raise ValueError("Decoded image_base64 is empty")
    return img_bytes


def _decode_image(img_bytes: bytes) -> np.ndarray:
    """
    Returns BGR uint8 image (OpenCV format).
    """
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image bytes")
    return img


# ----------------------------
# Whitespace / content crop
# ----------------------------
def _content_crop(
    bgr: np.ndarray,
    ink_thresh: int = DEFAULT_INK_THRESH,
    pad: int = DEFAULT_CROP_PAD,
    min_area: int = DEFAULT_MIN_CONTENT_AREA,
) -> Tuple[np.ndarray, Tuple[int, int]]:
    """
    Finds non-white "ink" region and crops image to that bbox.
    Returns (cropped_image, (x_offset, y_offset)) offsets in original image coords.
    If no meaningful content found, returns original and (0,0).
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    # "Ink" pixels are darker than threshold
    mask = (gray < ink_thresh).astype(np.uint8) * 255

    # Clean small specks
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    ys, xs = np.where(mask > 0)
    if len(xs) == 0 or len(ys) == 0:
        return bgr, (0, 0)

    x1, x2 = int(xs.min()), int(xs.max())
    y1, y2 = int(ys.min()), int(ys.max())

    area = (x2 - x1 + 1) * (y2 - y1 + 1)
    if area < min_area:
        return bgr, (0, 0)

    # Pad and clip
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(bgr.shape[1] - 1, x2 + pad)
    y2 = min(bgr.shape[0] - 1, y2 + pad)

    cropped = bgr[y1 : y2 + 1, x1 : x2 + 1].copy()
    return cropped, (x1, y1)


# ----------------------------
# Tiling
# ----------------------------
def _compute_grid(w: int, h: int, tile: int, overlap: float) -> List[Tuple[int, int]]:
    """
    Returns list of (x, y) top-left offsets for tiles.
    Uses stride = tile * (1 - overlap). Ensures full coverage (pads last tiles).
    """
    overlap = float(np.clip(overlap, 0.0, 0.9))
    stride = max(1, int(tile * (1.0 - overlap)))

    xs = list(range(0, max(1, w - tile + 1), stride))
    ys = list(range(0, max(1, h - tile + 1), stride))

    # Ensure last tile covers the end
    if len(xs) == 0:
        xs = [0]
    if len(ys) == 0:
        ys = [0]
    if xs[-1] != max(0, w - tile):
        xs.append(max(0, w - tile))
    if ys[-1] != max(0, h - tile):
        ys.append(max(0, h - tile))

    return [(x, y) for y in ys for x in xs]


def _extract_tile(bgr: np.ndarray, x: int, y: int, tile: int) -> np.ndarray:
    """
    Extract tile with padding if near borders. Returns tile-sized BGR.
    """
    h, w = bgr.shape[:2]
    x2 = x + tile
    y2 = y + tile

    tile_img = np.full((tile, tile, 3), 255, dtype=np.uint8)  # white padding
    src = bgr[y:min(y2, h), x:min(x2, w)]
    tile_img[0:src.shape[0], 0:src.shape[1]] = src
    return tile_img


def _batch_iter(items: List[Any], batch_size: int):
    for i in range(0, len(items), batch_size):
        yield items[i:i + batch_size]


# ----------------------------
# NMS (boxes) for dedupe
# ----------------------------
def _box_iou(a: np.ndarray, b: np.ndarray) -> float:
    # a, b: [x1,y1,x2,y2]
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter = inter_w * inter_h
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter + 1e-9
    return inter / union


def _nms_classwise(
    dets: List[Dict[str, Any]],
    iou_thresh: float,
) -> List[Dict[str, Any]]:
    """
    Simple class-wise NMS on boxes. Keeps highest scores.
    dets entries must include: cls (int), score (float), box [x1,y1,x2,y2]
    """
    out: List[Dict[str, Any]] = []
    by_cls: Dict[int, List[Dict[str, Any]]] = {}
    for d in dets:
        by_cls.setdefault(int(d["cls"]), []).append(d)

    for c, items in by_cls.items():
        items = sorted(items, key=lambda x: float(x["score"]), reverse=True)
        keep: List[Dict[str, Any]] = []
        for d in items:
            box_d = np.array(d["box"], dtype=np.float32)
            suppressed = False
            for k in keep:
                if _box_iou(box_d, np.array(k["box"], dtype=np.float32)) > iou_thresh:
                    suppressed = True
                    break
            if not suppressed:
                keep.append(d)
        out.extend(keep)

    # preserve global sorting by score
    out.sort(key=lambda x: float(x["score"]), reverse=True)
    return out


# ----------------------------
# YOLO tile inference + global merge
# ----------------------------
def _infer_yolo_tiled(
    bgr_full: np.ndarray,
    imgsz: int,
    tile_size: int,
    overlap: float,
    conf: float,
    iou: float,
    max_det: int,
    batch: int,
) -> Dict[str, Any]:
    """
    Runs YOLO on tiles and merges results into global coords.
    Returns dict with detections list.
    Each detection:
      {
        "cls": int,
        "score": float,
        "box": [x1,y1,x2,y2],
        "poly": [[x,y], ...]   # polygon points in full-image coords
      }
    """
    if MODEL is None:
        raise RuntimeError("Model not initialized")

    H, W = bgr_full.shape[:2]
    grid = _compute_grid(W, H, tile_size, overlap)

    tiles: List[np.ndarray] = []
    meta: List[Tuple[int, int]] = []  # (x,y) top-left offsets
    for (x, y) in grid:
        tiles.append(_extract_tile(bgr_full, x, y, tile_size))
        meta.append((x, y))

    all_dets: List[Dict[str, Any]] = []
    t0 = time.time()

    # Batched forward passes
    for batch_tiles_idx, tile_batch in enumerate(_batch_iter(list(range(len(tiles))), batch)):
        imgs = [tiles[i] for i in tile_batch]
        offsets = [meta[i] for i in tile_batch]

        # Ultralytics accepts list of numpy arrays (BGR ok; it handles conversion)
        results = MODEL.predict(
            imgs,
            imgsz=imgsz,
            conf=conf,
            iou=iou,
            max_det=max_det,
            verbose=False,
        )

        # results is list aligned with imgs
        for r, (ox, oy) in zip(results, offsets):
            if r.boxes is None or len(r.boxes) == 0:
                continue

            # Boxes: xyxy + conf + cls
            boxes_xyxy = r.boxes.xyxy.cpu().numpy()
            scores = r.boxes.conf.cpu().numpy()
            clss = r.boxes.cls.cpu().numpy().astype(int)

            # Polygons: r.masks.xy is list of Nx2 arrays in tile coords
            polys = None
            if r.masks is not None and hasattr(r.masks, "xy") and r.masks.xy is not None:
                polys = r.masks.xy  # list of arrays (float)

            for j in range(len(boxes_xyxy)):
                x1, y1, x2, y2 = boxes_xyxy[j].tolist()
                score = float(scores[j])
                cls = int(clss[j])

                # Offset box into full-image coords
                gx1 = float(x1 + ox)
                gy1 = float(y1 + oy)
                gx2 = float(x2 + ox)
                gy2 = float(y2 + oy)

                det: Dict[str, Any] = {
                    "cls": cls,
                    "score": score,
                    "box": [gx1, gy1, gx2, gy2],
                }

                # Offset polygon if available
                if polys is not None and j < len(polys) and polys[j] is not None:
                    p = polys[j]
                    # p is Nx2 (x,y) in tile coords
                    gp = [[float(px + ox), float(py + oy)] for (px, py) in p.tolist()]
                    det["poly"] = gp

                all_dets.append(det)

    t1 = time.time()

    # Global NMS to remove duplicates across overlaps
    merged = _nms_classwise(all_dets, iou_thresh=iou)

    return {
        "image_size": {"w": W, "h": H},
        "tiles": {
            "tile_size": tile_size,
            "overlap": overlap,
            "count": len(grid),
        },
        "timing": {
            "tile_infer_s": round(t1 - t0, 4),
        },
        "detections": merged,
    }


# ----------------------------
# AzureML entrypoints
# ----------------------------
def init():
    """
    Called once at startup. Load YOLO model.
    Azure credentials are no longer needed here — the Function App handles
    all Blob Storage access and sends image bytes directly via image_base64.
    """
    global MODEL, MODEL_NAME

    # Model path: either use AZUREML_MODEL_DIR or a fixed path in image
    model_dir = os.getenv("AZUREML_MODEL_DIR", "")
    model_filename = "yolo11-seg-mvp-m1-v3-20250115.pt"
    model_path = os.path.join(model_dir, model_filename) if model_dir else model_filename

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found at: {model_path}")

    MODEL = YOLO(model_path)
    MODEL_NAME = model_filename

    # Optional: warmup (small dummy image)
    dummy = np.full((DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, 3), 255, dtype=np.uint8)
    _ = MODEL.predict([dummy], imgsz=DEFAULT_TILE_SIZE, conf=0.25, verbose=False)


def run(raw_data: Any):
    """
    Called per request.

    The Azure Function App downloads the floor-plan image from Blob Storage and
    sends it as base64 — AML no longer fetches from Storage directly.

    Request schema:
      {
        "image_base64": "<base64-encoded image bytes>",
        "meta": {"client_name": "...", "slug": "...", "floorId": "...", "imageBlobPath": "..."},
        "tile":  {"size": 1024, "overlap": 0.25},          # optional
        "yolo":  {"conf": 0.25, "iou": 0.5, ...},           # optional
        "crop":  {"enabled": true, "ink_thresh": 245, ...}  # optional
      }

    Response schema (flat, single-image):
      {
        "ok": true,
        "model": "yolo11-seg-mvp-m1-v3-20250115.pt",
        "meta": { ... },
        "image_size": {"w": ..., "h": ...},
        "tiles": { ... },
        "timing": { "decode_s": ..., "total_s": ... },
        "detections": [ {"cls": int, "score": float, "box": [x1,y1,x2,y2], "poly": [[x,y],...] }, ... ],
        "crop": { ... }
      }

    The JS formatAmlToEditorFeatures.extractDetections() reads raw.detections directly.
    """
    req = _parse_request(raw_data)

    image_base64 = req.get("image_base64", "")
    if not image_base64:
        raise ValueError("Request must include 'image_base64'")

    meta: Dict[str, Any] = req.get("meta") or {}

    tile_cfg = req.get("tile", {}) or {}
    yolo_cfg = req.get("yolo", {}) or {}
    crop_cfg = req.get("crop", {}) or {}

    tile_size = int(tile_cfg.get("size", DEFAULT_TILE_SIZE))
    overlap = float(tile_cfg.get("overlap", DEFAULT_OVERLAP))

    imgsz = int(yolo_cfg.get("imgsz", tile_size))
    conf = float(yolo_cfg.get("conf", DEFAULT_CONF))
    iou = float(yolo_cfg.get("iou", DEFAULT_IOU))
    max_det = int(yolo_cfg.get("max_det", DEFAULT_MAX_DET))
    batch = int(yolo_cfg.get("batch", DEFAULT_BATCH))

    crop_enabled = bool(crop_cfg.get("enabled", True))
    ink_thresh = int(crop_cfg.get("ink_thresh", DEFAULT_INK_THRESH))
    crop_pad = int(crop_cfg.get("pad", DEFAULT_CROP_PAD))

    t_req0 = time.time()

    # 1) Decode base64 → bytes → BGR image
    t0 = time.time()
    img_bytes = _decode_base64_image(image_base64)
    bgr = _decode_image(img_bytes)
    t_decode = time.time() - t0

    # 2) Optional content crop
    crop_offset = (0, 0)
    bgr_for_infer = bgr
    if crop_enabled:
        bgr_for_infer, crop_offset = _content_crop(
            bgr, ink_thresh=ink_thresh, pad=crop_pad
        )

    # 3) Tiled YOLO inference
    infer_out = _infer_yolo_tiled(
        bgr_for_infer,
        imgsz=imgsz,
        tile_size=tile_size,
        overlap=overlap,
        conf=conf,
        iou=iou,
        max_det=max_det,
        batch=batch,
    )

    # 4) Shift detections back to original (pre-crop) coords
    ox, oy = crop_offset
    if (ox, oy) != (0, 0):
        for d in infer_out["detections"]:
            d["box"] = [
                d["box"][0] + ox,
                d["box"][1] + oy,
                d["box"][2] + ox,
                d["box"][3] + oy,
            ]
            if "poly" in d:
                d["poly"] = [[p[0] + ox, p[1] + oy] for p in d["poly"]]

        infer_out["crop"] = {
            "enabled": True,
            "offset": {"x": ox, "y": oy},
            "cropped_size": {
                "w": int(bgr_for_infer.shape[1]),
                "h": int(bgr_for_infer.shape[0]),
            },
            "original_size": {"w": int(bgr.shape[1]), "h": int(bgr.shape[0])},
        }
    else:
        infer_out["crop"] = {
            "enabled": crop_enabled,
            "offset": {"x": 0, "y": 0},
            "original_size": {"w": int(bgr.shape[1]), "h": int(bgr.shape[0])},
        }

    t_total = time.time() - t_req0

    # Flat single-image response — JS extractDetections() reads raw.detections directly.
    return {
        "ok": True,
        "model": MODEL_NAME,
        "meta": meta,
        "image_size": infer_out["image_size"],
        "tiles": infer_out["tiles"],
        "timing": {
            "decode_s": round(t_decode, 4),
            "tile_infer_s": infer_out["timing"]["tile_infer_s"],
            "total_s": round(t_total, 4),
        },
        "detections": infer_out["detections"],
        "crop": infer_out["crop"],
    }
