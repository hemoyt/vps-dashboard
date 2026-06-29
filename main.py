import os
import sys
import json
import shutil
import hashlib
import secrets
import subprocess
import mimetypes
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
import asyncio
import struct
import fcntl
import termios
import pty
import signal

from fastapi import (
    FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect,
    UploadFile, File, Form, Query, Depends
)
from fastapi.responses import (
    FileResponse, JSONResponse, HTMLResponse, StreamingResponse
)
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
import psutil

# ─── Config ───────────────────────────────────────────────────
APP_PASSWORD = os.getenv("VPSPHERE_PASSWORD", "admin")
JWT_SECRET = os.getenv("VPSPHERE_SECRET", secrets.token_hex(32))
JWT_EXPIRY_HOURS = int(os.getenv("VPSPHERE_EXPIRY", "24"))
ROOT_DIR = Path(os.getenv("VPSPHERE_ROOT", "/"))
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="VPSphere", docs_url=None, redoc_url=None)

# ─── Auth ─────────────────────────────────────────────────────
security = HTTPBearer(auto_error=False)

def create_token() -> str:
    payload = {
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_token(token: str) -> bool:
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return True
    except JWTError:
        return False

async def require_auth(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
):
    """Check either cookie or Authorization header."""
    token = None
    if credentials:
        token = credentials.credentials
    else:
        token = request.cookies.get("vpsphere_token")
    if not token or not verify_token(token):
        if "application/json" in request.headers.get("accept", ""):
            raise HTTPException(status_code=401, detail="Unauthorized")
    return token

# ─── Auth Routes ──────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(request: Request):
    data = await request.json()
    password = data.get("password", "")
    if password == APP_PASSWORD:
        token = create_token()
        resp = JSONResponse({"ok": True, "token": token})
        resp.set_cookie(
            key="vpsphere_token", value=token,
            httponly=True, samesite="lax", max_age=JWT_EXPIRY_HOURS * 3600
        )
        return resp
    raise HTTPException(status_code=401, detail="Invalid password")

@app.post("/api/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("vpsphere_token")
    return resp

@app.get("/api/auth/check")
async def check_auth(token: str = Depends(require_auth)):
    return {"ok": True}

# ─── System Stats ─────────────────────────────────────────────
@app.get("/api/stats")
async def system_stats(token: str = Depends(require_auth)):
    cpu_percent = psutil.cpu_percent(interval=0.3)
    cpu_count = psutil.cpu_count()

    mem = psutil.virtual_memory()
    # Use the root dir for disk stats (handles Docker host mount)
    disk_path = str(ROOT_DIR) if ROOT_DIR.exists() else "/"
    disk = psutil.disk_usage(disk_path)

    load = os.getloadavg()

    boot = datetime.fromtimestamp(psutil.boot_time(), tz=timezone.utc)
    uptime_seconds = (datetime.now(timezone.utc) - boot).total_seconds()

    net = None
    try:
        net = psutil.net_io_counters()
    except Exception:
        pass

    return {
        "cpu": {
            "percent": round(cpu_percent, 1),
            "cores": cpu_count,
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "free": mem.available,
            "percent": mem.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "load": [round(l, 2) for l in load],
        "uptime": int(uptime_seconds),
        "network": {
            "sent": net.bytes_sent if net else 0,
            "recv": net.bytes_recv if net else 0,
        },
        "hostname": os.uname().nodename,
        "os": f"{os.uname().sysname} {os.uname().release}",
    }

# ─── File Manager ─────────────────────────────────────────────
def safe_path(requested_path: str) -> Path:
    """Resolve and validate a path is within ROOT_DIR."""
    p = (ROOT_DIR / requested_path.lstrip("/")).resolve()
    if not str(p).startswith(str(ROOT_DIR.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    return p

@app.get("/api/files")
async def list_files(
    path: str = Query("/"),
    token: str = Depends(require_auth),
):
    try:
        target = safe_path(path)
        if not target.exists():
            raise HTTPException(status_code=404, detail="Path not found")
        if not target.is_dir():
            raise HTTPException(status_code=400, detail="Not a directory")

        items = []
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            try:
                stat = entry.stat()
            except PermissionError:
                continue
            item = {
                "name": entry.name,
                "type": "dir" if entry.is_dir() else "file",
                "size": stat.st_size if entry.is_file() else 0,
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "permissions": oct(stat.st_mode)[-3:],
            }
            # Symlink info
            if entry.is_symlink():
                item["type"] = "link"
                item["target"] = str(entry.readlink())
            items.append(item)

        return {
            "path": str(target.relative_to(ROOT_DIR)) if target != ROOT_DIR else "/",
            "items": items,
        }
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

@app.get("/api/files/download")
async def download_file(
    path: str = Query(...),
    token: str = Depends(require_auth),
):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    mime_type, _ = mimetypes.guess_type(str(target))
    return FileResponse(
        path=str(target),
        filename=target.name,
        media_type=mime_type or "application/octet-stream",
    )

@app.post("/api/files/upload")
async def upload_file(
    path: str = Form("/"),
    files: list[UploadFile] = File(...),
    token: str = Depends(require_auth),
):
    target_dir = safe_path(path)
    if not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="Target is not a directory")

    uploaded = []
    for f in files:
        dest = target_dir / f.filename
        content = await f.read()
        dest.write_bytes(content)
        uploaded.append(f.filename)

    return {"ok": True, "uploaded": uploaded}

@app.post("/api/files/mkdir")
async def create_directory(
    request: Request,
    token: str = Depends(require_auth),
):
    data = await request.json()
    path = data.get("path", "/")
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    parent = safe_path(path)
    new_dir = parent / name
    if new_dir.exists():
        raise HTTPException(status_code=409, detail="Already exists")
    new_dir.mkdir(parents=True)
    return {"ok": True}

@app.post("/api/files/rename")
async def rename_file(
    request: Request,
    token: str = Depends(require_auth),
):
    data = await request.json()
    old_path = data.get("path", "")
    new_name = data.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="New name required")

    src = safe_path(old_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Not found")

    dst = src.parent / new_name
    if dst.exists():
        raise HTTPException(status_code=409, detail=f"'{new_name}' already exists")

    src.rename(dst)
    return {"ok": True}

@app.delete("/api/files")
async def delete_file(
    path: str = Query(...),
    token: str = Depends(require_auth),
):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")

    if target.is_dir():
        shutil.rmtree(str(target))
    else:
        target.unlink()
    return {"ok": True}

@app.get("/api/files/read")
async def read_file_content(
    path: str = Query(...),
    token: str = Depends(require_auth),
):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    size = target.stat().st_size
    if size > 5 * 1024 * 1024:  # 5MB limit
        raise HTTPException(status_code=413, detail="File too large to edit (>5MB)")

    try:
        content = target.read_text()
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Binary file cannot be displayed as text")

    return {
        "path": str(target.relative_to(ROOT_DIR)),
        "content": content,
        "size": size,
        "lines": content.count("\n") + 1,
    }

@app.post("/api/files/write")
async def write_file_content(
    request: Request,
    token: str = Depends(require_auth),
):
    data = await request.json()
    file_path = data.get("path", "")
    content = data.get("content", "")

    target = safe_path(file_path)
    target.write_text(content)
    return {"ok": True}

@app.get("/api/files/search")
async def search_files(
    path: str = Query("/"),
    q: str = Query(...),
    token: str = Depends(require_auth),
):
    target = safe_path(path)
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    query_lower = q.lower()
    results = []
    for entry in target.rglob("*"):
        if query_lower in entry.name.lower():
            try:
                stat = entry.stat()
                results.append({
                    "name": entry.name,
                    "path": str(entry.relative_to(ROOT_DIR)),
                    "type": "dir" if entry.is_dir() else "file",
                    "size": stat.st_size if entry.is_file() else 0,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                })
            except (PermissionError, OSError):
                continue
        if len(results) >= 200:
            break

    return {"results": results}

# ─── Terminal WebSocket ───────────────────────────────────────
@app.websocket("/api/terminal")
async def terminal_ws(websocket: WebSocket):
    # Check auth from query param or cookie
    token = websocket.query_params.get("token", "")
    # Try cookie approach — read first message as auth
    await websocket.accept()

    authenticated = False
    try:
        # First message must be auth JSON
        msg = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        data = json.loads(msg)
        if data.get("type") == "auth":
            t = data.get("token", "")
            if verify_token(t):
                authenticated = True
            else:
                await websocket.send_text(json.dumps({"type": "error", "msg": "Invalid token"}))
                await websocket.close()
                return
        elif verify_token(token):
            authenticated = True
        else:
            await websocket.send_text(json.dumps({"type": "error", "msg": "Authentication required"}))
            await websocket.close()
            return
    except (asyncio.TimeoutError, json.JSONDecodeError):
        if verify_token(token):
            authenticated = True
        else:
            await websocket.send_text(json.dumps({"type": "error", "msg": "Authentication timeout"}))
            await websocket.close()
            return

    if not authenticated:
        await websocket.close()
        return

    # Spawn shell
    pid, fd = pty.fork()
    if pid == 0:  # Child
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["HOME"] = str(Path.home())
        env["SHELL"] = "/bin/bash"
        os.chdir(str(Path.home()))
        os.execvpe("/bin/bash", ["/bin/bash"], env)

    # Set terminal size
    cols, rows = 120, 40

    async def set_winsize(fd, cols, rows):
        try:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        except Exception:
            pass

    async def reader():
        loop = asyncio.get_event_loop()
        while True:
            try:
                data = await loop.run_in_executor(None, os.read, fd, 4096)
                if not data:
                    break
                await websocket.send_bytes(data)
            except Exception:
                break

    reader_task = asyncio.create_task(reader())

    try:
        while True:
            msg = await websocket.receive_text()
            data = json.loads(msg)

            if data.get("type") == "resize":
                cols = data.get("cols", 120)
                rows = data.get("rows", 40)
                await set_winsize(fd, cols, rows)
            elif data.get("type") == "input":
                inp = data.get("data", "")
                os.write(fd, inp.encode())
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        reader_task.cancel()
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass

# ─── Static Files ─────────────────────────────────────────────
@app.get("/")
async def serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))

# Mount static after route definitions
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=False), name="static")
