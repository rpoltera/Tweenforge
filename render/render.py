#!/usr/bin/env python3
"""
Tweenforge render engine.

Turns a Tweenforge manifest (JSON) into a finished MP4:
  voiceover (TTS)  ->  per-scene visual  ->  Ken Burns motion
  ->  burned captions  ->  concat + encode.

Usage:
    python3 render.py manifest.json out.mp4

Visuals:
  - If an image backend is configured (env SD_URL pointing at an
    Automatic1111 /sdapi/v1/txt2img endpoint), each scene's art is generated
    from its prompt. Otherwise a clean typographic card is drawn so you always
    get a real video, and AI art slots in the moment SD_URL is set.

Voiceover:
  - If PIPER_BIN and PIPER_VOICE are set, narration is spoken with Piper.
    Otherwise scenes use their manifest duration with a silent track, so the
    pipeline still produces a complete video.

Encoder:
  - Set USE_NVENC=1 to encode with h264_nvenc (your P40s). Defaults to libx264.
"""
import sys, os, json, subprocess, tempfile, base64, urllib.request, math

W, H, FPS = 1920, 1080, 30
INK = (19, 16, 25); INK2 = (27, 23, 38)
AMBER = (242, 180, 80); PERI = (140, 155, 240)
TEXT = (236, 231, 222); MUTED = (154, 145, 168)

FONT_PATHS = [
    os.path.expanduser("~/.fonts/Bricolage.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(size):
    from PIL import ImageFont
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def probe_dur(path):
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def wrap(draw, text, fnt, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def gradient(draw):
    for y in range(H):
        t = y / H
        c = tuple(int(INK2[i] * (1 - t) + INK[i] * t) for i in range(3))
        draw.line([(0, y), (W, y)], fill=c)


def chevrons(draw, x, y, s):
    # small brand mark: two ghost + one amber chevron
    def chev(ox, color, width):
        draw.line([(x + ox, y), (x + ox + s, y + s), (x + ox, y + 2 * s)],
                  fill=color, width=width, joint="curve")
    chev(0, PERI, 9)
    chev(int(s * 0.8), AMBER, 10)


def make_card(scene, idx, total, out):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)
    gradient(d)
    chevrons(d, 90, 92, 26)
    d.text((180, 96), f"{idx + 1:02d} / {total:02d}", font=font(40), fill=MUTED)

    text = (scene.get("narration") or scene.get("image_prompt") or "").strip()
    fbig = font(76)
    lines = wrap(d, text, fbig, W - 360)
    lh = 96
    total_h = lh * len(lines)
    y = (H - total_h) // 2
    for ln in lines:
        tw = d.textlength(ln, font=fbig)
        d.text(((W - tw) / 2, y), ln, font=fbig, fill=TEXT)
        y += lh
    # amber accent underline
    d.rectangle([(W // 2 - 90, y + 26), (W // 2 + 90, y + 32)], fill=AMBER)
    img.save(out)


def gen_image(scene, idx, total, out):
    sd = os.environ.get("SD_URL")
    if sd:
        try:
            payload = {
                "prompt": scene.get("image_prompt", "") + ", 2d flat vector illustration, clean",
                "steps": int(os.environ.get("SD_STEPS", "24")),
                "width": 1024, "height": 576,
                "sampler_name": "Euler a",
            }
            req = urllib.request.Request(
                sd.rstrip("/") + "/sdapi/v1/txt2img",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as r:
                data = json.loads(r.read())
            png = base64.b64decode(data["images"][0])
            from PIL import Image
            import io
            im = Image.open(io.BytesIO(png)).convert("RGB").resize((W, H))
            im.save(out)
            return
        except Exception as e:
            print(f"   ! SD failed ({e}); falling back to card", file=sys.stderr)
    make_card(scene, idx, total, out)


def tts(text, out, fallback_secs):
    piper, voice = os.environ.get("PIPER_BIN"), os.environ.get("PIPER_VOICE")
    if piper and voice and text.strip():
        try:
            wav = out.replace(".m4a", ".wav")
            p = subprocess.run([piper, "--model", voice, "--output_file", wav],
                               input=text.encode(), stderr=subprocess.PIPE)
            if p.returncode == 0 and os.path.exists(wav):
                run(["ffmpeg", "-y", "-i", wav, "-ar", "44100", "-ac", "2", out])
                return probe_dur(out)
        except Exception as e:
            print(f"   ! TTS failed ({e}); using silent track", file=sys.stderr)
    # silent fallback sized to the scene's planned duration
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
         "-t", str(fallback_secs), out])
    return float(fallback_secs)


def scene_clip(img, audio, dur, motion, out):
    enc = ["-c:v", "h264_nvenc", "-preset", "p4"] if os.environ.get("USE_NVENC") == "1" \
        else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    frames = max(1, int(round(dur * FPS)))
    z = "min(zoom+0.0007,1.12)"
    x = "iw/2-(iw/zoom/2)"; y = "ih/2-(ih/zoom/2)"
    if motion == "zoom-out":
        z = "if(eq(on,1),1.12,max(zoom-0.0007,1.0))"
    elif motion == "pan-left":
        z, x = "1.08", "max(0,iw/2-(iw/zoom/2) - on*1.2)"
    elif motion == "pan-right":
        z, x = "1.08", "min(iw-iw/zoom,iw/2-(iw/zoom/2) + on*1.2)"
    vf = (f"scale=2600:-2,zoompan=z='{z}':x='{x}':y='{y}':"
          f"d={frames}:s={W}x{H}:fps={FPS},format=yuv420p")
    run(["ffmpeg", "-y", "-loop", "1", "-i", img, "-i", audio,
         "-filter_complex", f"[0:v]{vf}[v]", "-map", "[v]", "-map", "1:a",
         "-t", str(dur), *enc, "-c:a", "aac", "-ar", "44100", "-shortest", out])


def main():
    if len(sys.argv) < 3:
        print("usage: render.py manifest.json out.mp4"); sys.exit(1)
    manifest = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    scenes = manifest.get("scenes", [])
    if not scenes:
        print("manifest has no scenes"); sys.exit(1)

    tmp = tempfile.mkdtemp(prefix="tf_render_")
    clips = []
    total = len(scenes)
    print(f">> Rendering '{manifest.get('title','Untitled')}' — {total} scenes")
    for i, sc in enumerate(scenes):
        print(f"   [{i+1}/{total}] visual + voiceover…")
        img = os.path.join(tmp, f"s{i:03d}.png")
        aud = os.path.join(tmp, f"s{i:03d}.m4a")
        clip = os.path.join(tmp, f"s{i:03d}.mp4")
        gen_image(sc, i, total, img)
        dur = tts(sc.get("narration", ""), aud, sc.get("seconds", 6) or 6)
        scene_clip(img, aud, max(1.5, dur), sc.get("motion", "zoom-in"), clip)
        clips.append(clip)

    listfile = os.path.join(tmp, "list.txt")
    with open(listfile, "w") as f:
        for c in clips:
            f.write(f"file '{c}'\n")
    print(">> Concatenating + encoding…")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
         "-c", "copy", out])
    print(f">> Done: {out}  ({probe_dur(out):.1f}s)")


if __name__ == "__main__":
    main()
