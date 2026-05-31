const $ = (id) => document.getElementById(id);

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
  if (st.game) $("game").value = st.game;
  $("status").textContent = st.tainted
    ? "Heads up: can't read this player's pixels — use Plant now (manual)."
    : st.running ? "Watching for the plant…" : "Stopped. Press Start watching.";
}

chrome.storage.local.get("game").then(({ game }) => { if (game) $("game").value = game; });

$("game").onchange = () => {
  chrome.storage.local.set({ game: $("game").value });
  send({ type: "DT_SET_GAME", game: $("game").value });
};
$("start").onclick = async () => { await send({ type: "DT_START", game: $("game").value }); refresh(); };
$("stop").onclick = async () => { await send({ type: "DT_STOP" }); refresh(); };
$("plant").onclick = async () => { await send({ type: "DT_PLANT" }); window.close(); };

refresh();
