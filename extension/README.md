# Defuse Timer (extension)

This folder is the MV3 extension. It loads unpacked in **Chrome, Edge, Brave,
and Firefox 109+**, with no build step. The Firefox build uses the same files;
only the loading method differs.

For plain end-user install steps, see the main [README](../README.md). This file
goes deeper on how detection works, how to test it, and how to tune it.

## What it does

It samples the stream's `<video>` element about four times a second (canvas, with
the regions of interest given as fractions of the video frame, so co-stream and
webcam layouts work), detects the spike or bomb plant, and runs a detonation
countdown (45s Valorant, 40s CS2). It never uses `chrome.debugger`, so there's no
debugging banner, and nothing leaves your device.

## How detection works

The core signal is cross-game: the center round-timer **digits disappear** when
the plant completes, plus a game-specific confirmation.

- **Valorant:** the red spike icon replaces the digits, matched by *shape*
  (template IoU), not just "is it red". Shape matters because the round timer
  itself turns red at low time, which a naive red check mistakes for a plant.
- **CS2** has three selectable HUD profiles (popup dropdown):
  - **Profile 1, center timer** (default, the standard broadcast HUD). A warm
    (red or orange) C4 icon appears in the center timer slot when the digits go.
  - **Profile 2, badge beside the score bar.** A C4 badge, matched by sliding a
    template across a band so it works on either side.
  - **Profile 3, player POV.** The same center-slot logic on the top-center
    in-game timer, for a streamer who is actually playing.

It anchors on the plant once and counts down by arithmetic, so it stays accurate
even if the indicator flickers. It also watches for a defuse and clears the
countdown if the indicator disappears while time remains.

## Install (load unpacked)

### Chrome / Edge / Brave

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open a Valorant or CS2 stream on `youtube.com` or `twitch.tv`.
5. Click the Defuse Timer icon, pick the game (and CS2 HUD profile), then
   **Start watching**.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` from this
   folder. (Temporary add-ons are removed on browser restart; re-load the
   same way, or sign through AMO for permanence.)
3. Open a Valorant or CS2 stream on `youtube.com` or `twitch.tv`.
4. Click the Defuse Timer icon, pick the game (and CS2 HUD profile), then
   **Start watching**.

## Testing it

- **Manual (always works):** click **Plant now**, or press **Alt+P**. The
  countdown overlay should appear bottom-right and tick down. **Alt+C** resets,
  **Alt+X** (or the close button on the overlay) closes it.
- **Move it:** drag the overlay anywhere (grab it off the buttons); the position
  is saved across reloads. The minimize button shrinks it to a small chip.
- **Floating timer (second monitor, Chrome 116+ only):** click **Float** to open
  a small always-on-top window with the countdown and a live mirror of the
  score bar. On Firefox the button shows a "not available in this browser"
  message in the overlay; the in-page overlay itself works unchanged.
- **Auto:** with a live round playing, the overlay should fire within about a
  second of the plant. It works best on a standard full-frame broadcast.

## Tuning detection

Open **Advanced settings** in the popup for three per-game sliders:

- **Detection threshold:** how strong a match must be to count as a plant. For
  CS2 Profiles 1 and 3 this is the warm-color gate; for Profile 2 and Valorant
  it's the shape-match score.
- **Round cooldown:** ignore new triggers for this many seconds after a round
  (skips replays and round-win banners).
- **Confirmation delay:** how long a plant must hold before the countdown shows.
  Higher filters brief false positives; the countdown still anchors to the true
  plant moment, so it stays accurate.

Turn on **Debug overlay** to see the detection boxes and live values (white,
warm, IoU, and so on) drawn on the stream. That is how you check whether the
regions line up, or retune, on a new broadcast or HUD.

## Notes and known limits

- **The regions are tuned on common 720p broadcasts.** Other tournaments or odd
  HUD scales can shift them; the debug overlay shows whether the boxes line up.
  Valorant's fixed-region templates are the most broadcast-fragile part; the CS2
  center and player profiles are template-free.
- **Cross-origin video:** if a player ever taints the canvas, pixel reads fail
  and the popup says so. The manual trigger still works. (YouTube and Twitch both
  allow reads today.)
- **Dev:** plain JavaScript, no build step. After editing `content.js`, run
  `node --check content.js`.
