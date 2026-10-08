import os
import uuid
import time
import shutil
import sqlite3
import base64
import binascii
import hashlib
from fastapi import (
    FastAPI,
    UploadFile,
    File,
    Form,
    HTTPException,
    Request,
)
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.middleware.cors import CORSMiddleware
import json
from pathlib import Path
from typing import Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field


from importers import makerworld, printables
import mesh_service

DB_PATH = os.getenv("DB_PATH", "data.db")
UPLOAD_DIR = Path(os.getenv("FILE_STORAGE", "./app/uploads"))
MANUAL_DIR = Path(os.getenv("MANUAL_STORAGE", UPLOAD_DIR / "manuals"))
MANUAL_DIR.mkdir(parents=True, exist_ok=True)
WEBUI_URL = os.getenv("WEBUI_URL", "http://localhost:5173")

# ROOT_PATH is the public path prefix the app is mounted under in production
# (e.g. "/3dpanel" behind the trivestia-nginx reverse proxy). It only affects
# URL generation (url_for, OpenAPI docs); nginx strips the prefix before the
# request reaches this app. Empty in local development.
ROOT_PATH = os.getenv("ROOT_PATH", "")

# STATIC_DIR points to the compiled frontend bundle (Vite dist/). When set and
# the directory exists, the API container also serves the SPA (all-in-one
# production image). Unset in local dev (vite dev server serves the frontend).
_static_dir_env = os.getenv("STATIC_DIR", "")
STATIC_DIR = Path(_static_dir_env).resolve() if _static_dir_env else None

# CORS: the production deployment is same-origin (frontend and API share the
# /3dpanel path), so CORS is only relevant for local development. Configure via
# ALLOWED_ORIGINS (comma-separated). Defaults to the web UI origin.
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
] or [WEBUI_URL]


class FolderData(BaseModel):
    name: str
    parentId: Union[str, None] = None


class ModelGroupCreate(BaseModel):
    name: str = Field(min_length=1)
    modelIds: List[str] = Field(min_length=1)


class ModelGroupUpdate(BaseModel):
    name: str = Field(min_length=1)


class ModelGroupMembers(BaseModel):
    modelIds: List[str] = Field(min_length=1)


app = FastAPI(title="PrintFlow3D API", root_path=ROOT_PATH)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parentId TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS models (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            folderId TEXT NOT NULL,
            url TEXT NOT NULL,
            size INTEGER,
            dateAdded INTEGER,
            tags TEXT,
            description TEXT,
            thumbnail TEXT,
            manual TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            dateAdded INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS model_group_members (
            modelId TEXT PRIMARY KEY,
            groupId TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(modelId) REFERENCES models(id) ON DELETE CASCADE,
            FOREIGN KEY(groupId) REFERENCES model_groups(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_model_group_members_group ON model_group_members(groupId, position)"
    )
    try:
        cur.execute("ALTER TABLE models ADD COLUMN manual TEXT")
    except sqlite3.OperationalError:
        pass
    # Mesh processing columns (volume/pricing + WebGL proxy status)
    for col, coltype in (
        ("volume_ml", "REAL"),
        ("estimated_cost", "REAL"),
        ("proxy_status", "TEXT"),
        ("dim_x", "REAL"),
        ("dim_y", "REAL"),
        ("dim_z", "REAL"),
        ("scale_warning", "INTEGER"),
    ):
        try:
            cur.execute(f"ALTER TABLE models ADD COLUMN {col} {coltype}")
        except sqlite3.OperationalError:
            pass
    if os.getenv("MAKERWORLD_BAMBU_TOKEN"):
        cur.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)",
            ("makerworld_bambu_token", os.getenv("MAKERWORLD_BAMBU_TOKEN")),
        )
    conn.commit()

    # seed folders if empty
    cur.execute("SELECT COUNT(*) as c FROM folders")
    if cur.fetchone()[0] == 0:
        seed = [
            ("1", "Characters", None),
            ("2", "Vehicles", None),
            ("3", "Terrain", None),
            ("4", "Tanks", "2"),
        ]
        cur.executemany("INSERT INTO folders(id,name,parentId) VALUES (?,?,?)", seed)
        conn.commit()

    conn.close()


init_db()


def now_ms() -> int:
    return int(time.time() * 1000)


def row_to_folder(row: sqlite3.Row) -> Dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "parentId": row["parentId"]}


