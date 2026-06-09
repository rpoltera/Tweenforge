import { useState, useEffect, useRef, useCallback } from "react";

/* ============================================================================
   CELS — a production desk for automated 2D animated explainers.
   One tool, four layers:
     1. Brief      — a theme or a general topic
     2. Variables  — style, characters, time & place, duration
     3. Storyboard — a generated scene plan you review and flag, with timecodes
     4. Handoff    — the manifest your render pipeline (P40s) consumes
   The scripting layer is live: it calls Claude to draft the scene plan.
============================================================================ */

const STORE_KEY = "cels:projects:v1";
const SETTINGS_KEY = "cels:settings:v1";

/* ---- AI providers. "preview" is the built-in in-chat proxy (no key, works here,
   capped ~1000 tokens). The rest you fill in for use on your server. ---- */
function defaultSettings() {
  return {
    active: "preview",
    renderUrl: "http://localhost:8080",
    providers: {
      preview:    { id: "preview",    label: "Claude — in-chat preview", kind: "anthropic-proxy", baseUrl: "", apiKey: "", model: "claude-sonnet-4-20250514" },
      openai:     { id: "openai",     label: "OpenAI",                    kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
      anthropic:  { id: "anthropic",  label: "Anthropic API",             kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", model: "claude-3-5-sonnet-latest" },
      ollama:     { id: "ollama",     label: "Ollama — local",            kind: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model: "qwen2.5:14b" },
      openrouter: { id: "openrouter", label: "OpenRouter",                kind: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "" },
      custom:     { id: "custom",     label: "Custom — OpenAI-compatible", kind: "openai", baseUrl: "", apiKey: "", model: "" },
    },
  };
}

const isPreview = (settings) => settings.active === "preview";

/* Route a prompt to the active provider and return plain text. */
async function callLLM(settings, prompt, opts = {}) {
  const p = settings.providers[settings.active];
  if (!p) throw new Error("No provider selected — open Settings.");
  const maxTokens = p.kind === "anthropic-proxy" ? 1000 : (opts.maxTokens || 4000);

  if (p.kind === "anthropic-proxy" || p.kind === "anthropic") {
    const url = (p.kind === "anthropic-proxy" ? "https://api.anthropic.com" : (p.baseUrl || "https://api.anthropic.com")).replace(/\/$/, "") + "/v1/messages";
    const headers = { "Content-Type": "application/json" };
    if (p.kind === "anthropic") {
      if (!p.apiKey) throw new Error("Add your Anthropic API key in Settings.");
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || "Provider error");
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  // OpenAI-compatible: OpenAI, Ollama, OpenRouter, custom
  if (!p.baseUrl) throw new Error("Set the base URL for this provider in Settings.");
  if (!p.model) throw new Error("Set the model name for this provider in Settings.");
  const headers = { "Content-Type": "application/json" };
  if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
  const body = { model: p.model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
  if (opts.json) body.response_format = { type: "json_object" };
  const resp = await fetch(p.baseUrl.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || "Provider error");
  return data.choices?.[0]?.message?.content || "";
}


const STYLE_PRESETS = [
  { id: "flat2d", label: "Flat 2D explainer", hint: "Kurzgesagt-style flat vector shapes, bold palette" },
  { id: "cutout", label: "Paper cutout", hint: "Layered construction-paper textures, soft shadows" },
  { id: "lineart", label: "Line art", hint: "Single-weight outlines, limited fills" },
  { id: "storybook", label: "Storybook", hint: "Painterly, warm, illustrated-book feel" },
  { id: "retro", label: "Retro print", hint: "Mid-century, halftone, muted inks" },
];

const MOTIONS = ["pan-left", "pan-right", "zoom-in", "zoom-out", "parallax", "fade", "slide-up", "hold"];
const DURATIONS = [5, 8, 10, 12];

const newId = () => Math.random().toString(36).slice(2, 9);

function blankProject() {
  return {
    id: newId(),
    title: "Untitled video",
    createdAt: Date.now(),
    status: "draft", // draft | planned | approved
    mode: "theme", // theme | general
    theme: "Science explainers",
    topic: "",
    style: "flat2d",
    characters: [],
    era: "present day",
    place: "",
    durationMin: 10,
    tone: "curious, warm, plainspoken",
    voice: "calm female narrator",
    musicMood: "ambient, gently building",
    scenes: [],
  };
}

/* ---- shrink an uploaded reference image to a small thumb (keeps storage tiny) ---- */
function fileToThumb(file, max = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
const randSeed = () => Math.floor(Math.random() * 1e9);

/* ---- split a pasted narration script into scene-sized chunks (verbatim) ---- */
function splitScript(text) {
  const raw = (text || "").trim();
  if (!raw) return [];
  let blocks = raw.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (blocks.length <= 1) blocks = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const words = block.split(/\s+/).filter(Boolean);
    if (words.length > 50) {
      const sents = block.split(/(?<=[.!?])\s+/);
      for (let i = 0; i < sents.length; i += 2) {
        const piece = sents.slice(i, i + 2).join(" ").trim();
        if (piece) out.push(piece);
      }
    } else {
      out.push(block);
    }
  }
  return out;
}

/* ---- timecode helpers ---- */
const tc = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
const startTimes = (scenes) => {
  let t = 0;
  return scenes.map((sc) => {
    const start = t;
    t += Number(sc.seconds) || 0;
    return start;
  });
};

/* ---- tolerant JSON salvage for possibly-truncated model output ----
   The model returns {"title":..,"scenes":[{..},{..}]}. When the response is
   cut off by a token cap the OUTER brace never closes, so we can't just match
   top-level objects. Instead we scan from *inside* the scenes array and recover
   each complete {..} scene object — whatever finished before truncation. */
function parsePlan(raw) {
  let text = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  // 1) clean parse (untruncated response)
  try {
    const p = JSON.parse(text);
    if (p && Array.isArray(p.scenes)) return p;
  } catch (_) {}

  // 2) keep the title if we can find it
  const tMatch = text.match(/"title"\s*:\s*"([^"]*)"/);
  const title = tMatch ? tMatch[1] : undefined;

  // 3) start scanning just after the scenes array opens
  let scanFrom = 0;
  const sIdx = text.indexOf('"scenes"');
  if (sIdx !== -1) {
    const br = text.indexOf("[", sIdx);
    if (br !== -1) scanFrom = br + 1;
  }

  // 4) extract balanced {..} scene objects (handles the unclosed outer brace)
  const objs = [];
  let depth = 0, start = -1;
  for (let i = scanFrom; i < text.length; i++) {
    const c = text[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { objs.push(text.slice(start, i + 1)); start = -1; } }
  }
  const scenes = [];
  for (const o of objs) {
    try { const p = JSON.parse(o); if (p.narration || p.prompt) scenes.push(p); } catch (_) {}
  }
  if (scenes.length) return { title, scenes };
  throw new Error("length-cap");
}

/* ============================== ROOT ============================== */
export default function App() {
  const [projects, setProjects] = useState(null); // null = loading
  const [currentId, setCurrentId] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [settings, setSettings] = useState(defaultSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saveTimer = useRef(null);
  const setTimer = useRef(null);

  // load once
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORE_KEY);
        const arr = res ? JSON.parse(res.value) : [];
        if (arr.length) { setProjects(arr); setCurrentId(arr[0].id); }
        else { const p = blankProject(); setProjects([p]); setCurrentId(p.id); }
      } catch (_) {
        const p = blankProject(); setProjects([p]); setCurrentId(p.id);
      }
      try {
        const sres = await window.storage.get(SETTINGS_KEY);
        if (sres) {
          const loaded = JSON.parse(sres.value);
          const base = defaultSettings();
          setSettings({ active: loaded.active || base.active, providers: { ...base.providers, ...(loaded.providers || {}) } });
        }
      } catch (_) {}
    })();
  }, []);

  // debounced persist — projects
  useEffect(() => {
    if (!projects) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await window.storage.set(STORE_KEY, JSON.stringify(projects)); } catch (_) {}
    }, 600);
  }, [projects]);

  // debounced persist — settings
  useEffect(() => {
    clearTimeout(setTimer.current);
    setTimer.current = setTimeout(async () => {
      try { await window.storage.set(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    }, 500);
  }, [settings]);

  const current = projects?.find((p) => p.id === currentId) || null;

  const update = useCallback((patch) => {
    setProjects((ps) => ps.map((p) => (p.id === currentId ? { ...p, ...patch } : p)));
  }, [currentId]);

  const addProject = () => {
    const p = blankProject();
    setProjects((ps) => [p, ...ps]);
    setCurrentId(p.id);
    setNavOpen(false);
  };
  const removeProject = (id) => {
    setProjects((ps) => {
      const next = ps.filter((p) => p.id !== id);
      if (id === currentId) setCurrentId(next[0]?.id ?? null);
      return next.length ? next : [blankProject()];
    });
  };

  return (
    <div className="cels">
      <Styles />
      <Topbar onMenu={() => setNavOpen((v) => !v)} project={current}
        settings={settings} onSettings={() => setSettingsOpen(true)} />
      <div className="shell">
        <Sidebar
          open={navOpen}
          projects={projects}
          currentId={currentId}
          onPick={(id) => { setCurrentId(id); setNavOpen(false); }}
          onAdd={addProject}
          onRemove={removeProject}
        />
        <main className="stage">
          {!projects ? (
            <div className="loading">Loading the desk…</div>
          ) : current ? (
            <Desk key={current.id} project={current} update={update} settings={settings} />
          ) : null}
        </main>
      </div>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings} />
    </div>
  );
}

