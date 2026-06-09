<p align="center">
  <img src="assets/tweenforge-banner.png" alt="Tweenforge" width="720">
</p>

<p align="center">
  <em>Self-hosted studio for automated, faceless 2D-animated explainer videos — plan, review, and render.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-8c9bf0?style=flat-square&logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Vite-5-f2b450?style=flat-square&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/render-FastAPI%20%2B%20ffmpeg-8c9bf0?style=flat-square&logo=python&logoColor=white" alt="Render engine">
  <img src="https://img.shields.io/badge/deploy-Proxmox%20LXC-c9c2d8?style=flat-square" alt="Proxmox LXC">
  <img src="https://img.shields.io/badge/license-MIT-7fd1a6?style=flat-square" alt="MIT">
</p>

---

Tweenforge is the control desk for a daily-video pipeline: you give it a theme or
a topic, set your style, characters, and voices, and it drafts a scene-by-scene
storyboard you review and flag. It then **renders the finished MP4** through a
small engine that ships with it — voiceover, per-scene visuals, motion, and
encoding — all on your own box.

Two parts, both in this repo:

- **Dashboard** (React/Vite) — the planning and review UI.
- **Render engine** (Python/FastAPI + ffmpeg) — turns the manifest into a video.

The dashboard talks to the render engine over HTTP, so they can live in the same
container (the default) or on separate machines.

---

## What it does

Five layers, top to bottom:

1. **Brief** — start from a recurring channel theme or a one-off topic.
2. **Variables** — visual style; recurring **characters** (each with a locked
   look spec, reference image, seed, and its **own voice**); time & place;
   duration; and the **narrator voice**. Voices are picked from a dropdown
   populated by the render engine, and you can **clone a new voice** from a short
   audio sample right here.
3. **Script** — generate narration and per-scene art prompts with an LLM, or
   **import** a script you already wrote. The generator also assigns a **speaker**
   to each scene (narrator or one of your characters).
4. **Storyboard** — every scene as a cel with its timecode and a **speaker**
   selector; flag changes per scene (regenerate art, rewrite line, retime, change
   motion) with notes.
5. **Handoff** — export a **manifest** (the full render spec, including the
   per-scene speaker and the voice map) and an **edits** list, then hit
   **Render video** to produce the MP4.

Pluggable model providers: OpenAI, Anthropic, **Ollama (local)**, OpenRouter, or
any OpenAI-compatible endpoint (vLLM, LM Studio, LocalAI). Pick one in **⚙ Settings**.

---

## Voices

- **Per-character + narrator.** The narrator and every character each have their
  own voice, chosen from a dropdown. Each scene's **speaker** decides which voice
  is used for that scene.
- **Engine: Piper.** Voices play through [Piper](https://github.com/rhasspy/piper),
  a fast, local, free neural TTS. A voice is a model file pair (`.onnx` +
  `.onnx.json`) you drop into `/opt/tweenforge/voices`; the dropdown lists whatever
  is installed there, plus a small starter catalog.
- **Cloning.** Piper itself can't clone — so the **Clone a voice** button uploads a
  short reference clip and synthesis is done by **XTTS** (Coqui `TTS`). Install
  `TTS` on the render box to enable it; until then, cloned voices fall back to the
  default voice rather than failing.
- **No voices installed yet?** Scenes still render — they just get a silent track
  sized to the scene's timing, so you always get a valid video.

---

## Deploy to a Proxmox LXC

The installer is **self-contained** — the entire app (dashboard + render engine)
is embedded inside it, so the only file the repo needs for deployment is
`install-tweenforge-lxc.sh`. On the Proxmox host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/rpoltera/Tweenforge/main/install-tweenforge-lxc.sh | bash
```

It runs straight through (non-interactive, locale generated up front — no prompts,
no stalls). It **auto-detects** your container storage, Debian template
(downloading one if needed), and network bridge; picks the next free container ID;
creates the LXC; installs Node 22, Python, and ffmpeg; unpacks and builds the
bundled app; and registers two systemd services:

- **tweenforge** — serves the dashboard on `:5173`
- **tweenforge-render** — the render engine on `:8080`

It prints the dashboard and render URLs when it finishes. Redeploying is the same
command after destroying the old container (`pct destroy <ctid> --force`).

---

## Connect a model

Click **⚙ Settings** in the top bar → **API & models**.

- **Fully local:** choose **Ollama**, set the base URL to your box
  (`http://<ollama-host>:11434/v1`) and a model you've pulled
  (`ollama pull qwen2.5:14b`). Start Ollama with `OLLAMA_ORIGINS="*"` on a trusted
  LAN if browser calls are blocked.
- **Hosted (OpenAI / Anthropic / OpenRouter):** browsers usually block direct
  calls (CORS) and a key in the page is exposed. Route these through a backend in
  production rather than calling them from the browser.

---

## Make a video

The render engine is installed alongside the dashboard. The dashboard
**auto-targets the render service on the same host** it was loaded from, so there's
nothing to configure — just open the Storyboard, approve, and click **Render
video** in Handoff. (If your engine runs elsewhere, set the **Render service URL**
in ⚙ Settings to override.)

The engine reads the manifest and produces an MP4: per scene it does voiceover
(Piper / XTTS, by speaker) → a visual → Ken Burns motion → then concatenates and
encodes with ffmpeg. Out of the box, visuals are clean on-brand typographic motion
cards, so you get a finished video immediately. Point it at a Stable Diffusion
endpoint (`SD_URL`) for AI art, and set `USE_NVENC=1` on a GPU-passthrough
container to encode on the P40s.

Render service endpoints: `POST /render`, `GET /status/{id}`, `GET /video/{id}`,
`GET /health`, `GET /voices`, `POST /voices/clone`.

---

## Where this fits the pipeline

```
Tweenforge dashboard (React)        Render engine (Python, this repo)
────────────────────────────       ──────────────────────────────────
brief + variables + voices         reads manifest →
  → script / storyboard              voiceover per scene (Piper / XTTS by speaker)
  → review + flags                   visual per scene (typographic card, or SD_URL)
  → manifest.json  ───────────►      Ken Burns motion
  → Render video   ───────────►      concat + ffmpeg encode (libx264 / h264_nvenc)
                                     → finished MP4
```

Still external (bring your own): thumbnail/metadata generation and YouTube upload.

---

## Quick start (development)

Requires **Node.js 18+** for the dashboard; Python 3 + ffmpeg for the render engine.

```bash
git clone https://github.com/rpoltera/Tweenforge.git
cd Tweenforge
npm install
npm run dev                     # dashboard at http://localhost:5173

pip install fastapi uvicorn pillow python-multipart
uvicorn server:app --app-dir render --host 0.0.0.0 --port 8080   # render engine
```

---

## Limits & notes

- Projects and provider settings live in the browser's `localStorage`, not on the
  server. Clearing site data wipes them.
- Real voices need Piper voice models in `/opt/tweenforge/voices`; cloning needs
  Coqui `TTS` (XTTS) on the render box. Check each voice's license before shipping
  a monetized channel — some Piper voices are research-only.
- For a monetizable channel, keep a human in the loop. Fully templated, fully
  automated daily uploads are the pattern platforms most aggressively penalize.

---

## License

MIT (suggested — set as you prefer).
