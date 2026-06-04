# Defuse Timer — MVP extension

Viewer-side spike/bomb detonation countdown for **Valorant** and **CS2** streams,
running in the viewer's browser. Auto-detects the plant from the stream video
and runs the countdown; manual trigger always available as a fallback.

## How it works
- A content script samples the stream's `<video>` element directly (via canvas)
  at ~1 fps and looks at the **center round-timer slot**.
- **Plant = the round-timer digits disappear** (validated cross-game signal:
  Valorant replaces them with the red spike icon, CS2 with a dash). Valorant also
  has a fast path on the red icon appearing.
- On detection it shows a countdown overlay (45s Valorant / 40s CS2). Detecting
  the plant **once** is enough — the rest is arithmetic, so it's cheap.
- Sampling the video element directly means the ROI is relative to the video,
  not the tab, so co-stream/webcam layouts work. No `chrome.debugger` (no
  "started debugging this browser" banner like other tools).

## Install (load unpacked)
1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` folder.
4. Open a Valorant or CS2 stream on youtube.com or twitch.tv.
5. Click the Defuse Timer icon → pick the game → **Start watching**.

## Test it
- **Manual (always works):** click **Plant now**, or press **Alt+P** — the
  countdown overlay should appear bottom-right and tick down. **Alt+C** resets,
  **Alt+X** (or the **×** on the overlay) closes/hides it.
- **Move it:** drag the overlay anywhere (grab it off the buttons); the position
  is remembered across reloads.
- **Floating timer (2nd monitor):** click **⧉ Float** to open a small
  always-on-top window (Document Picture-in-Picture, Chrome 116+) showing the
  countdown plus a live mirror of the score/round bar — drag it to another
  monitor and work while keeping an eye on it.
- **Auto:** with a live round playing, the overlay should fire within ~1–2s of
  the plant. Best on a standard full-frame broadcast.

## Known MVP limitations (next steps)
- **Auto-detect tuning:** the timer ROI (`TIMER_ROI` in `content.js`) and
  thresholds are set from 720p broadcasts; odd resolutions/HUD scales may need
  tuning. Manual trigger is the reliable fallback meanwhile.
- **Cross-origin video:** if a player taints the canvas, pixel reads fail and the
  popup says so — use the manual trigger. (YouTube generally allows it.)
- **Defuse detection (v0.1.7):** while counting down it watches the spike
  icon; if it disappears with time left, it clears as "defused". Brief washouts
  are tolerated; the last 1.5s is left to detonate. Still being tuned.
- **Round-end/timeout guard:** not yet — a round ending other ways may also
  clear the timer (acceptable for now).
- Auto-detect latency is up to ~1s (1 fps sampling); fine for a viewer countdown.
