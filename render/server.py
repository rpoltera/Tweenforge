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
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Tweenforge Render")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("TF_OUT", os.path.join(HERE, "renders"))
os.makedirs(OUT_DIR, exist_ok=True)
JOBS = {}


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