def row_to_model(row: sqlite3.Row) -> Dict[str, Any]:
    tags = []
    if row["tags"]:
        try:
            tags = json.loads(row["tags"])
        except Exception:
            tags = []
    model = {
        "id": row["id"],
        "name": row["name"],
        "folderId": row["folderId"],
        "url": row["url"],
        "size": row["size"],
        "dateAdded": row["dateAdded"],
        "tags": tags,
        "description": row["description"] or "",
        "thumbnail": row["thumbnail"],
        "manual": row["manual"] if "manual" in row.keys() else None,
        "groupId": row["groupId"] if "groupId" in row.keys() else None,
        "groupName": row["groupName"] if "groupName" in row.keys() else None,
        "volumeMl": row["volume_ml"] if "volume_ml" in row.keys() else None,
        "estimatedCost": (
            row["estimated_cost"] if "estimated_cost" in row.keys() else None
        ),
        "proxyStatus": (
            row["proxy_status"] if "proxy_status" in row.keys() else None
        ),
    }
    # previewUrl points at the decimated WebGL proxy when one was
    # generated; otherwise the viewer falls back to the original file.
    model["previewUrl"] = (
        f"/api/models/{model['id']}/proxy.glb"
        if model["proxyStatus"] == "done"
        else model["url"]
    )
    # Bounding-box dimensions in mm (file units, slicer convention) —
    # computed by the mesh pipeline, or measured by the viewer for
    # formats trimesh can't parse (STEP).
    if "dim_x" in row.keys() and row["dim_x"] is not None:
        model["dimensions"] = {
            "x": row["dim_x"],
            "y": row["dim_y"],
            "z": row["dim_z"],
        }
    model["scaleWarning"] = bool(
        row["scale_warning"] if "scale_warning" in row.keys() else 0
    )
    return model


def get_model_with_group(
    conn: sqlite3.Connection, model_id: str
) -> Optional[sqlite3.Row]:
    return conn.execute(
        """
        SELECT m.*, mgm.groupId, mg.name AS groupName
        FROM models m
        LEFT JOIN model_group_members mgm ON mgm.modelId = m.id
        LEFT JOIN model_groups mg ON mg.id = mgm.groupId
        WHERE m.id=?
        """,
        (model_id,),
    ).fetchone()


def row_to_model_list_item(row: sqlite3.Row, request: Request) -> Dict[str, Any]:
    model = row_to_model(row)
    if row["thumbnailSignature"]:
        version = hashlib.sha256(row["thumbnailSignature"].encode()).hexdigest()[:12]
        url = request.url_for("get_model_thumbnail", model_id=model["id"])
        model["thumbnail"] = f"{url}?v={version}"
    return model


