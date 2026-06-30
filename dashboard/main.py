import os
import json
import asyncio
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from lib.config_model import OpenMontageConfig
from lib.pipeline_loader import list_pipelines, load_pipeline
from lib.checkpoint import (
    read_checkpoint,
    get_pipeline_stages,
    get_completed_stages,
    get_next_stage,
    CANONICAL_STAGE_ARTIFACTS,
)
from tools.tool_registry import registry

app = FastAPI(title="OpenMontage Dashboard API")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG = OpenMontageConfig.load()
PIPELINE_DIR = CONFIG.resolve_path("pipeline_dir")

# Helper to find env file
ENV_PATH = ROOT_DIR / ".env"
ENV_EXAMPLE_PATH = ROOT_DIR / ".env.example"

# --- API Endpoints ---

@app.get("/api/status")
async def get_system_status():
    """Check availability of system dependencies (Node, FFmpeg, Python)."""
    import shutil
    has_node = shutil.which("node") is not None
    has_ffmpeg = shutil.which("ffmpeg") is not None
    
    # Discover registry to see available/unavailable providers
    registry.discover()
    menu_summary = registry.provider_menu_summary()
    
    # Try checking budget
    budget_limit = 10.0
    budget_spent = 0.0
    budget_file = PIPELINE_DIR / "cost_log.json"
    if budget_file.exists():
        try:
            with open(budget_file) as f:
                cost_log = json.load(f)
                budget_spent = cost_log.get("total_spent_usd", 0.0)
        except Exception:
            pass
            
    try:
        budget_limit = CONFIG.budget.total_usd
    except Exception:
        pass

    return {
        "runtimes": {
            "node": has_node,
            "ffmpeg": has_ffmpeg,
            "python": True,
            "hyperframes": menu_summary.get("composition_runtimes", {}).get("hyperframes", False),
            "remotion": menu_summary.get("composition_runtimes", {}).get("remotion", False),
        },
        "budget": {
            "limit": budget_limit,
            "spent": budget_spent,
            "mode": CONFIG.budget.mode,
        }
    }

@app.get("/api/pipelines")
async def get_pipelines():
    """List all available pipeline manifests with descriptions."""
    pipelines = []
    for name in list_pipelines():
        try:
            manifest = load_pipeline(name)
            pipelines.append({
                "name": name,
                "title": manifest.get("name", name),
                "description": manifest.get("description", "No description provided."),
                "stages": [s["name"] for s in manifest.get("stages", [])],
                "playbooks": manifest.get("playbooks", []),
            })
        except Exception as e:
            continue
    return pipelines

@app.get("/api/projects")
async def get_projects():
    """List all project folders inside the pipeline directory with status."""
    if not PIPELINE_DIR.exists():
        return []
    
    projects = []
    for path in PIPELINE_DIR.iterdir():
        # Exclude hidden folders and files
        if not path.is_dir() or path.name.startswith("."):
            continue
        
        # Check checkpoints to determine status
        project_id = path.name
        completed = get_completed_stages(PIPELINE_DIR, project_id)
        next_stage = get_next_stage(PIPELINE_DIR, project_id)
        
        # Check latest checkpoint file by modified time
        latest_cp = None
        latest_time = None
        for cp_file in path.glob("checkpoint_*.json"):
            mtime = cp_file.stat().st_mtime
            if latest_time is None or mtime > latest_time:
                latest_time = mtime
                try:
                    with open(cp_file) as f:
                        latest_cp = json.load(f)
                except Exception:
                    pass
        
        pipeline_type = "unknown"
        status = "new"
        timestamp = ""
        
        if latest_cp:
            pipeline_type = latest_cp.get("pipeline_type", "unknown")
            status = latest_cp.get("status", "in_progress")
            timestamp = latest_cp.get("timestamp", "")
            
        projects.append({
            "project_id": project_id,
            "pipeline_type": pipeline_type,
            "status": status,
            "last_updated": timestamp,
            "completed_stages": completed,
            "next_stage": next_stage,
        })
        
    # Sort by last updated timestamp descending
    projects.sort(key=lambda x: x["last_updated"], reverse=True)
    return projects

