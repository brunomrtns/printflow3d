"""Mesh processing service for PrintFlow3D.

When a model file enters the system, this service runs in a background
thread and does two things:

1. Computes the mesh volume (STL/3MF units are assumed to be millimeters,
   the slicer convention) and derives an estimated material cost:
       cost = volume_ml * RESIN_PRICE_PER_LITER / 1000 + PRINT_FIXED_COST
2. Generates a heavily decimated "proxy" mesh (~8% of the original faces)
   exported as binary glTF (.glb) under UPLOAD_DIR/proxies/. The frontend
   viewer loads this proxy instead of the original file, removing WebGL
   bottlenecks on machines without hardware acceleration.

Files we can't parse with trimesh (STEP/STP need a CAD kernel) are marked
as 'skipped' and the viewer keeps loading the original.
"""

import os
import threading
import time
import logging
from pathlib import Path
from typing import Optional, Dict, Any

import trimesh

logger = logging.getLogger("mesh_service")

UPLOAD_DIR = Path(os.getenv("FILE_STORAGE", "./app/uploads"))
PROXY_DIR = Path(os.getenv("PROXY_STORAGE", UPLOAD_DIR / "proxies"))
PROXY_DIR.mkdir(parents=True, exist_ok=True)

# Pricing knobs. RESIN_PRICE_PER_LITER is the env-configurable *default* —
# the effective price can be overridden at runtime via the settings table
# (Settings UI), which is why process_model takes a price provider.
# Defaults: R$ 200,00/L de resina (R$ 0,20/mL) + R$ 2,50 fixo.
RESIN_PRICE_PER_LITER = float(os.getenv("RESIN_PRICE_PER_LITER_BRL", "200.0"))
PRINT_FIXED_COST = float(os.getenv("PRINT_FIXED_COST_BRL", "2.50"))

# Target face count for the proxy, as a fraction of the original.
PROXY_FACE_PERCENT = float(os.getenv("PROXY_FACE_PERCENT", "0.08"))
# Hard cap so even tiny source meshes produce a usable proxy.
PROXY_MIN_FACES = int(os.getenv("PROXY_MIN_FACES", "2000"))

# Pieces larger than this (in mm, assuming STL units = mm) are suspiciously
# big for resin printing — likely exported at the wrong scale (common with
# AI generators like Meshy that normalize to ~2m). Flagged in the UI so the
# user knows to rescale in the slicer; we never auto-rescale silently.
SCALE_WARNING_MAX_MM = float(os.getenv("SCALE_WARNING_MAX_MM", "400"))

# Extensions trimesh can reliably load in a headless environment.
SUPPORTED_EXTS = {".stl", ".3mf", ".obj", ".ply", ".off"}
UNSUPPORTED_EXTS = {".step", ".stp"}

STATUSES = ("pending", "done", "failed", "skipped")


def find_source_file(model_id: str) -> Optional[Path]:
    """Find the original uploaded file for a model (proxies live in a
    subdirectory, so a flat name-prefix scan is safe here)."""
    if not UPLOAD_DIR.is_dir():
        return None
    for fname in os.listdir(UPLOAD_DIR):
        fpath = UPLOAD_DIR / fname
        if fpath.is_file() and fname.startswith(model_id):
            return fpath
    return None


def proxy_path_for(model_id: str) -> Path:
    return PROXY_DIR / f"{model_id}.glb"


def estimate_cost(volume_ml: float, price_per_liter: float) -> float:
    """Base pricing formula: resin cost + fixed energy/consumable cost.
    `price_per_liter` is R$/L → divide by 1000 for R$/mL."""
    return round(volume_ml * (price_per_liter / 1000.0) + PRINT_FIXED_COST, 2)


def _load_mesh(path: Path) -> trimesh.Trimesh:
    mesh = trimesh.load(str(path), force="mesh", process=False)
    if mesh is None or len(mesh.vertices) == 0:
        raise ValueError("empty or unreadable mesh")
    return mesh


