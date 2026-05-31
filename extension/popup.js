const $ = (id) => document.getElementById(id);

// Per-game slider config: detection-threshold range/default + cooldown default
// (seconds). Defaults match the validated values baked into content.js.
const GAME_CFG = {
  valorant: { thMin: 0.40, thMax: 0.80, thStep: 0.01, thDef: 0.60, cdDef: 12 },
  cs2:      { thMin: 0.15, thMax: 0.50, thStep: 0.01, thDef: 0.30, cdDef: 12 },
};

let settings = {};   // { valorant: {threshold, cooldown}, cs2: {threshold, cooldown} }

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

async function refresh() {
  const st = await send({ type: "DT_STATE" });
  if (!st) return;
  if (st.game) { $("game").value = st.game; loadSliders(st.game); }
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
  const t = $("threshold");
  t.min = c.thMin; t.max = c.thMax; t.step = c.thStep; t.value = th;
  $("cooldown").value = cd;
  $("thVal").textContent = Number(th).toFixed(2);
  $("cdVal").textContent = cd + "s";
}

// Save the selected game's slider values and push them to the content script live.
function applySliders() {
  const game = $("game").value;
  const threshold = parseFloat($("threshold").value);
  const cooldown = parseInt($("cooldown").value, 10);
  $("thVal").textContent = threshold.toFixed(2);
  $("cdVal").textContent = cooldown + "s";
  settings[game] = { threshold, cooldown };
  chrome.storage.local.set({ settings });
  send({ type: "DT_SET_SETTINGS", game, threshold, cooldown });
}

// Boot: load saved game + settings, then populate the sliders.
chrome.storage.local.get(["game", "settings"]).then(({ game, settings: saved }) => {
  settings = saved || {};
  if (game) $("game").value = game;
  loadSliders($("game").value);
});

$("game").onchange = () => {
  const game = $("game").value;
  chrome.storage.local.set({ game });
  loadSliders(game);
  send({ type: "DT_SET_GAME", game });
};
$("threshold").oninput = applySliders;
$("cooldown").oninput = applySliders;
$("start").onclick = async () => { await send({ type: "DT_START", game: $("game").value }); refresh(); };
$("stop").onclick = async () => { await send({ type: "DT_STOP" }); refresh(); };
$("plant").onclick = async () => { await send({ type: "DT_PLANT" }); window.close(); };

refresh();
