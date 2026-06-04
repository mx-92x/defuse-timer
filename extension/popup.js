const $ = (id) => document.getElementById(id);

// Per-game slider config: detection-threshold range/default + cooldown default
// (seconds). Defaults match the validated values baked into content.js.
// cfDef = confirmation delay (seconds): how long the plant must hold before the
// countdown shows. Default 0.75s = the original 3-tick confirm window.
const GAME_CFG = {
  valorant: { thMin: 0.40, thMax: 0.80, thStep: 0.01, thDef: 0.60, cdDef: 12, cfDef: 0.75 },
  cs2:      { thMin: 0.15, thMax: 0.50, thStep: 0.01, thDef: 0.30, cdDef: 12, cfDef: 0.75 },
};

// The detection-threshold slider means different things per CS2 HUD profile: the
// center/player profiles (1 & 3) use a WARM-color gate (low values), the badge
// profile (2) uses a shape-match IoU. So the slider's range/default AND which
// settings field it writes depend on (game, profile).
function thresholdCfg(game, profile) {
  if (game === "cs2" && (profile === 1 || profile === 3))
    return { min: 0.05, max: 0.40, step: 0.01, def: 0.10, field: "warmThreshold" };
  const c = GAME_CFG[game];
  return { min: c.thMin, max: c.thMax, step: c.thStep, def: c.thDef, field: "threshold" };
}
const curProfile = () => parseInt($("csProfile").value, 10) || 1;

let settings = {};   // per game: { threshold, warmThreshold (cs2 center/player), cooldown, confirmDelay }

// Paint the slider's filled (violet->teal) portion up to the current value.
function setFill(el) {
  const min = parseFloat(el.min), max = parseFloat(el.max), v = parseFloat(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--pct", pct + "%");
}

async function tab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function send(msg) {
  const t = await tab();
  try { return await chrome.tabs.sendMessage(t.id, msg); }
  catch (e) {
    $("status").textContent = "Open a youtube.com or twitch.tv stream tab first.";
    return null;
  }
}

// The CS2 HUD-profile dropdown is only relevant for CS2.
function updateProfileVis(game) {
  $("profileCard").style.display = game === "cs2" ? "" : "none";
}

async function refresh() {
  const st = await send({ type: "DT_STATE" });
  if (!st) return;
  if (st.csProfile) $("csProfile").value = String(st.csProfile);
  if (st.game) { $("game").value = st.game; loadSliders(st.game); updateProfileVis(st.game); }
  $("status").textContent = st.tainted
    ? "Heads up: can't read this player's pixels — use Plant now (manual)."
    : st.running ? "Watching for the plant…" : "Stopped. Press Start watching.";
}

// Reflect the selected game's settings into the sliders. The threshold slider's
// range/value depends on game + CS2 profile (warm gate vs shape IoU).
function loadSliders(game) {
  const c = GAME_CFG[game];
  const s = settings[game] || {};
  const tc = thresholdCfg(game, curProfile());
  const th = typeof s[tc.field] === "number" ? s[tc.field] : tc.def;
  const cd = typeof s.cooldown === "number" ? s.cooldown : c.cdDef;
  const cf = typeof s.confirmDelay === "number" ? s.confirmDelay : c.cfDef;
  const t = $("threshold");
  t.min = tc.min; t.max = tc.max; t.step = tc.step; t.value = th;
  $("cooldown").value = cd;
  $("confirm").value = cf;
  $("thVal").textContent = Number(th).toFixed(2);
  $("cdVal").textContent = cd + "s";
  $("cfVal").textContent = Number(cf).toFixed(2) + "s";
  setFill(t); setFill($("cooldown")); setFill($("confirm"));
}

// Save the selected game's slider values and push them to the content script live.
function applySliders() {
  const game = $("game").value;
  const tc = thresholdCfg(game, curProfile());
  const threshold = parseFloat($("threshold").value);
  const cooldown = parseInt($("cooldown").value, 10);
  const confirmDelay = parseFloat($("confirm").value);
  $("thVal").textContent = threshold.toFixed(2);
  $("cdVal").textContent = cooldown + "s";
  $("cfVal").textContent = confirmDelay.toFixed(2) + "s";
  setFill($("threshold")); setFill($("cooldown")); setFill($("confirm"));
  // Merge so the OTHER threshold field is preserved (CS2 stores warm + scan
  // thresholds separately; the slider only edits whichever the profile uses).
  const cur = settings[game] || {};
  cur[tc.field] = threshold;
  cur.cooldown = cooldown;
  cur.confirmDelay = confirmDelay;
  settings[game] = cur;
  chrome.storage.local.set({ settings });
  send({ type: "DT_SET_SETTINGS", game, threshold: cur.threshold, warmThreshold: cur.warmThreshold, cooldown, confirmDelay });
}

// Boot: load saved game + settings, then populate the sliders.
chrome.storage.local.get(["game", "settings", "debug", "csProfile"]).then(({ game, settings: saved, debug, csProfile }) => {
  settings = saved || {};
  if (game) $("game").value = game;
  if (csProfile) $("csProfile").value = String(csProfile);
  loadSliders($("game").value);
  updateProfileVis($("game").value);
  $("debug").checked = !!debug;
});

$("game").onchange = () => {
  const game = $("game").value;
  chrome.storage.local.set({ game });
  loadSliders(game);
  updateProfileVis(game);
  send({ type: "DT_SET_GAME", game });
};
$("csProfile").onchange = () => {
  const profile = parseInt($("csProfile").value, 10);
  chrome.storage.local.set({ csProfile: profile });
  loadSliders($("game").value);   // threshold slider's range/meaning depends on the profile
  send({ type: "DT_SET_PROFILE", profile });
};
$("threshold").oninput = applySliders;
$("cooldown").oninput = applySliders;
$("confirm").oninput = applySliders;
$("debug").onchange = () => {
  const on = $("debug").checked;
  chrome.storage.local.set({ debug: on });
  send({ type: "DT_SET_DEBUG", on });
};
$("start").onclick = async () => { await send({ type: "DT_START", game: $("game").value }); refresh(); };
$("stop").onclick = async () => { await send({ type: "DT_STOP" }); refresh(); };
$("plant").onclick = async () => { await send({ type: "DT_PLANT" }); window.close(); };

// Help panel: "?" toggles it; × or Escape closes it.
$("help").onclick = () => { $("helppanel").hidden = !$("helppanel").hidden; };
$("help-close").onclick = () => { $("helppanel").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("helppanel").hidden = true; });

// Footer: show the version (pulled from the manifest so it never goes stale)
// ahead of the maker's mark -> "v0.3.2 · Made by mx-92x".
$("ver").textContent = "v" + chrome.runtime.getManifest().version + " · ";

refresh();