@app.get("/api/projects/{project_id}")
async def get_project_details(project_id: str):
    """Retrieve full detail checklist, checkpoints, and files for a project."""
    project_dir = PIPELINE_DIR / project_id
    if not project_dir.exists() or not project_dir.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Read all checkpoint files
    checkpoints = {}
    for cp_file in project_dir.glob("checkpoint_*.json"):
        stage_name = cp_file.stem.replace("checkpoint_", "")
        try:
            with open(cp_file) as f:
                checkpoints[stage_name] = json.load(f)
        except Exception:
            pass
            
    # Read decision log
    decision_log = None
    dec_log_path = project_dir / "decision_log.json"
    if dec_log_path.exists():
        try:
            with open(dec_log_path) as f:
                decision_log = json.load(f)
        except Exception:
            pass
            
    # Read cost log if available
    cost_log = None
    cost_log_path = project_dir / "cost_log.json"
    if cost_log_path.exists():
        try:
            with open(cost_log_path) as f:
                cost_log = json.load(f)
        except Exception:
            pass

    # Discover generated assets and renders in project folder
    files = []
    for root, _, filenames in os.walk(project_dir):
        for f in filenames:
            if f.startswith(".") or f.endswith(".json"):
                continue
            full_path = Path(root) / f
            rel_path = full_path.relative_to(project_dir)
            files.append({
                "name": f,
                "rel_path": str(rel_path),
                "size": full_path.stat().st_size,
                "type": f.split(".")[-1].lower() if "." in f else "unknown"
            })

    return {
        "project_id": project_id,
        "checkpoints": checkpoints,
        "decision_log": decision_log,
        "cost_log": cost_log,
        "files": files,
    }

@app.post("/api/projects")
async def create_project(data: Dict[str, Any]):
    """Initialize a new project folder and create a research/idea stage checkpoint."""
    project_id = data.get("project_id")
    pipeline_type = data.get("pipeline_type")
    style_playbook = data.get("style_playbook", "clean-professional")
    brief_prompt = data.get("prompt", "")
    
    if not project_id or not pipeline_type:
        raise HTTPException(status_code=400, detail="project_id and pipeline_type are required")
    
    # Safe project ID styling
    project_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_id.lower())
    project_dir = PIPELINE_DIR / project_id
    if project_dir.exists():
        raise HTTPException(status_code=409, detail="Project already exists")
        
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "artifacts").mkdir(exist_ok=True)
    (project_dir / "assets" / "images").mkdir(parents=True, exist_ok=True)
    (project_dir / "assets" / "video").mkdir(parents=True, exist_ok=True)
    (project_dir / "assets" / "audio").mkdir(parents=True, exist_ok=True)
    (project_dir / "renders").mkdir(exist_ok=True)
    
    # Create the initial brief artifact
    brief_data = {
        "version": "1.0",
        "title": data.get("title") or project_id.replace("-", " ").title(),
        "prompt": brief_prompt,
        "target_platform": data.get("target_platform", "youtube"),
        "target_duration_seconds": data.get("duration", 60),
        "tone": data.get("tone", "professional"),
        "playbook": style_playbook,
    }
    
    # Write the artifact file
    with open(project_dir / "artifacts" / "brief.json", "w") as f:
        json.dump(brief_data, f, indent=2)
        
    # Resolve first stage of the pipeline dynamically
    stages = get_pipeline_stages(pipeline_type)
    first_stage = stages[0] if stages else "idea"
    
    # Write the initial checkpoint as in_progress for the first stage of the pipeline
    from lib.checkpoint import write_checkpoint
    write_checkpoint(
        PIPELINE_DIR,
        project_id,
        stage=first_stage,
        status="in_progress",
        artifacts={},
        pipeline_type=pipeline_type,
        style_playbook=style_playbook,
    )
    
    return {"status": "created", "project_id": project_id}

@app.get("/api/registry")
async def get_registry():
    """Discover and return all registered capabilities and tools."""
    registry.discover()
    return {
        "summary": registry.provider_menu_summary(),
        "capabilities": registry.capability_catalog(),
        "providers": registry.provider_catalog(),
    }

@app.get("/api/settings")
async def get_settings():
    """Read the key environment variables from .env / .env.example."""
    # Find all possible keys from .env.example
    keys = {}
    if ENV_EXAMPLE_PATH.exists():
        with open(ENV_EXAMPLE_PATH) as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k = line.split("=")[0].strip()
                    keys[k] = ""
                    
    # Overlay with actual values in .env
    if ENV_PATH.exists():
        with open(ENV_PATH) as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k, _, v = line.partition("=")
                    k = k.strip()
                    v = v.strip()
                    # Strip quotes/comments
                    if v.startswith(("'", '"')) and len(v) > 1:
                        v = v[1:-1]
                    if " #" in v:
                        v = v.split(" #")[0].strip()
                    elif v.startswith("#"):
                        v = ""
                    if k in keys or k:
                        keys[k] = v
                        
    return keys

