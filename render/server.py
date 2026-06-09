#!/usr/bin/env python3
"""
Tweenforge render service.

Exposes the render engine over HTTP so the dashboard can trigger a video:
  POST /render        body = a Tweenforge manifest  -> { job_id }
  GET  /status/{id}   -> { status: queued|rendering|done|error, ... }
  GET  /video/{id}    -> the finished MP4
  GET  /health        -> { ok: true }

Run:  uvicorn server:app --host 0.0.0.0 --port 8080
"""
import os, json, subprocess, threading, uuid
from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Tweenforge Render")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("TF_OUT", os.path.join(HERE, "renders"))
VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", os.path.join(HERE, "..", "voices"))
CLONES_DIR = os.path.join(VOICES_DIR, "clones")
for d in (OUT_DIR, VOICES_DIR, CLONES_DIR):
    os.makedirs(d, exist_ok=True)
JOBS = {}

# A small starter catalog of openly-available Piper voices the UI can offer
# even before any are installed on disk.
CATALOG = [
    {"id": "en_US-amy-medium", "label": "Amy — US English (medium)"},
    {"id": "en_US-ryan-high", "label": "Ryan — US English (high)"},
    {"id": "en_US-lessac-high", "label": "Lessac — US English (high)"},
    {"id": "en_GB-alba-medium", "label": "Alba — UK English (medium)"},
    {"id": "en_US-hfc_female-medium", "label": "HFC Female — US English"},
]


@app.get("/voices")
def voices():
    """What the dropdown shows: voices installed on disk + cloned voices + catalog."""
    installed = []
    if os.path.isdir(VOICES_DIR):
        for f in sorted(os.listdir(VOICES_DIR)):
            if f.endswith(".onnx"):
                vid = f[:-5]
                installed.append({"id": vid, "label": vid, "kind": "piper"})
    clones = []
    if os.path.isdir(CLONES_DIR):
        for f in sorted(os.listdir(CLONES_DIR)):
            if f.endswith(".wav"):
                name = f[:-4]
                clones.append({"id": "clone:" + name, "label": name + " (cloned)", "kind": "clone"})
    return {"installed": installed, "clones": clones, "catalog": CATALOG}


@app.post("/voices/clone")
async def clone_voice(name: str = Form(...), sample: UploadFile = File(...)):
    """Store a reference clip as a cloned voice. Synthesis happens at render time
    via the cloning engine (XTTS) if installed; otherwise it falls back."""
    safe = "".join(c for c in name if c.isalnum() or c in "-_").strip("-_") or "voice"
    raw = os.path.join(CLONES_DIR, "_in_" + safe)
    dest = os.path.join(CLONES_DIR, safe + ".wav")
    with open(raw, "wb") as f:
        f.write(await sample.read())
    # normalise to 22.05k mono wav
    r = subprocess.run(["ffmpeg", "-y", "-i", raw, "-ar", "22050", "-ac", "1", dest],
                       stderr=subprocess.PIPE)
    try:
        os.remove(raw)
    except OSError:
        pass
    if r.returncode != 0 or not os.path.exists(dest):
        return JSONResponse({"error": "could not read that audio file"}, status_code=400)
    return {"id": "clone:" + safe, "label": safe + " (cloned)", "kind": "clone"}


def do_render(job_id, manifest):
    try:
        JOBS[job_id]["status"] = "rendering"
        mpath = os.path.join(OUT_DIR, f"{job_id}.json")
        out = os.path.join(OUT_DIR, f"{job_id}.mp4")
        with open(mpath, "w") as f:
            json.dump(manifest, f)
        subprocess.run(["python3", os.path.join(HERE, "render.py"), mpath, out],
                       check=True)
        JOBS[job_id].update(status="done", file=out)
    except Exception as e:
        JOBS[job_id].update(status="error", error=str(e))


@app.post("/render")
async def render(req: Request):
    manifest = await req.json()
    if not manifest.get("scenes"):
        return JSONResponse({"error": "manifest has no scenes"}, status_code=400)
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"status": "queued", "scenes": len(manifest["scenes"])}
    threading.Thread(target=do_render, args=(job_id, manifest), daemon=True).start()
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def status(job_id):
    return JOBS.get(job_id, {"status": "unknown"})


@app.get("/video/{job_id}")
def video(job_id):
    j = JOBS.get(job_id)
    if not j or j.get("status") != "done":
        return JSONResponse({"error": "not ready"}, status_code=404)
    return FileResponse(j["file"], media_type="video/mp4", filename="tweenforge.mp4")


@app.get("/health")
def health():
    return {"ok": True}
