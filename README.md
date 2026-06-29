# VPSphere ⚡

A lightweight, self-hosted VPS management dashboard with a clean UI — file manager, web terminal, and server monitoring.

## Features

- **Dashboard** — Live CPU, RAM, Disk, Network stats with gauges
- **File Manager** — Browse, upload, download, rename, delete, create folders, edit text files
- **Web Terminal** — Full xterm.js shell via WebSocket (bash)
- **Auth** — Simple password login with JWT tokens
- **Docker** — One-command deploy alongside Coolify or any other services

## Deploy

```bash
# 1. Clone on your VPS
cd /opt
git clone <repo> vpsphere
cd vpsphere

# 2. Set your password
cp .env.example .env
nano .env  # Change VPSPHERE_PASSWORD

# 3. Launch
docker compose up -d

# 4. Access at http://your-vps-ip:8080
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python FastAPI |
| Terminal | xterm.js + WebSocket + PTY |
| Frontend | Vanilla HTML/CSS/JS (no build step) |
| Auth | JWT (python-jose) |
| Stats | psutil |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VPSPHERE_PASSWORD` | `admin` | Login password |
| `VPSPHERE_SECRET` | auto | JWT signing secret |
| `VPSPHERE_ROOT` | `/` | Root directory for file browser |
| `VPSPHERE_EXPIRY` | `24` | Session expiry in hours |
| `VPSPHERE_PORT` | `8080` | Port to expose |

## Development

```bash
pip install -r requirements.txt
VPSPHERE_PASSWORD=dev python -m uvicorn main:app --reload
```