@app.post("/api/settings")
async def update_settings(settings: Dict[str, str]):
    """Update keys in the .env file."""
    # Read existing file content to preserve comments
    lines = []
    existing_keys = set()
    
    if ENV_PATH.exists():
        with open(ENV_PATH) as f:
            lines = f.readlines()
            
    # Parse existing keys
    for line in lines:
        if "=" in line and not line.strip().startswith("#"):
            existing_keys.add(line.split("=")[0].strip())
            
    # Update existing lines
    new_lines = []
    for line in lines:
        if "=" in line and not line.strip().startswith("#"):
            k, _, comment = line.partition("=")
            k = k.strip()
            if k in settings:
                # Retain inline comment if present
                c_part = ""
                if "#" in comment:
                    c_part = "  #" + comment.split("#", 1)[1].rstrip()
                new_lines.append(f"{k}={settings[k]}{c_part}\n")
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)
            
    # Append any brand new keys
    for k, v in settings.items():
        if k not in existing_keys:
            new_lines.append(f"{k}={v}\n")
            
    # Write back to .env
    with open(ENV_PATH, "w") as f:
        f.writelines(new_lines)
        
    return {"status": "saved"}

@app.get("/api/demos")
async def get_demos():
    """List zero-key Remotion demos that can be rendered."""
    props_dir = ROOT_DIR / "remotion-composer" / "public" / "demo-props"
    if not props_dir.exists():
        return []
        
    demos = []
    demo_descriptions = {
        "world-in-numbers": "Global scale story with titles, stats, and charts",
        "code-to-screen": "Developer workflow explainer with comparison and KPI cards",
        "focusflow-pitch": "Startup-style pitch built only from Remotion components",
    }
    
    for path in sorted(props_dir.glob("*.json")):
        name = path.stem
        demos.append({
            "name": name,
            "description": demo_descriptions.get(name, "Checked-in Remotion demo"),
            "file_path": str(path),
            "rendered": (ROOT_DIR / "projects" / "demos" / "renders" / f"{name}.mp4").exists(),
        })
    return demos

# --- Media Serving Endpoints ---

@app.get("/api/media/demo/{demo_name}")
async def serve_demo_render(demo_name: str):
    """Serve a rendered demo MP4 file."""
    video_path = ROOT_DIR / "projects" / "demos" / "renders" / f"{demo_name}.mp4"
    if not video_path.exists():
         # Check if it was rendered with fallback path
         alt_path = ROOT_DIR / "remotion-composer" / "out" / f"{demo_name}.mp4"
         if alt_path.exists():
             video_path = alt_path
         else:
             raise HTTPException(status_code=404, detail="Demo video not rendered yet")
    return FileResponse(video_path, media_type="video/mp4")

@app.get("/api/media/project/{project_id}/{filepath:path}")
async def serve_project_media(project_id: str, filepath: str):
    """Serve any media file from a project workspace safely."""
    # Prevent directory traversal
    project_dir = (PIPELINE_DIR / project_id).resolve()
    target_path = (project_dir / filepath).resolve()
    
    if not target_path.exists() or not target_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
        
    if not str(target_path).startswith(str(project_dir)):
        raise HTTPException(status_code=403, detail="Access denied")
        
    suffix = target_path.suffix.lower()
    media_types = {
        ".mp4": "video/mp4",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".srt": "text/plain",
    }
    
    return FileResponse(target_path, media_type=media_types.get(suffix, "application/octet-stream"))

# --- WebSocket Logs Streaming ---

@app.websocket("/ws/render/{demo_name}")
async def websocket_render_demo(websocket: WebSocket, demo_name: str):
    """Start rendering a demo video and stream terminal output live."""
    await websocket.accept()
    
    # Check if demo exists
    props_path = ROOT_DIR / "remotion-composer" / "public" / "demo-props" / f"{demo_name}.json"
    if not props_path.exists():
        await websocket.send_text(f"Error: Demo '{demo_name}' not found.")
        await websocket.close()
        return
        
    try:
        await websocket.send_text(f"Initializing render environment for '{demo_name}'...")
        
        # Start subprocess to run render_demo.py
        # Use sys.executable to run with the current python interpreter
        import sys
        cmd = [sys.executable, str(ROOT_DIR / "render_demo.py"), demo_name]
        
        await websocket.send_text(f"Running command: {' '.join(cmd)}")
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(ROOT_DIR),
        )
        
        # Stream output line by line
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="ignore").rstrip()
            await websocket.send_text(text)
            # Yield control to event loop
            await asyncio.sleep(0.001)
            
        await process.wait()
        
        if process.returncode == 0:
            await websocket.send_text("RENDER_COMPLETE")
        else:
            await websocket.send_text(f"RENDER_FAILED with exit code {process.returncode}")
            
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(f"Error running render: {str(e)}")
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

# Serve static files from dashboard/static
static_dir = Path(__file__).resolve().parent / "static"
static_dir.mkdir(exist_ok=True)

# Main entrypoint: Serve index.html at root "/"
@app.get("/", response_class=HTMLResponse)
async def serve_root():
    index_file = static_dir / "index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>Dashboard Static Files Missing</h1><p>Creating template files...</p>")
    with open(index_file) as f:
        return f.read()

app.mount("/", StaticFiles(directory=str(static_dir)), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