/* ============================== SETTINGS ============================== */
function SettingsDrawer({ open, onClose, settings, setSettings }) {
  if (!open) return null;
  const active = settings.providers[settings.active];
  const setProv = (patch) => setSettings({ ...settings, providers: { ...settings.providers, [settings.active]: { ...active, ...patch } } });
  const editable = active.kind !== "anthropic-proxy";

  return (
    <div className="drawerback" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawerhead">
          <h2>API &amp; models</h2>
          <button className="del" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="field">
          <label>Active provider</label>
          <select value={settings.active} onChange={(e) => setSettings({ ...settings, active: e.target.value })}>
            {Object.values(settings.providers).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <span className="help">Drives the Generate and Build-look buttons everywhere in the tool.</span>
        </div>

        {!editable ? (
          <p className="empty">Built-in. Runs here in the chat with no key, but is length-capped (~8 scenes). Switch to OpenAI, Ollama, or another provider below for full-length output once you deploy.</p>
        ) : (
          <>
            <div className="field">
              <label>Base URL</label>
              <input value={active.baseUrl} onChange={(e) => setProv({ baseUrl: e.target.value })}
                placeholder={active.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} />
            </div>
            <div className="field">
              <label>API key</label>
              <input type="password" value={active.apiKey} onChange={(e) => setProv({ apiKey: e.target.value })} placeholder="sk-…" autoComplete="off" />
            </div>
            <div className="field">
              <label>Model</label>
              <input value={active.model} onChange={(e) => setProv({ model: e.target.value })}
                placeholder={active.kind === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini / qwen2.5:14b"} />
            </div>
          </>
        )}

        <p className="warn">Security note: browsers block most direct calls to hosted APIs (CORS), and any key saved here lives in this browser. For the real deployment, keep keys on your backend and have this UI call your server, which calls the provider. Ollama on localhost and the in-chat preview are the two that work without that.</p>

        <div className="field" style={{ marginTop: "18px" }}>
          <label>Render service URL</label>
          <input value={settings.renderUrl || ""} onChange={(e) => setSettings({ ...settings, renderUrl: e.target.value })}
            placeholder="http://localhost:8080" />
          <span className="help">Where the render engine runs. The "Render video" button in Handoff posts the manifest here.</span>
        </div>
      </div>
    </div>
  );
}

/* ============================== TOPBAR ============================== */
function Topbar({ onMenu, project, settings, onSettings }) {
  const planned = project ? startTimes(project.scenes).length : 0;
  const active = settings?.providers?.[settings.active];
  return (
    <header className="topbar">
      <button className="iconbtn only-narrow" onClick={onMenu} aria-label="Projects">≡</button>
      <div className="brand">
        <span className="mark" aria-hidden>
          <svg width="28" height="28" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="60" height="60" rx="15" fill="#16121f" stroke="#3a3252" strokeWidth="1.5" />
            <path d="M20 19 L31 32 L20 45" fill="none" stroke="#8c9bf0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" opacity="0.4" />
            <path d="M33 19 L44 32 L33 45" fill="none" stroke="#f2b450" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="49" cy="29" r="1.6" fill="#f2b450" />
          </svg>
        </span>
        <span className="wordmark">TWEENFORGE</span>
        <span className="tagline">animation desk</span>
      </div>
      <button className="provbtn" onClick={onSettings} title="API & models">
        <span className="gear" aria-hidden>⚙</span>
        <span className="provlabel">{active?.label || "Settings"}</span>
      </button>
      <div className="topstat">
        <span className="dot" data-status={project?.status} />
        <span>{project?.status ?? "—"}</span>
        <span className="sep">{"/"}</span>
        <span className="mono">{planned} scenes</span>
      </div>
    </header>
  );
}

/* ============================== SIDEBAR ============================== */
function Sidebar({ open, projects, currentId, onPick, onAdd, onRemove }) {
  return (
    <aside className={"sidebar" + (open ? " open" : "")}>
      <button className="newbtn" onClick={onAdd}>+ New video</button>
      <div className="projlist">
        {(projects || []).map((p) => (
          <div
            key={p.id}
            className={"projitem" + (p.id === currentId ? " active" : "")}
            onClick={() => onPick(p.id)}
          >
            <span className="dot" data-status={p.status} />
            <span className="projtitle">{p.title || "Untitled"}</span>
            <button
              className="del"
              onClick={(e) => { e.stopPropagation(); onRemove(p.id); }}
              aria-label="Delete"
            >×</button>
          </div>
        ))}
      </div>
      <p className="sidefoot">Projects save to this browser. Export the manifest to hand each one to your render pipeline.</p>
    </aside>
  );
}

/* ============================== DESK ============================== */
function Desk({ project, update, settings }) {
  return (
    <div className="desk">
      <BriefLayer project={project} update={update} />
      <VariablesLayer project={project} update={update} settings={settings} />
      <ScriptLayer project={project} update={update} settings={settings} />
      <Storyboard project={project} update={update} />
      <Handoff project={project} settings={settings} />
    </div>
  );
}

/* ---- layer wrapper ---- */
function Layer({ n, title, sub, children, accent }) {
  return (
    <section className="layer">
      <div className="layerhead">
        <span className="layern mono" style={accent ? { color: accent } : null}>{n}</span>
        <div>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </div>
      </div>
      <div className="layerbody">{children}</div>
    </section>
  );
}

/* ============================== 1. BRIEF ============================== */
function BriefLayer({ project, update }) {
  return (
    <Layer n="01" title="Brief" sub="Where the video starts — a recurring theme, or a one-off topic.">
      <div className="seg">
        <button className={project.mode === "theme" ? "on" : ""} onClick={() => update({ mode: "theme" })}>From a theme</button>
        <button className={project.mode === "general" ? "on" : ""} onClick={() => update({ mode: "general" })}>General topic</button>
      </div>

      {project.mode === "theme" ? (
        <div className="field">
          <label>Channel theme</label>
          <input value={project.theme} onChange={(e) => update({ theme: e.target.value })}
            placeholder="e.g. Science explainers, Forgotten history, Mythology" />
          <span className="help">The plan stays on-theme. Vary the angle each day so uploads aren't templated.</span>
        </div>
      ) : (
        <div className="field">
          <label>Topic for this video</label>
          <textarea rows={2} value={project.topic} onChange={(e) => update({ topic: e.target.value })}
            placeholder="e.g. Why do we get goosebumps?" />
        </div>
      )}

      <div className="field">
        <label>Working title</label>
        <input value={project.title} onChange={(e) => update({ title: e.target.value })} placeholder="Untitled video" />
      </div>
    </Layer>
  );
}

/* ============================== 2. VARIABLES ============================== */
function VariablesLayer({ project, update, settings }) {
  const addChar = () => update({ characters: [...project.characters, { id: newId(), name: "", description: "", spec: "", refImage: "", seed: randSeed(), locked: false }] });
  const setChar = (id, patch) => update({ characters: project.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const delChar = (id) => update({ characters: project.characters.filter((c) => c.id !== id) });

  return (
    <Layer n="02" title="Variables" sub="The dials that keep every scene visually consistent.">
      <div className="field">
        <label>Visual style</label>
        <div className="chips">
          {STYLE_PRESETS.map((s) => (
            <button key={s.id} className={"chip" + (project.style === s.id ? " on" : "")}
              title={s.hint} onClick={() => update({ style: s.id })}>{s.label}</button>
          ))}
        </div>
        <span className="help">{STYLE_PRESETS.find((s) => s.id === project.style)?.hint}</span>
      </div>

      <div className="grid2">
        <div className="field">
          <label>Time</label>
          <input value={project.era} onChange={(e) => update({ era: e.target.value })} placeholder="e.g. 1840s, far future, timeless" />
        </div>
        <div className="field">
          <label>Place</label>
          <input value={project.place} onChange={(e) => update({ place: e.target.value })} placeholder="e.g. deep ocean, a city rooftop" />
        </div>
      </div>

      <div className="grid3">
        <div className="field">
          <label>Duration</label>
          <div className="seg small">
            {DURATIONS.map((d) => (
              <button key={d} className={project.durationMin === d ? "on" : ""} onClick={() => update({ durationMin: d })}>{d}m</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Narration voice</label>
          <input value={project.voice} onChange={(e) => update({ voice: e.target.value })} placeholder="e.g. calm female narrator" />
        </div>
        <div className="field">
          <label>Tone</label>
          <input value={project.tone} onChange={(e) => update({ tone: e.target.value })} placeholder="e.g. curious, warm" />
        </div>
      </div>

      <div className="field">
        <div className="labelrow">
          <label>Characters</label>
          <button className="ghost" onClick={addChar}>+ Add character</button>
        </div>
        {project.characters.length === 0 ? (
          <p className="empty">No recurring characters yet. Add one, lock its look and seed, and every scene reuses the same face.</p>
        ) : (
          <div className="charlist">
            {project.characters.map((c) => (
              <CharacterCard key={c.id} ch={c} project={project} settings={settings}
                onChange={(patch) => setChar(c.id, patch)} onRemove={() => delChar(c.id)} />
            ))}
          </div>
        )}
      </div>
    </Layer>
  );
}

/* ---- character preview: locked look spec + reference image + locked seed ---- */
function CharacterCard({ ch, project, settings, onChange, onRemove }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  async function buildLook() {
    setBusy(true); setErr("");
    const styleHint = STYLE_PRESETS.find((s) => s.id === project.style)?.hint || project.style;
    const prompt =
`Write a locked visual spec for a recurring character in a faceless 2D animated explainer.
Art style: ${styleHint}.
Character: ${ch.name || "unnamed"} — ${ch.description || "no description given"}.
Return ONE concise paragraph (max ~55 words) of fixed, repeatable visual traits only: face & skin, hair, build, signature clothing, and color palette. No backstory and no scene context — only the look, phrased so it can be appended to every scene's image prompt to keep the character identical. Plain text only, no labels.`;
    try {
      const text = (await callLLM(settings, prompt, { maxTokens: 400 })).trim();
      if (!text) throw new Error("empty");
      onChange({ spec: text });
    } catch (e) {
      setErr(e.message === "empty" ? "Came back empty — try again." : (e.message || "Couldn't build the look. Check Settings."));
    } finally { setBusy(false); }
  }

  async function onPickImage(e) {
    const f = e.target.files?.[0]; if (!f) return;
    setErr("");
    try { onChange({ refImage: await fileToThumb(f) }); } catch (_) { setErr("Couldn't read that image file."); }
  }

  return (
    <div className={"charcard" + (ch.locked ? " locked" : "")}>
      <div className="charcardhead">
        <input className="charname" value={ch.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Character name" />
        <button className={"lockbtn" + (ch.locked ? " on" : "")} onClick={() => onChange({ locked: !ch.locked })}>
          {ch.locked ? "🔒 Locked" : "Lock look"}
        </button>
        <button className="del" onClick={onRemove} aria-label="Remove">×</button>
      </div>

      <input className="chardesc" value={ch.description} onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Short description — e.g. curious girl, red coat, freckles" />

      <div className="charpreview">
        <div className="refbox">
          {ch.refImage ? (
            <>
              <img src={ch.refImage} alt={ch.name || "reference"} />
              <button className="clearref" onClick={() => onChange({ refImage: "" })}>Replace</button>
            </>
          ) : (
            <button className="refadd" onClick={() => fileRef.current?.click()}>
              <span>＋</span><small>Reference image</small>
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickImage} style={{ display: "none" }} />
        </div>

        <div className="lookcol">
          <div className="lookhead">
            <span className="minilabel">Locked look</span>
            <button className="ghost tiny" onClick={buildLook} disabled={busy}>{busy ? "Building…" : ch.spec ? "Rebuild" : "Build look"}</button>
          </div>
          <textarea className="spec" rows={3} value={ch.spec || ""} onChange={(e) => onChange({ spec: e.target.value })}
            placeholder="The fixed appearance appended to every scene prompt. Build it, or write your own." />
          <div className="seedrow">
            <span className="minilabel">Seed</span>
            <input className="seedinput mono" type="number" value={ch.seed ?? ""} onChange={(e) => onChange({ seed: Number(e.target.value) })} />
            <button className="ghost tiny" onClick={() => onChange({ seed: randSeed() })}>↻</button>
          </div>
        </div>
      </div>
      {err && <p className="error tiny">{err}</p>}
      <p className="charnote">Pipeline uses all three to keep this face steady: the look text in every prompt, the reference via IP-Adapter, the seed for reproducibility.</p>
    </div>
  );
}

/* ============================== 3. SCRIPT (live) ============================== */
function ScriptLayer({ project, update, settings }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [srcMode, setSrcMode] = useState("generate"); // generate | import
  const [importText, setImportText] = useState("");

  const targetScenes = Math.max(6, Math.round((project.durationMin * 60) / 13));
  // The in-chat preview is capped ~1000 tokens (~8 full scenes). Any real
  // provider you set in Settings has no such cap, so we ask for the full plan.
  const PREVIEW_CAP = 8;
  const capped = isPreview(settings);
  const askFor = capped ? Math.min(targetScenes, PREVIEW_CAP) : targetScenes;

  const importWords = importText.trim() ? importText.trim().split(/\s+/).length : 0;
  const importSecs = Math.round(importWords / 2.5); // ~150 spoken words/min

  function importScript() {
    setErr(""); setNotice("");
    const pieces = splitScript(importText);
    if (!pieces.length) { setErr("Paste a script first — blank lines between scenes work best."); return; }
    const scenes = pieces.map((narr) => {
      const words = narr.split(/\s+/).filter(Boolean).length;
      return { id: newId(), narration: narr, prompt: "", seconds: Math.max(3, Math.round(words / 2.5)), motion: "hold", flag: null };
    });
    const total = scenes.reduce((a, s) => a + s.seconds, 0);
    update({ scenes, status: "planned" });
    setNotice(`Imported ${scenes.length} scenes (~${tc(total)} narration). Your words are kept verbatim — add art prompts in the storyboard, or let your backend batch-draft them.`);
  }

  async function generate() {
    setBusy(true); setErr(""); setNotice("");
    const styleHint = STYLE_PRESETS.find((s) => s.id === project.style)?.hint || project.style;
    const subject = project.mode === "theme"
      ? `a fresh, specific episode within the channel theme "${project.theme}"`
      : `the topic "${project.topic || project.title}"`;
    const chars = project.characters.filter((c) => c.name).map((c) => `${c.name}: ${c.spec || c.description}`).join(" | ") || "none";

    const prompt =
`You are the script + storyboard writer for a faceless 2D animated explainer channel.
Write a scene-by-scene plan for ${subject}.

Constraints:
- Visual style: ${styleHint}
- Setting — time: ${project.era}; place: ${project.place || "as fits the topic"}
- Recurring characters: ${chars}
- Tone: ${project.tone}. Narration voice: ${project.voice}.
- Produce exactly ${askFor} scenes (a${askFor < targetScenes ? "n opening" : " full"} stretch of the ~${targetScenes}-scene, ${project.durationMin}-minute video).

Return ONLY valid JSON, no prose, no markdown fences, in this exact shape:
{"title":"a tight, specific video title","scenes":[{"narration":"one or two spoken sentences","prompt":"one line describing the single illustration for this scene, in the chosen style","seconds":12,"motion":"one of: ${MOTIONS.join(", ")}"}]}
Keep narration and prompts concise. If you are running low on space, return fewer fully-formed scenes rather than cutting one off mid-object. Make prompts visually consistent with the style and characters.`;

    try {
      const text = await callLLM(settings, prompt, { json: true, maxTokens: 4000 });
      const plan = parsePlan(text);
      const scenes = (plan.scenes || []).map((s) => ({
        id: newId(),
        narration: s.narration || "",
        prompt: s.prompt || "",
        seconds: Number(s.seconds) || 12,
        motion: MOTIONS.includes(s.motion) ? s.motion : "hold",
        flag: null,
      }));
      if (!scenes.length) throw new Error("empty");
      update({ scenes, status: "planned", title: plan.title || project.title });
      if (capped && scenes.length < targetScenes - 2) {
        setNotice(`Drafted ${scenes.length} scenes. The in-chat preview is length-capped — set a provider in Settings (OpenAI, Ollama, etc.) to generate the full ~${targetScenes} in one pass. You can also add scenes by hand below.`);
      }
    } catch (e) {
      if (e.message === "length-cap") {
        setErr("The preview model ran out of room before a scene finished — try a shorter duration, or set a full provider in Settings.");
      } else if (e.message === "empty") {
        setErr("The plan came back empty. Try generating again.");
      } else {
        setErr(e.message || "Couldn't reach the model. Check Settings and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const hasScenes = project.scenes.length > 0;

  return (
    <Layer n="03" title="Script" sub="Draft narration from the brief, or import a script you already have." accent="var(--glow)">
      <div className="seg">
        <button className={srcMode === "generate" ? "on" : ""} onClick={() => setSrcMode("generate")}>Generate</button>
        <button className={srcMode === "import" ? "on" : ""} onClick={() => setSrcMode("import")}>Import script</button>
      </div>

      {srcMode === "generate" ? (
        <div className="genrow">
          <button className="primary" onClick={generate} disabled={busy}>
            {busy ? "Drafting…" : hasScenes ? "Re-draft scene plan" : "Generate scene plan"}
          </button>
          <span className="genmeta mono">drafting {askFor} of ~{targetScenes} scenes · {project.durationMin}:00</span>
        </div>
      ) : (
        <div className="importwrap">
          <textarea className="importbox" rows={7} value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder={"Paste your finished narration here.\n\nBlank lines separate scenes. Long paragraphs are split automatically. Your wording is kept exactly."} />
          <div className="genrow">
            <button className="primary" onClick={importScript} disabled={!importWords}>Build scenes from script</button>
            <span className="genmeta mono">{importWords} words · ~{tc(importSecs)}</span>
          </div>
        </div>
      )}

      {busy && <div className="bar"><span /></div>}
      {err && <p className="error">{err}</p>}
      {notice && !busy && <p className="help">{notice}</p>}
      {hasScenes && !busy && !notice && <p className="help">Plan ready — review and flag changes below.</p>}
    </Layer>
  );
}

/* ============================== 4. STORYBOARD ============================== */
function Storyboard({ project, update }) {
  const starts = startTimes(project.scenes);
  const planned = project.scenes.reduce((a, s) => a + (Number(s.seconds) || 0), 0);
  const target = project.durationMin * 60;
  const pct = Math.min(100, (planned / target) * 100);
  const flagged = project.scenes.filter((s) => s.flag).length;

  const setScene = (id, patch) => update({ scenes: project.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const delScene = (id) => update({ scenes: project.scenes.filter((s) => s.id !== id) });

  if (!project.scenes.length) {
    return (
      <Layer n="04" title="Storyboard" sub="Each scene as a cel — narration, art prompt, timing, and your change notes.">
        <p className="empty big">No scenes yet. Generate a plan in layer 03 and the storyboard fills in here.</p>
      </Layer>
    );
  }

  return (
    <Layer n="04" title="Storyboard" sub="Each scene as a cel — narration, art prompt, timing, and your change notes.">
      <div className="meter">
        <div className="metertrack"><span style={{ width: pct + "%" }} /></div>
        <div className="meterlabels mono">
          <span>planned <b>{tc(planned)}</b></span>
          <span>target {tc(target)}</span>
          {flagged > 0 && <span className="flagcount">{flagged} flagged</span>}
        </div>
      </div>

      <div className="reel">
        {project.scenes.map((s, i) => (
          <SceneCard key={s.id} idx={i} scene={s} start={starts[i]}
            onChange={(patch) => setScene(s.id, patch)} onDelete={() => delScene(s.id)} />
        ))}
      </div>

      <div className="approverow">
        <button className={"approve" + (project.status === "approved" ? " done" : "")}
          onClick={() => update({ status: project.status === "approved" ? "planned" : "approved" })}>
          {project.status === "approved" ? "✓ Approved for render" : "Approve for render"}
        </button>
        {flagged > 0 && <span className="help">{flagged} scene{flagged > 1 ? "s" : ""} flagged — re-render touches only those.</span>}
      </div>
    </Layer>
  );
}

const FLAG_ACTIONS = [
  { id: "art", label: "Regenerate art" },
  { id: "line", label: "Rewrite line" },
  { id: "time", label: "Retime" },
  { id: "motion", label: "Change motion" },
];

function SceneCard({ idx, scene, start, onChange, onDelete }) {
  const flagged = !!scene.flag;
  const setFlag = (action) => {
    if (scene.flag?.action === action) onChange({ flag: null });
    else onChange({ flag: { action, note: scene.flag?.note || "" } });
  };
  return (
    <article className={"cel" + (flagged ? " flagged" : "")}>
      <div className="celspine">
        <span className="celnum mono">{String(idx + 1).padStart(2, "0")}</span>
        <span className="celtime mono">{tc(start)}</span>
        <button className="del celdel" onClick={onDelete} aria-label="Delete scene">×</button>
      </div>
      <div className="celbody">
        <label className="celfieldlabel">Narration</label>
        <textarea className="narration" rows={2} value={scene.narration}
          onChange={(e) => onChange({ narration: e.target.value })} />

        <label className="celfieldlabel">Art prompt</label>
        <textarea className="prompt mono" rows={2} value={scene.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })} />

        <div className="celmeta">
          <label className="inline">
            <span>sec</span>
            <input className="secinput mono" type="number" min={1} value={scene.seconds}
              onChange={(e) => onChange({ seconds: Number(e.target.value) || 0 })} />
          </label>
          <label className="inline">
            <span>motion</span>
            <select value={scene.motion} onChange={(e) => onChange({ motion: e.target.value })}>
              {MOTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>

        <div className="flagrow">
          {FLAG_ACTIONS.map((a) => (
            <button key={a.id} className={"flagbtn" + (scene.flag?.action === a.id ? " on" : "")}
              onClick={() => setFlag(a.id)}>{a.label}</button>
          ))}
        </div>

        {flagged && (
          <textarea className="note" rows={2} placeholder={`Note for "${FLAG_ACTIONS.find((a) => a.id === scene.flag.action)?.label}" at ${tc(start)} — what to change`}
            value={scene.flag.note} onChange={(e) => onChange({ flag: { ...scene.flag, note: e.target.value } })} />
        )}
      </div>
    </article>
  );
}

/* ============================== 5. HANDOFF ============================== */
function Handoff({ project, settings }) {
  const [copied, setCopied] = useState("");
  const [render, setRender] = useState({ state: "idle" }); // idle|queued|rendering|done|error
  const starts = startTimes(project.scenes);

  const manifest = {
    id: project.id,
    title: project.title,
    style: project.style,
    setting: { time: project.era, place: project.place },
    characters: project.characters.filter((c) => c.name).map((c) => ({
      name: c.name,
      look: c.spec || c.description,
      seed: c.seed,
      reference: c.refImage ? "image attached" : null,
      locked: !!c.locked,
    })),
    voice: project.voice,
    music_mood: project.musicMood,
    scenes: project.scenes.map((s, i) => ({
      scene_id: s.id, index: i, start: starts[i], seconds: s.seconds,
      narration: s.narration, image_prompt: s.prompt, motion: s.motion,
    })),
  };
  const edits = project.scenes
    .map((s, i) => s.flag ? { scene_id: s.id, at: tc(starts[i]), start: starts[i], action: s.flag.action, note: s.flag.note } : null)
    .filter(Boolean);

  const copy = async (obj, which) => {
    try { await navigator.clipboard.writeText(JSON.stringify(obj, null, 2)); setCopied(which); setTimeout(() => setCopied(""), 1400); } catch (_) {}
  };

  const base = (settings?.renderUrl || "http://localhost:8080").replace(/\/$/, "");
  async function renderVideo() {
    setRender({ state: "queued" });
    try {
      const r = await fetch(base + "/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manifest),
      });
      const { job_id, error } = await r.json();
      if (!job_id) throw new Error(error || "Render service rejected the manifest.");
      // poll
      for (let i = 0; i < 1200; i++) {
        await new Promise((res) => setTimeout(res, 2500));
        const s = await (await fetch(`${base}/status/${job_id}`)).json();
        if (s.status === "done") { setRender({ state: "done", url: `${base}/video/${job_id}` }); return; }
        if (s.status === "error") { setRender({ state: "error", error: s.error || "render failed" }); return; }
        setRender({ state: s.status === "rendering" ? "rendering" : "queued" });
      }
      setRender({ state: "error", error: "timed out" });
    } catch (e) {
      setRender({ state: "error", error: e.message + " — is the render service running? (" + base + ")" });
    }
  }

  return (
    <Layer n="05" title="Handoff" sub="What your pipeline reads. Manifest builds the video; edits re-render only flagged scenes.">
      <div className="handoffgrid">
        <div className="handoffcard">
          <div className="handoffhead">
            <h3>Manifest</h3>
            <button className="ghost" onClick={() => copy(manifest, "m")} disabled={!project.scenes.length}>
              {copied === "m" ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <pre className="mono code">{project.scenes.length ? JSON.stringify(manifest, null, 2) : "Generate a plan to build the manifest."}</pre>
        </div>
        <div className="handoffcard">
          <div className="handoffhead">
            <h3>Edits {edits.length > 0 && <span className="badge">{edits.length}</span>}</h3>
            <button className="ghost" onClick={() => copy(edits, "e")} disabled={!edits.length}>
              {copied === "e" ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <pre className="mono code">{edits.length ? JSON.stringify(edits, null, 2) : "No flagged scenes. Flag changes in the storyboard to populate this."}</pre>
        </div>
      </div>

      <div className="renderbar">
        <button className="primary" onClick={renderVideo}
          disabled={!project.scenes.length || render.state === "queued" || render.state === "rendering"}>
          {render.state === "queued" || render.state === "rendering" ? "Rendering…" : "▶ Render video"}
        </button>
        <div className="renderstatus">
          {render.state === "rendering" && <span className="genmeta mono">building scenes on the render box…</span>}
          {render.state === "queued" && <span className="genmeta mono">queued…</span>}
          {render.state === "done" && <a className="dl" href={render.url} target="_blank" rel="noreferrer">⬇ Download / preview MP4</a>}
          {render.state === "error" && <span className="error tiny">{render.error}</span>}
          {render.state === "idle" && <span className="genmeta mono">renders on your box via the render service ({base})</span>}
        </div>
      </div>
      {(render.state === "queued" || render.state === "rendering") && <div className="bar"><span /></div>}

      <p className="wire">The render service reads this manifest and produces the MP4 (voiceover → per-scene visual → motion → ffmpeg <code>h264_nvenc</code>). Connect Stable Diffusion (set <code>SD_URL</code>) for AI art; otherwise scenes render as clean typographic cards. Set the service URL in Settings.</p>
    </Layer>
  );
}

/* ============================== STYLES ============================== */
function Styles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

      .cels {
        --ink:#131019; --ink2:#1b1726; --ink3:#241f33; --raise:#2b253c;
        --line:#352e49; --line2:#433a5c;
        --glow:#f2b450; --glow-soft:rgba(242,180,80,.13);
        --cool:#8c9bf0; --flag:#f0795b; --ok:#7fd1a6;
        --text:#ece7de; --muted:#9a91a8; --muted2:#6e667e;
        --disp:'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
        --body:'Inter', system-ui, sans-serif;
        --mono:'JetBrains Mono', ui-monospace, monospace;
        background:var(--ink); color:var(--text); font-family:var(--body);
        min-height:100vh; line-height:1.45;
      }
      .cels * { box-sizing:border-box; }
      .cels .mono { font-family:var(--mono); }
      .cels button { font-family:var(--body); cursor:pointer; }
      .cels input, .cels textarea, .cels select { font-family:var(--body); }
      .cels textarea { resize:vertical; }
      .cels :focus-visible { outline:2px solid var(--cool); outline-offset:2px; }

      /* topbar */
      .topbar { display:flex; align-items:center; gap:18px; padding:14px 20px;
        border-bottom:1px solid var(--line); background:linear-gradient(180deg,var(--ink2),var(--ink)); position:sticky; top:0; z-index:20; }
      .brand { display:flex; align-items:baseline; gap:10px; }
      .mark { display:inline-flex; align-items:center; }
      .wordmark { font-family:var(--disp); font-weight:700; letter-spacing:.18em; font-size:18px; }
      .tagline { color:var(--muted2); font-size:12px; letter-spacing:.04em; }
      .topstat { margin-left:auto; display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; }
      .topstat .sep { color:var(--line2); }
      .provbtn { margin-left:auto; display:inline-flex; align-items:center; gap:8px; background:var(--ink3); border:1px solid var(--line2);
        color:var(--text); border-radius:9px; padding:7px 12px; font-size:13px; }
      .provbtn:hover { border-color:var(--glow); color:var(--glow); }
      .provbtn + .topstat { margin-left:14px; }
      .gear { font-size:14px; }
      .provlabel { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .iconbtn { background:none; border:1px solid var(--line); color:var(--text); border-radius:8px; width:34px; height:34px; font-size:16px; }
      .only-narrow { display:none; }

      .dot { width:8px; height:8px; border-radius:50%; background:var(--muted2); display:inline-block; }
      .dot[data-status="draft"]{ background:var(--muted2); }
      .dot[data-status="planned"]{ background:var(--cool); }
      .dot[data-status="approved"]{ background:var(--ok); }

      .shell { display:flex; align-items:flex-start; }

      /* sidebar */
      .sidebar { width:248px; flex:0 0 248px; border-right:1px solid var(--line);
        padding:16px; position:sticky; top:63px; height:calc(100vh - 63px); overflow:auto; background:var(--ink); }
      .newbtn { width:100%; background:var(--ink3); border:1px solid var(--line2); color:var(--text);
        padding:10px; border-radius:10px; font-weight:600; font-size:14px; }
      .newbtn:hover { border-color:var(--glow); color:var(--glow); }
      .projlist { margin-top:14px; display:flex; flex-direction:column; gap:4px; }
      .projitem { display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:9px; font-size:14px; color:var(--muted); }
      .projitem:hover { background:var(--ink2); color:var(--text); }
      .projitem.active { background:var(--ink3); color:var(--text); }
      .projtitle { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .del { background:none; border:none; color:var(--muted2); font-size:18px; line-height:1; padding:0 2px; }
      .del:hover { color:var(--flag); }
      .sidefoot { margin-top:18px; color:var(--muted2); font-size:12px; line-height:1.5; }

      .stage { flex:1; min-width:0; }
      .loading { padding:60px; color:var(--muted); }
      .desk { max-width:900px; margin:0 auto; padding:28px 24px 80px; }

      /* layers */
      .layer { margin-bottom:14px; border:1px solid var(--line); border-radius:16px; background:var(--ink2); overflow:hidden; }
      .layerhead { display:flex; gap:14px; align-items:flex-start; padding:18px 22px 0; }
      .layern { font-size:13px; color:var(--cool); font-weight:500; padding-top:6px; }
      .layerhead h2 { font-family:var(--disp); font-weight:700; font-size:21px; margin:0; letter-spacing:.01em; }
      .layerhead .sub { color:var(--muted); font-size:13px; margin:3px 0 0; }
      .layerbody { padding:16px 22px 22px; }

      /* fields */
      .field { margin-bottom:16px; }
      .field:last-child { margin-bottom:0; }
      label { display:block; font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin-bottom:7px; }
      .labelrow { display:flex; align-items:center; justify-content:space-between; }
      .labelrow label { margin-bottom:0; }
      input, textarea, select { width:100%; background:var(--ink); border:1px solid var(--line); color:var(--text);
        border-radius:10px; padding:10px 12px; font-size:14px; }
      input:focus, textarea:focus, select:focus { border-color:var(--cool); }
      .help { display:block; color:var(--muted2); font-size:12px; margin-top:6px; line-height:1.5; }
      .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      .grid3 { display:grid; grid-template-columns:auto 1fr 1fr; gap:14px; align-items:start; }

      /* segmented + chips */
      .seg { display:inline-flex; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:16px; }
      .seg.small { margin-bottom:0; }
      .seg button { background:var(--ink); color:var(--muted); border:none; padding:9px 16px; font-size:13px; font-weight:500; }
      .seg button + button { border-left:1px solid var(--line); }
      .seg button.on { background:var(--ink3); color:var(--text); }
      .chips { display:flex; flex-wrap:wrap; gap:8px; }
      .chip { background:var(--ink); border:1px solid var(--line); color:var(--muted); border-radius:999px; padding:7px 14px; font-size:13px; }
      .chip:hover { border-color:var(--line2); color:var(--text); }
      .chip.on { background:var(--glow-soft); border-color:var(--glow); color:var(--glow); }
      .ghost { background:none; border:1px solid var(--line2); color:var(--text); border-radius:8px; padding:6px 12px; font-size:13px; }
      .ghost:hover { border-color:var(--glow); color:var(--glow); }
      .ghost:disabled { opacity:.4; cursor:default; }

      .empty { color:var(--muted2); font-size:13px; font-style:italic; padding:4px 0; }
      .empty.big { text-align:center; padding:34px; }

      /* characters */
      .charlist { display:flex; flex-direction:column; gap:12px; }
      .charcard { border:1px solid var(--line); border-radius:12px; background:var(--ink); padding:12px; }
      .charcard.locked { border-color:var(--ok); box-shadow:0 0 0 1px rgba(127,209,166,.3) inset; }
      .charcardhead { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
      .charname { font-weight:600; flex:1; }
      .chardesc { margin-bottom:12px; font-size:13px; }
      .lockbtn { background:var(--ink2); border:1px solid var(--line2); color:var(--muted); border-radius:8px; padding:7px 12px; font-size:12px; white-space:nowrap; }
      .lockbtn.on { background:var(--ok); border-color:var(--ok); color:#0d2418; font-weight:600; }
      .charpreview { display:grid; grid-template-columns:108px 1fr; gap:12px; }
      .refbox { position:relative; }
      .refbox img { width:108px; height:108px; object-fit:cover; border-radius:10px; border:1px solid var(--line2); display:block; }
      .clearref { position:absolute; left:0; right:0; bottom:0; background:rgba(19,16,25,.82); color:var(--text); border:none; border-radius:0 0 10px 10px; padding:5px; font-size:11px; }
      .refadd { width:108px; height:108px; border:1.5px dashed var(--line2); border-radius:10px; background:var(--ink2); color:var(--muted2);
        display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; }
      .refadd:hover { border-color:var(--glow); color:var(--glow); }
      .refadd span { font-size:22px; line-height:1; }
      .refadd small { font-size:11px; }
      .lookcol { min-width:0; }
      .lookhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
      .minilabel { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted2); }
      .tiny { padding:4px 9px; font-size:11px; }
      .spec { font-size:12.5px; background:var(--ink2); border-color:transparent; }
      .spec:focus { border-color:var(--cool); background:var(--ink); }
      .seedrow { display:flex; align-items:center; gap:8px; margin-top:8px; }
      .seedinput { width:120px; padding:6px 9px; font-size:12px; }
      .error.tiny { margin-top:8px; }
      .charnote { color:var(--muted2); font-size:11px; line-height:1.5; margin:10px 0 0; }

      /* script layer */
      .genrow { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
      .primary { background:var(--glow); color:#23170a; border:none; border-radius:11px; padding:12px 22px; font-weight:700; font-size:15px; }
      .primary:hover { filter:brightness(1.06); }
      .primary:disabled { opacity:.55; cursor:default; }
      .genmeta { color:var(--muted2); font-size:12px; }
      .importwrap { margin-bottom:4px; }
      .importbox { font-size:13.5px; line-height:1.55; margin-bottom:12px; min-height:130px; }
      .bar { margin-top:14px; height:3px; background:var(--ink3); border-radius:3px; overflow:hidden; }
      .bar span { display:block; height:100%; width:40%; background:var(--glow); border-radius:3px; animation:slide 1.1s ease-in-out infinite; }
      @keyframes slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(320%)} }
      .error { color:var(--flag); font-size:13px; margin-top:12px; }

      /* meter */
      .meter { margin-bottom:18px; }
      .metertrack { height:6px; background:var(--ink3); border-radius:6px; overflow:hidden; }
      .metertrack span { display:block; height:100%; background:linear-gradient(90deg,var(--cool),var(--glow)); border-radius:6px; }
      .meterlabels { display:flex; gap:16px; font-size:12px; color:var(--muted); margin-top:7px; }
      .meterlabels b { color:var(--text); font-weight:500; }
      .flagcount { margin-left:auto; color:var(--flag); }

      /* reel of cels */
      .reel { display:flex; flex-direction:column; gap:10px; }
      .cel { display:flex; border:1px solid var(--line); border-radius:12px; background:var(--ink); overflow:hidden; }
      .cel.flagged { border-color:var(--flag); box-shadow:0 0 0 1px var(--flag) inset; }
      .celspine { flex:0 0 64px; background:var(--ink3); border-right:1px solid var(--line);
        display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 0;
        background-image:repeating-linear-gradient(180deg,transparent 0 14px,var(--line) 14px 16px); }
      .celnum { font-size:15px; color:var(--glow); font-weight:500; }
      .celtime { font-size:11px; color:var(--muted2); }
      .celdel { margin-top:auto; }
      .celbody { flex:1; padding:12px 14px; min-width:0; }
      .celfieldlabel { font-size:10px; margin-bottom:4px; }
      .narration { font-size:14px; margin-bottom:10px; border-color:transparent; background:var(--ink2); }
      .prompt { font-size:12px; color:var(--muted); margin-bottom:10px; border-color:transparent; background:var(--ink2); }
      .narration:focus, .prompt:focus { border-color:var(--cool); background:var(--ink); }
      .celmeta { display:flex; gap:16px; margin-bottom:10px; }
      .inline { display:flex; align-items:center; gap:7px; margin:0; }
      .inline span { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted2); }
      .secinput { width:62px; padding:6px 8px; }
      .inline select { width:auto; padding:6px 8px; font-size:13px; }
      .flagrow { display:flex; flex-wrap:wrap; gap:6px; }
      .flagbtn { background:var(--ink2); border:1px solid var(--line); color:var(--muted); border-radius:7px; padding:5px 10px; font-size:12px; }
      .flagbtn:hover { color:var(--text); border-color:var(--line2); }
      .flagbtn.on { background:var(--flag); border-color:var(--flag); color:#2a0f08; font-weight:600; }
      .note { margin-top:10px; font-size:13px; border-color:var(--flag); }

      .approverow { display:flex; align-items:center; gap:14px; margin-top:16px; flex-wrap:wrap; }
      .approve { background:none; border:1px solid var(--ok); color:var(--ok); border-radius:10px; padding:10px 18px; font-weight:600; font-size:14px; }
      .approve.done { background:var(--ok); color:#0d2418; }

      /* handoff */
      .handoffgrid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      .handoffcard { border:1px solid var(--line); border-radius:12px; background:var(--ink); overflow:hidden; }
      .handoffhead { display:flex; align-items:center; justify-content:space-between; padding:11px 14px; border-bottom:1px solid var(--line); }
      .handoffhead h3 { font-family:var(--disp); font-size:15px; margin:0; font-weight:500; }
      .badge { background:var(--flag); color:#2a0f08; border-radius:999px; padding:1px 8px; font-size:11px; margin-left:6px; font-family:var(--body); }
      .code { margin:0; padding:14px; font-size:11.5px; color:var(--muted); max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-word; line-height:1.5; }
      .wire { margin:14px 0 0; color:var(--muted2); font-size:12px; line-height:1.6; }
      .wire code { background:var(--ink3); padding:1px 6px; border-radius:5px; font-family:var(--mono); font-size:11px; color:var(--cool); }
      .renderbar { display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-top:18px; padding-top:18px; border-top:1px solid var(--line); }
      .renderstatus { display:flex; align-items:center; }
      .dl { color:var(--ok); font-size:14px; font-weight:600; text-decoration:none; }
      .dl:hover { text-decoration:underline; }

      /* settings drawer */
      .drawerback { position:fixed; inset:0; background:rgba(8,6,12,.6); z-index:50; display:flex; justify-content:flex-end; }
      .drawer { width:420px; max-width:92vw; height:100%; background:var(--ink2); border-left:1px solid var(--line);
        padding:20px 22px; overflow:auto; box-shadow:-20px 0 60px rgba(0,0,0,.5); }
      .drawerhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
      .drawerhead h2 { font-family:var(--disp); font-weight:700; font-size:20px; margin:0; }
      .warn { margin-top:18px; padding:12px 14px; border:1px solid var(--line2); border-left:3px solid var(--glow);
        border-radius:8px; background:var(--glow-soft); color:var(--muted); font-size:12px; line-height:1.6; }

      @media (max-width:760px) {
        .only-narrow { display:inline-flex; }
        .sidebar { position:fixed; left:0; top:63px; z-index:30; transform:translateX(-110%); transition:transform .2s ease; box-shadow:0 0 40px rgba(0,0,0,.5); }
        .sidebar.open { transform:translateX(0); }
        .desk { padding:18px 14px 70px; }
        .grid2, .grid3, .handoffgrid { grid-template-columns:1fr; }
      }
    `}</style>
  );
}
