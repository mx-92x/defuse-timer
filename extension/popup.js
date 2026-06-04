const $ = (id) => document.getElementById(id);

// Per-game slider config: detection-threshold range/default + cooldown default
// (seconds). Defaults match the validated values baked into content.js.
// cfDef = confirmation delay (seconds): how long the plant must hold before the
// countdown shows. Default 0.75s = the original 3-tick confirm window.
const GAME_CFG = {
  valorant: { thMin: 0.40, thMax: 0.80, thStep: 0.01, thDef: 0.60, cdDef: 12, cfDef: 0.75 },
  cs2:      { thMin: 0.15, thMax: 0.50, thStep: 0.01, thDef: 0.30, cdDef: 12, cfDef: 0.75 },
};

let settings = {};   // { valorant: {threshold, cooldown}, cs2: {threshold, cooldown} }

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
  if (st.game) { $("game").value = st.game; loadSliders(st.game); updateProfileVis(st.game); }
  if (st.csProfile) $("csProfile").value = String(st.csProfile);
  $("status").textContent = st.tainted
    ? "Heads up: can't read this player's pixels — use Plant now (manual)."
    : st.running ? "Watching for the plant…" : "Stopped. Press Start watching.";
}

// Reflect the selected game's settings into the sliders (range is per game).
function loadSliders(game) {
  const c = GAME_CFG[game];
  const s = settings[game] || {};
  const th = typeof s.threshold === "number" ? s.threshold : c.thDef;
  const cd = typeof s.cooldown === "number" ? s.cooldown : c.cdDef;
  const cf = typeof s.confirmDelay === "number" ? s.confirmDelay : c.cfDef;
  const t = $("threshold");
  t.min = c.thMin; t.max = c.thMax; t.step = c.thStep; t.value = th;
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
  const threshold = parseFloat($("threshold").value);
  const cooldown = parseInt($("cooldown").value, 10);
  const confirmDelay = parseFloat($("confirm").value);
  $("thVal").textContent = threshold.toFixed(2);
  $("cdVal").textContent = cooldown + "s";
  $("cfVal").textContent = confirmDelay.toFixed(2) + "s";
  setFill($("threshold")); setFill($("cooldown")); setFill($("confirm"));
  settings[game] = { threshold, cooldown, confirmDelay };
  chrome.storage.local.set({ settings });
  send({ type: "DT_SET_SETTINGS", game, threshold, cooldown, confirmDelay });
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