def thumbnail_media_type(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(status_code=415, detail="Unsupported thumbnail image")


def save_upload_file(upload_file: UploadFile, dest_path: str) -> int:
    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(upload_file.file, buffer)
    size = os.path.getsize(dest_path)
    return size


def get_setting(key: str) -> Optional[str]:
    conn = get_db_conn()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else None


def set_setting(key: str, value: str):
    conn = get_db_conn()
    conn.execute(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()
    conn.close()


def clear_setting(key: str):
    conn = get_db_conn()
    conn.execute("DELETE FROM settings WHERE key=?", (key,))
    conn.commit()
    conn.close()


# --- Mesh processing (volume/pricing + WebGL proxy decimation) ---
def update_model_mesh_fields(model_id: str, fields: Dict[str, Any]):
    """DB writer injected into mesh_service workers."""
    if not fields:
        return
    allowed = {
        "volume_ml",
        "estimated_cost",
        "proxy_status",
        "dim_x",
        "dim_y",
        "dim_z",
        "scale_warning",
    }
    sets = [f"{k}=?" for k in fields if k in allowed]
    vals = [fields[k] for k in fields if k in allowed]
    if not sets:
        return
    conn = get_db_conn()
    conn.execute(
        f"UPDATE models SET {', '.join(sets)} WHERE id=?",
        (*vals, model_id),
    )
    conn.commit()
    conn.close()


def list_pending_mesh_ids() -> List[str]:
    conn = get_db_conn()
    rows = conn.execute(
        """SELECT id FROM models
           WHERE proxy_status IS NULL
              OR proxy_status='pending'
              OR (proxy_status='done' AND dim_x IS NULL)"""
    ).fetchall()
    conn.close()
    return [r["id"] for r in rows]


def current_resin_price() -> float:
    """Effective resin price (R$/liter): the value saved in Settings,
    falling back to the RESIN_PRICE_PER_LITER_BRL env default."""
    try:
        stored = get_setting("resin_price_per_liter")
        return float(stored) if stored is not None else mesh_service.RESIN_PRICE_PER_LITER
    except (TypeError, ValueError):
        return mesh_service.RESIN_PRICE_PER_LITER


def queue_mesh_processing(model_id: str):
    try:
        mesh_service.queue_process(
            model_id, update_model_mesh_fields, get_price=current_resin_price
        )
    except Exception:
        pass  # processing is best-effort; the model still works without it


def row_to_model_group(row: sqlite3.Row, model_ids: List[str]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "dateAdded": row["dateAdded"],
        "modelIds": model_ids,
    }


def get_model_group(conn: sqlite3.Connection, group_id: str) -> Dict[str, Any]:
    row = conn.execute(
        "SELECT id, name, dateAdded FROM model_groups WHERE id=?", (group_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Model group not found")
    members = conn.execute(
        "SELECT modelId FROM model_group_members WHERE groupId=? ORDER BY position, rowid",
        (group_id,),
    ).fetchall()
    return row_to_model_group(row, [member["modelId"] for member in members])


def validate_model_ids(conn: sqlite3.Connection, model_ids: List[str]):
    if not model_ids:
        return
    placeholders = ",".join("?" for _ in model_ids)
    found = {
        row["id"]
        for row in conn.execute(
            f"SELECT id FROM models WHERE id IN ({placeholders})", model_ids
        ).fetchall()
    }
    missing = [model_id for model_id in model_ids if model_id not in found]
    if missing:
        raise HTTPException(
            status_code=404, detail=f"Models not found: {', '.join(missing)}"
        )


def delete_group_if_empty(conn: sqlite3.Connection, group_id: Optional[str]):
    if not group_id:
        return
    conn.execute(
        """
        DELETE FROM model_groups
        WHERE id=?
          AND NOT EXISTS (
            SELECT 1 FROM model_group_members WHERE groupId=model_groups.id
          )
        """,
        (group_id,),
    )


def add_group_members(
    conn: sqlite3.Connection, group_id: str, model_ids: List[str]
):
    model_ids = list(dict.fromkeys(model_ids))
    validate_model_ids(conn, model_ids)
    if not model_ids:
        return

    placeholders = ",".join("?" for _ in model_ids)
    assigned = conn.execute(
        f"SELECT modelId, groupId FROM model_group_members WHERE modelId IN ({placeholders})",
        model_ids,
    ).fetchall()
    conflicting = [
        row["modelId"] for row in assigned if row["groupId"] != group_id
    ]
    if conflicting:
        raise HTTPException(
            status_code=409,
            detail="One or more models already belong to another model group",
        )

    assigned_to_target = {
        row["modelId"] for row in assigned if row["groupId"] == group_id
    }
    model_ids = [
        model_id for model_id in model_ids if model_id not in assigned_to_target
    ]
    if not model_ids:
        return

    next_position = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM model_group_members WHERE groupId=?",
        (group_id,),
    ).fetchone()[0]
    conn.executemany(
        "INSERT INTO model_group_members(modelId, groupId, position) VALUES (?,?,?)",
        [
            (model_id, group_id, next_position + offset)
            for offset, model_id in enumerate(model_ids)
        ],
    )


# --- Folder endpoints ---
@app.get("/api/folders")
def get_folders():
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("SELECT id,name,parentId FROM folders")
    rows = cur.fetchall()
    conn.close()
    return [row_to_folder(r) for r in rows]


@app.post("/api/folders")
def create_folder(item: FolderData):
    fid = str(uuid.uuid4())
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO folders(id,name,parentId) VALUES (?,?,?)",
        (fid, item.name, item.parentId),
    )
    conn.commit()
    conn.close()
    return {"id": fid, "name": item.name, "parentId": item.parentId}


@app.patch("/api/folders/{folder_id}")
def update_folder(folder_id: str, item: FolderData):
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("UPDATE folders SET name=? WHERE id=?", (item.name, folder_id))
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Folder not found")
    conn.commit()
    cur.execute("SELECT id,name,parentId FROM folders WHERE id=?", (folder_id,))
    row = cur.fetchone()
    conn.close()
    return row_to_folder(row)


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str):
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM models WHERE folderId=? LIMIT 1", (folder_id,))
    if cur.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Folder must be empty to delete")
    cur.execute("SELECT 1 FROM folders WHERE parentId=? LIMIT 1", (folder_id,))
    if cur.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Folder must be empty to delete")
    cur.execute("DELETE FROM folders WHERE id=?", (folder_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# --- Model group endpoints ---
@app.get("/api/model-groups")
def get_model_groups():
    conn = get_db_conn()
    rows = conn.execute(
        "SELECT id, name, dateAdded FROM model_groups ORDER BY name COLLATE NOCASE"
    ).fetchall()
    groups = [get_model_group(conn, row["id"]) for row in rows]
    conn.close()
    return groups


@app.post("/api/model-groups")
def create_model_group(payload: ModelGroupCreate):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    model_ids = list(dict.fromkeys(payload.modelIds))
    group_id = str(uuid.uuid4())
    conn = get_db_conn()
    try:
        conn.execute(
            "INSERT INTO model_groups(id, name, dateAdded) VALUES (?,?,?)",
            (group_id, name, now_ms()),
        )
        add_group_members(conn, group_id, model_ids)
        conn.commit()
        return get_model_group(conn, group_id)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.patch("/api/model-groups/{group_id}")
def update_model_group(group_id: str, payload: ModelGroupUpdate):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    conn = get_db_conn()
    try:
        get_model_group(conn, group_id)
        conn.execute("UPDATE model_groups SET name=? WHERE id=?", (name, group_id))
        conn.commit()
        return get_model_group(conn, group_id)
    finally:
        conn.close()


@app.delete("/api/model-groups/{group_id}")
def delete_model_group(group_id: str):
    conn = get_db_conn()
    try:
        get_model_group(conn, group_id)
        conn.execute("DELETE FROM model_groups WHERE id=?", (group_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/model-groups/{group_id}/models")
def add_models_to_group(group_id: str, payload: ModelGroupMembers):
    model_ids = list(dict.fromkeys(payload.modelIds))
    conn = get_db_conn()
    try:
        get_model_group(conn, group_id)
        add_group_members(conn, group_id, model_ids)
        conn.commit()
        return get_model_group(conn, group_id)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/api/model-groups/{group_id}/models/{model_id}")
def remove_model_from_group(group_id: str, model_id: str):
    conn = get_db_conn()
    try:
        get_model_group(conn, group_id)
        cursor = conn.execute(
            "DELETE FROM model_group_members WHERE groupId=? AND modelId=?",
            (group_id, model_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Model is not in this group")
        remaining = conn.execute(
            "SELECT COUNT(*) FROM model_group_members WHERE groupId=?", (group_id,)
        ).fetchone()[0]
        if remaining == 0:
            delete_group_if_empty(conn, group_id)
            conn.commit()
            return {"ok": True, "groupDeleted": True}
        conn.commit()
        return get_model_group(conn, group_id)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# --- Model endpoints ---
@app.get("/api/models")
def get_models(request: Request, folderId: Optional[str] = None):
    conn = get_db_conn()
    cur = conn.cursor()
    columns = """
        m.id, m.name, m.folderId, m.url, m.size, m.dateAdded, m.tags, m.description,
        m.volume_ml, m.estimated_cost, m.proxy_status,
        m.dim_x, m.dim_y, m.dim_z, m.scale_warning,
        NULL AS thumbnail, m.manual, mgm.groupId, mg.name AS groupName,
        CASE WHEN m.thumbnail IS NOT NULL AND m.thumbnail != '' THEN
            length(CAST(m.thumbnail AS BLOB)) || ':' ||
            hex(substr(CAST(m.thumbnail AS BLOB), 33, 16)) || ':' ||
            hex(substr(CAST(m.thumbnail AS BLOB), -16))
        END AS thumbnailSignature
    """
    source = """
        models m
        LEFT JOIN model_group_members mgm ON mgm.modelId = m.id
        LEFT JOIN model_groups mg ON mg.id = mgm.groupId
    """
    if folderId and folderId != "all":
        cur.execute(f"SELECT {columns} FROM {source} WHERE m.folderId=?", (folderId,))
    else:
        cur.execute(f"SELECT {columns} FROM {source}")
    rows = cur.fetchall()
    conn.close()
    return [row_to_model_list_item(r, request) for r in rows]

def get_model_info(modelId):
    conn = get_db_conn()
    if modelId is not None:
        m = get_model_with_group(conn, modelId)
    else:
        return None
    conn.close()
    return row_to_model(m)

@app.post("/api/models/upload")
def upload_model(
    file: UploadFile = File(...),
    folderId: str = Form("1"),
    thumbnail: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),
):
    mid = str(uuid.uuid4())
    
    # Ensure that file.filename is a string before passing it to os.path.splitext, providing a default value if it is None
    filename_str = file.filename or ".stl"
    ext = os.path.splitext(filename_str)[1] or ".stl"
    
    filename = f"{mid}{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    size = save_upload_file(file, path)

    tag_list: List[str] = []
    if tags:
        try:
            tag_list = json.loads(tags)
        except Exception:
            tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]

    model = {
        "id": mid,
        "name": file.filename,
        "folderId": folderId if folderId != "all" else "1",
        "url": f"/api/models/{mid}/download",
        "size": size,
        "dateAdded": now_ms(),
        "tags": tag_list,
        "description": "",
        "thumbnail": thumbnail,
        "groupId": None,
        "groupName": None,
    }

    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO models(id,name,folderId,url,size,dateAdded,tags,description,thumbnail) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            model["id"],
            model["name"],
            model["folderId"],
            model["url"],
            model["size"],
            model["dateAdded"],
            json.dumps(model["tags"]),
            model["description"],
            model["thumbnail"],
        ),
    )
    conn.commit()
    conn.close()
    queue_mesh_processing(mid)
    return model


@app.patch("/api/models/{model_id}")
def update_model(model_id: str, updates: dict):
    conn = get_db_conn()
    cur = conn.cursor()
    m = cur.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")

    # Build update statement
    allowed = ["name", "folderId", "tags", "description", "thumbnail"]
    fields = []
    values = []
    for k in allowed:
        if k in updates:
            if k == "tags":
                values.append(json.dumps(updates[k] or []))
            else:
                values.append(updates[k])
            fields.append(f"{k}=?")

    # Viewer-measured bounding box (formats the backend can't parse,
    # e.g. STEP). Backend-computed dims win: only store when absent.
    dims = updates.get("dimensions")
    if isinstance(dims, dict):
        try:
            dx, dy, dz = (float(dims[a]) for a in ("x", "y", "z"))
        except (KeyError, TypeError, ValueError):
            dx = dy = dz = None
        if dx is not None and m["dim_x"] is None:
            fields += ["dim_x=?", "dim_y=?", "dim_z=?", "scale_warning=?"]
            values += [
                dx,
                dy,
                dz,
                1 if max(dx, dy, dz) > mesh_service.SCALE_WARNING_MAX_MM else 0,
            ]

    if fields:
        sql = f"UPDATE models SET {', '.join(fields)} WHERE id=?"
        cur.execute(sql, (*values, model_id))
        conn.commit()

    row = get_model_with_group(conn, model_id)
    conn.close()
    return row_to_model(row)


@app.delete("/api/models/{model_id}")
def delete_model(model_id: str):
    conn = get_db_conn()
    cur = conn.cursor()
    m = get_model_with_group(conn, model_id)
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")
    # Delete file if exists
    for fname in os.listdir(UPLOAD_DIR):
        if fname.startswith(model_id):
            try:
                os.remove(os.path.join(UPLOAD_DIR, fname))
            except Exception:
                pass
    proxy_path = mesh_service.proxy_path_for(model_id)
    if proxy_path.exists():
        try:
            proxy_path.unlink()
        except Exception:
            pass
    manual_path = MANUAL_DIR / f"{model_id}.md"
    if manual_path.exists():
        try:
            manual_path.unlink()
        except Exception:
            pass
    cur.execute("DELETE FROM models WHERE id=?", (model_id,))
    delete_group_if_empty(conn, m["groupId"])
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/models/{model_id}/download")
def download_model(model_id: str):
    # Find file matching id
    m_info = get_model_info(model_id)
    for fname in os.listdir(UPLOAD_DIR):
        if fname.startswith(model_id):
            return FileResponse(
                os.path.join(UPLOAD_DIR, fname),
                media_type="application/octet-stream",
                filename=m_info["name"],
            )
    raise HTTPException(status_code=404, detail="File not found")


@app.get("/api/models/{model_id}/proxy.glb", name="get_model_proxy")
def get_model_proxy(model_id: str):
    """Serve the decimated WebGL proxy (binary glTF). The frontend viewer
    uses this instead of the original mesh when proxy_status == 'done'.
    The original file is untouched — /download still serves it."""
    proxy_path = mesh_service.proxy_path_for(model_id)
    if not proxy_path.exists():
        raise HTTPException(status_code=404, detail="Proxy not generated")
    return FileResponse(
        str(proxy_path),
        media_type="model/gltf-binary",
        filename=f"{model_id}.glb",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.post("/api/models/{model_id}/reprocess")
def reprocess_model(model_id: str):
    """Force mesh reprocessing (volume + proxy). Useful for models that
    failed or were imported before mesh processing existed."""
    conn = get_db_conn()
    m = conn.execute("SELECT id FROM models WHERE id=?", (model_id,)).fetchone()
    conn.close()
    if not m:
        raise HTTPException(status_code=404, detail="Model not found")
    proxy_path = mesh_service.proxy_path_for(model_id)
    if proxy_path.exists():
        try:
            proxy_path.unlink()
        except Exception:
            pass
    queue_mesh_processing(model_id)
    return {"ok": True, "proxyStatus": "pending"}


@app.post("/api/models/bulk-delete")
def bulk_delete(payload: dict):
    ids = payload.get("ids", [])
    conn = get_db_conn()
    cur = conn.cursor()
    affected_group_ids = set()
    for mid in ids:
        membership = cur.execute(
            "SELECT groupId FROM model_group_members WHERE modelId=?", (mid,)
        ).fetchone()
        if membership:
            affected_group_ids.add(membership["groupId"])
        # delete files
        for fname in os.listdir(UPLOAD_DIR):
            if fname.startswith(mid):
                try:
                    os.remove(os.path.join(UPLOAD_DIR, fname))
                except Exception:
                    pass
        proxy_path = mesh_service.proxy_path_for(mid)
        if proxy_path.exists():
            try:
                proxy_path.unlink()
            except Exception:
                pass
        manual_path = MANUAL_DIR / f"{mid}.md"
        if manual_path.exists():
            try:
                manual_path.unlink()
            except Exception:
                pass
        cur.execute("DELETE FROM models WHERE id=?", (mid,))
    for group_id in affected_group_ids:
        delete_group_if_empty(conn, group_id)
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/models/bulk-move")
def bulk_move(payload: dict):
    ids = payload.get("ids", [])
    folderId = payload.get("folderId")
    conn = get_db_conn()
    cur = conn.cursor()
    for mid in ids:
        cur.execute("UPDATE models SET folderId=? WHERE id=?", (folderId, mid))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/models/bulk-tag")
def bulk_tag(payload: dict):
    ids = payload.get("ids", [])
    tags = payload.get("tags", [])
    conn = get_db_conn()
    cur = conn.cursor()
    for mid in ids:
        row = cur.execute("SELECT tags FROM models WHERE id=?", (mid,)).fetchone()
        if not row:
            continue
        existing = []
        if row["tags"]:
            try:
                existing = json.loads(row["tags"])
            except Exception:
                existing = []
        merged = list(dict.fromkeys(existing + tags))
        cur.execute("UPDATE models SET tags=? WHERE id=?", (json.dumps(merged), mid))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.put("/api/models/{model_id}/file")
def replace_model_file(
    model_id: str, file: UploadFile = File(...), thumbnail: Optional[str] = Form(None)
):
    conn = get_db_conn()
    cur = conn.cursor()
    m = cur.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")
    # remove existing files that start with model_id
    for fname in os.listdir(UPLOAD_DIR):
        if fname.startswith(model_id):
            try:
                os.remove(os.path.join(UPLOAD_DIR, fname))
            except Exception:
                pass

    filename_str = file.filename or ".stl"
    ext = os.path.splitext(filename_str)[-1] or ".stl"
    filename = f"{model_id}{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    size = save_upload_file(file, path)

    # A replaced source file invalidates the previous proxy/volume data.
    proxy_path = mesh_service.proxy_path_for(model_id)
    if proxy_path.exists():
        try:
            proxy_path.unlink()
        except Exception:
            pass
    cur.execute(
        "UPDATE models SET url=?, size=?, thumbnail=?, "
        "volume_ml=NULL, estimated_cost=NULL, proxy_status=NULL WHERE id=?",
        (f"/api/models/{model_id}/download", size, thumbnail, model_id),
    )
    conn.commit()
    row = get_model_with_group(conn, model_id)
    conn.close()
    queue_mesh_processing(model_id)
    return row_to_model(row)


@app.get("/api/models/{model_id}/thumbnail", name="get_model_thumbnail")
def get_model_thumbnail(model_id: str):
    conn = get_db_conn()
    row = conn.execute(
        "SELECT thumbnail FROM models WHERE id=?", (model_id,)
    ).fetchone()
    conn.close()
    if not row or not row["thumbnail"]:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    metadata, separator, payload = row["thumbnail"].partition(",")
    if (
        not separator
        or not metadata.startswith("data:")
        or not metadata.endswith(";base64")
    ):
        raise HTTPException(status_code=415, detail="Invalid thumbnail format")
    try:
        content = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=415, detail="Invalid thumbnail data")

    return Response(
        content=content,
        media_type=thumbnail_media_type(content),
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.put("/api/models/{model_id}/thumbnail")
def replace_model_thumbnail(
    model_id: str, file: UploadFile = File(...)
):
    filename_str = file.filename
    ext = os.path.splitext(filename_str)[-1]
    if not ext:
        raise HTTPException(status_code=429, detail="File not Valid, Extension not found")
    
    filebytes = file.file.read()
    encoded_string = base64.b64encode(filebytes)
    baseext = ext[1:]
    thumbnail =  "data:image/" + baseext + ";base64," + encoded_string.decode()
    
    conn = get_db_conn()
    cur = conn.cursor()
    
    m = cur.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")

    cur.execute(
        "UPDATE models SET thumbnail=? WHERE id=?",
        (thumbnail, model_id),
    )
    conn.commit()
    row = get_model_with_group(conn, model_id)
    conn.close()
    return row_to_model(row)


@app.get("/api/models/{model_id}/manual")
def get_model_manual(model_id: str):
    path = MANUAL_DIR / f"{model_id}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Manual not found")
    return FileResponse(path, media_type="text/markdown")


@app.put("/api/models/{model_id}/manual")
def upload_model_manual(model_id: str, file: UploadFile = File(...)):
    conn = get_db_conn()
    cur = conn.cursor()
    m = cur.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")

    path = MANUAL_DIR / f"{model_id}.md"
    save_upload_file(file, str(path))

    cur.execute(
        "UPDATE models SET manual=? WHERE id=?",
        (file.filename, model_id),
    )
    conn.commit()
    row = get_model_with_group(conn, model_id)
    conn.close()
    return row_to_model(row)


@app.delete("/api/models/{model_id}/manual")
def delete_model_manual(model_id: str):
    conn = get_db_conn()
    cur = conn.cursor()
    m = cur.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    if not m:
        conn.close()
        raise HTTPException(status_code=404, detail="Model not found")

    path = MANUAL_DIR / f"{model_id}.md"
    if path.exists():
        try:
            path.unlink()
        except Exception:
            pass

    cur.execute("UPDATE models SET manual=NULL WHERE id=?", (model_id,))
    conn.commit()
    row = get_model_with_group(conn, model_id)
    conn.close()
    return row_to_model(row)


@app.get("/api/storage-stats")
def storage_stats():
    used = 0
    for root, _dirs, files in os.walk(UPLOAD_DIR):
        for fname in files:
            used += os.path.getsize(os.path.join(root, fname))
    total = 5 * 1024 * 1024 * 1024
    return {"used": used, "total": total}


def importer_for_url(url: str):
    if "makerworld.com" in url.lower():
        return makerworld.MakerWorldImporter(), "makerworld"
    return printables.PrintablesImporter(), "printables"


def importer_for_source(source: str):
    if source == "makerworld":
        return makerworld.MakerWorldImporter(get_setting("makerworld_bambu_token")), "MakerWorld"
    return printables.PrintablesImporter(), "Printables"


@app.get("/api/settings/resin-price")
def resin_price_status():
    stored = get_setting("resin_price_per_liter")
    return {
        "pricePerLiter": current_resin_price(),
        "fixedCost": mesh_service.PRINT_FIXED_COST,
        "customized": stored is not None,
    }


@app.put("/api/settings/resin-price")
def update_resin_price(payload: dict):
    try:
        price = float(payload.get("pricePerLiter"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid price")
    if price <= 0 or price > 100000:
        raise HTTPException(status_code=400, detail="Price out of range")

    set_setting("resin_price_per_liter", str(price))

    # Recompute stored costs for every processed model with the new price:
    # cost = volume_ml * (R$/L / 1000) + fixed
    price_per_ml = price / 1000.0
    conn = get_db_conn()
    conn.execute(
        """UPDATE models SET estimated_cost = round(volume_ml * ? + ?, 2)
           WHERE volume_ml IS NOT NULL AND proxy_status = 'done'""",
        (price_per_ml, mesh_service.PRINT_FIXED_COST),
    )
    conn.commit()
    conn.close()
    return {
        "pricePerLiter": price,
        "fixedCost": mesh_service.PRINT_FIXED_COST,
        "customized": True,
    }


@app.get("/api/settings/makerworld-token")
def makerworld_token_status():
    return {"configured": bool(get_setting("makerworld_bambu_token"))}


@app.put("/api/settings/makerworld-token")
def update_makerworld_token(payload: dict):
    if payload.get("clear") is True:
        clear_setting("makerworld_bambu_token")
        return {"configured": False}

    token = str(payload.get("token", "")).strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token is required")

    set_setting("makerworld_bambu_token", token)
    return {"configured": True}


## MODEL IMPORTS
@app.post("/api/import/importid")
def import_model_by_id(payload: dict):
    source = payload.get("source", "printables")
    importer, source_label = importer_for_source(source)
    modelId = payload.get("id")
    modelName = payload.get("name")
    parentId = payload.get("parentId")
    previewPath = payload.get("previewPath")
    folderId = payload.get("folderId", "1")
    typeName = payload.get("typeName")
    mid = str(uuid.uuid4())
    
    # we only save stl for now
    ext = typeName if typeName is not None else ".stl"
    
    filename = f"{mid}.{ext}"
    path = os.path.join(UPLOAD_DIR, filename)

    # Check if url is not None before calling importer
    try:
        if modelId is not None:
            file, thumbnail = importer.importfromId(modelId, parentId, previewPath)
            if file is not None:
                with open(path, "wb") as fh:
                    fh.write(file.content)
                size = os.path.getsize(path)
            else:
                raise ValueError("File Is Empty")
        else:
            raise ValueError("URL is None")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    model = {
        "id": mid,
        "name": modelName,
        "folderId": folderId if folderId != "all" else "1",
        "url": f"/api/models/{mid}/download",
        "size": size,
        "dateAdded": now_ms(),
        "tags": ["imported"],
        "description": f"Imported from {source_label}",
        "thumbnail": thumbnail
    }

    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO models(id,name,folderId,url,size,dateAdded,tags,description,thumbnail) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            model["id"],
            model["name"],
            model["folderId"],
            model["url"],
            model["size"],
            model["dateAdded"],
            json.dumps(model["tags"]),
            model["description"],
            model["thumbnail"],
        ),
    )
    conn.commit()
    conn.close()
    queue_mesh_processing(mid)
    return model


@app.post("/api/import/options")
def import_model_options(payload: dict):
    url = payload.get("url")

    # Check if url is not None before calling importer
    try:
        if url is not None:
            importer, _source_label = importer_for_url(url)
            modelData = importer.getModelOptions(url)
            if modelData is not None:
                return modelData
            raise ValueError("Collection Is Empty")
        raise ValueError("URL is None")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


## PRINTABLES IMPORTS - compatibility aliases
@app.post("/api/printables/importid")
def import_printables_model_by_id(payload: dict):
    payload["source"] = "printables"
    return import_model_by_id(payload)


@app.post("/api/printables/options")
def import_printables_model_options(payload: dict):
    return import_model_options(payload)


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "printflow3d"}


# Backfill: process every model that predates the mesh pipeline (or was
# left pending by a restart). Runs in a daemon thread so it never blocks
# startup or the healthcheck.
mesh_service.backfill(
    update_model_mesh_fields, list_pending_mesh_ids, get_price=current_resin_price
)


# --- Static frontend (SPA) ---
# In the all-in-one production image the compiled Vite build is served from
# STATIC_DIR. API routes under /api are registered above and take precedence;
# the mount below catches everything else, and the 404 handler falls back to
# index.html so client-side routes added later (e.g. a /kanban page) work.
@app.exception_handler(404)
async def spa_fallback(request: Request, exc: HTTPException):
    index = STATIC_DIR / "index.html" if STATIC_DIR else None
    if index is not None and index.exists() and not request.url.path.startswith(
        "/api"
    ):
        return FileResponse(index)
    detail = getattr(exc, "detail", "Not Found")
    return JSONResponse({"detail": detail}, status_code=404)


if STATIC_DIR and STATIC_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="webui")


if __name__ == "__main__":
    import uvicorn
    
    # Ensure upload directory exists
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    
    port = int(os.getenv("PORT", "5173"))
    
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info"
    )