def _decimate(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Quadric decimation to ~PROXY_FACE_PERCENT of the original faces."""
    target = max(PROXY_MIN_FACES, int(len(mesh.faces) * PROXY_FACE_PERCENT))
    if len(mesh.faces) <= target:
        return mesh
    try:
        return mesh.simplify_quadric_decimation(face_count=target)
    except TypeError:
        # Older/newer signature variants accept percent instead.
        return mesh.simplify_quadric_decimation(percent=PROXY_FACE_PERCENT)


def process_model(
    model_id: str, update_db, get_price=None
) -> Dict[str, Any]:
    """Full pipeline for one model. `update_db` is a callable
    (model_id, fields_dict) injected by app.py to keep this module
    storage-agnostic. `get_price` is a callable returning the current
    resin price per liter (falls back to the env default)."""
    price_per_liter = (
        float(get_price()) if get_price else RESIN_PRICE_PER_LITER
    )
    src = find_source_file(model_id)
    if src is None:
        update_db(model_id, {"proxy_status": "failed"})
        return {"status": "failed", "reason": "source file not found"}

    ext = src.suffix.lower()
    if ext in UNSUPPORTED_EXTS or ext not in SUPPORTED_EXTS:
        update_db(
            model_id,
            {"proxy_status": "skipped", "scale_warning": 0},
        )
        return {"status": "skipped", "reason": f"unsupported format {ext}"}

    try:
        mesh = _load_mesh(src)

        # Bounding box in the file's own units (assumed mm per slicer
        # convention). Exposed to the UI so mis-scaled exports are
        # diagnosable at a glance.
        dims = [round(float(d), 2) for d in mesh.extents]
        scale_warning = bool(dims) and max(dims) > SCALE_WARNING_MAX_MM

        # STL has no unit metadata and mesh.volume uses the divergence
        # theorem. With process=False, STLs load as unmerged triangles, so
        # merge vertices first; then try fill_holes() on genuinely open
        # meshes (needs networkx). Only adopt the repaired mesh if it
        # actually becomes a closed volume — otherwise the raw signed
        # volume (valid on winding-consistent meshes) is the best estimate.
        if not mesh.is_volume:
            try:
                repaired = mesh.copy()
                repaired.merge_vertices()
                if not repaired.is_volume:
                    repaired.fill_holes()
                if repaired.is_volume:
                    mesh = repaired
            except Exception:
                pass  # keep the raw signed-volume estimate

        # trimesh returns units³ — with STL convention (mm) that is mm³.
        # mm³ / 1000 = cm³ = mL.
        volume_mm3 = abs(float(mesh.volume))
        volume_ml = volume_mm3 / 1000.0
        proxy = _decimate(mesh)
        proxy_path = proxy_path_for(model_id)
        proxy.export(str(proxy_path), file_type="glb")
        fields = {
            "volume_ml": round(volume_ml, 2),
            "estimated_cost": estimate_cost(volume_ml, price_per_liter),
            "proxy_status": "done",
            "dim_x": dims[0] if len(dims) > 0 else None,
            "dim_y": dims[1] if len(dims) > 1 else None,
            "dim_z": dims[2] if len(dims) > 2 else None,
            "scale_warning": 1 if scale_warning else 0,
        }
        update_db(model_id, fields)
        return {"status": "done", **fields}
    except Exception as exc:
        logger.warning("mesh processing failed for %s: %s", model_id, exc)
        update_db(model_id, {"proxy_status": "failed"})
        return {"status": "failed", "reason": str(exc)}


def queue_process(model_id: str, update_db, get_price=None) -> threading.Thread:
    """Fire-and-forget processing in a daemon thread (the API returns
    immediately; the proxy/volume appear on the next model fetch)."""
    update_db(model_id, {"proxy_status": "pending"})
    thread = threading.Thread(
        target=process_model, args=(model_id, update_db, get_price), daemon=True
    )
    thread.start()
    return thread


def backfill(update_db, list_pending_ids, get_price=None) -> threading.Thread:
    """Process every model that has no proxy_status yet (existing
    library imported before this feature shipped) or was left
    'pending' by a restart. Runs sequentially in one daemon thread."""

    def _run():
        ids = list_pending_ids()
        for model_id in ids:
            try:
                process_model(model_id, update_db, get_price)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("backfill failed for %s: %s", model_id, exc)
            time.sleep(0.05)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return thread
