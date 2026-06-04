# Defuse Timer

A **free, open-source** Chrome (MV3) browser extension that shows a **detonation
countdown** when the spike (Valorant, 45s) or bomb (CS2, 40s) is planted. It
detects the plant automatically from a Twitch or YouTube stream's video, and it's
built for people who *watch* esports streams, not players or broadcasters.

> **Status:** working MVP (v0.3.9). Both games auto-detect plants live on
> **YouTube and Twitch**, and CS2 has three selectable HUD profiles. The build is
> clean and publishable (debug overlay off by default). Next up is broader
> tournament testing, then a Chrome Web Store listing.

<!-- Screenshots: add before publishing, e.g.
![Popup](docs/popup.png)  ![Overlay](docs/overlay.png)
-->

## Features

- **Automatic plant detection** straight from the stream video. No manual
  region-picking and no per-stream setup.
- **Both games:** Valorant (45s spike) and CS2 (40s bomb).
- **YouTube and Twitch.** It samples the `<video>` element directly, so
  co-stream and webcam layouts still work.
- **CS2 HUD profiles** (pick the one that matches the broadcast):
  - **Profile 1, center timer** (the standard broadcast HUD; this is the default).
  - **Profile 2, badge beside the score bar.**
  - **Profile 3, player POV** (a streamer who's playing, not an observer feed).
- **Manual fallback.** `Alt+P` always starts the countdown.
- **Defuse-aware.** It clears the countdown if the bomb or spike is defused.
- **Floating timer.** A Picture-in-Picture window for a second monitor, with a
  live mirror of the score bar.
- **Tunable.** Per-game detection threshold, round cooldown, and confirmation
  delay sliders (under "Advanced settings").
- **Private by design.** Everything runs locally and nothing leaves your device.
  It uses only the `storage` permission, and no `chrome.debugger` (so there's no
  "started debugging this browser" banner).

## How it works

The extension reads pixels from a small region of the stream's `<video>` element,
locally in your browser, and looks for the moment the plant happens:

- **Cross-game signal:** the center round-timer **digits disappear** when the
  plant completes.
- **Valorant:** the red spike icon (matched by *shape*, not just "is it red")
  replaces the digits.
- **CS2:** depending on the HUD profile, either a warm (red or orange) C4 icon
  appears in the center timer slot (Profiles 1 and 3), or a C4 badge appears
  beside the score bar (Profile 2, found by sliding a template so it works on
  either side).

It detects the plant once, then runs a simple arithmetic countdown, which is
cheap and robust. The detection logic lives in
[`extension/content.js`](extension/content.js) and is heavily commented.

## Installation

Defuse Timer isn't on the Chrome Web Store yet, so for now you add it by hand.
This is called "loading unpacked" and takes about a minute.

1. **Download the files.** On this repository's GitHub page, click the green
   **Code** button and choose **Download ZIP**, then unzip it somewhere you'll
   keep it. (If you move or delete the folder later, the extension stops working.)
   If you use git instead: `git clone <repository-url>`.
2. **Open the extensions page.** In Chrome, Edge, Brave, or another Chromium
   browser, go to `chrome://extensions`.
3. **Enable Developer mode** using the toggle in the top-right corner.
4. **Click "Load unpacked"** and select the **`extension`** folder from the files
   you just downloaded.
5. That's it. Defuse Timer appears in your toolbar. Click the puzzle-piece icon
   and pin it if you want it always visible.

Once the extension is published on the Chrome Web Store you'll be able to install
it in one click, and these steps will be updated.

## Using it

1. Open a Valorant or CS2 stream on youtube.com or twitch.tv.
2. Click the Defuse Timer icon, pick the game (and for CS2, the HUD profile that
   matches the broadcast), then click **Start watching**.
3. When the bomb or spike is planted, the countdown appears. If you're unsure
   what a control does, click the **?** in the popup for a full reference.
4. Hotkeys: **Alt+P** plant manually, **Alt+C** reset, **Alt+X** close.

## Repository layout

| Path | What it is |
|---|---|
| [`extension/`](extension/) | The MV3 extension (this is what you load). `content.js` is the heart: detection, overlay, and floating timer. |
| `extension/popup.html`, `popup.js` | Popup UI: game and CS2 profile selectors, tuning sliders, help panel. |
| `extension/fonts/`, `extension/icons/` | Bundled Poppins font and the extension icon. |
| [`extension/README.md`](extension/README.md) | Extra usage and testing notes. |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy (no servers, nothing leaves your device). |
| [`LICENSE`](LICENSE) | AGPL-3.0. |

## Building & contributing

There's no build step. The extension is plain JavaScript that loads unpacked
as-is. After editing `extension/content.js`, sanity-check it with:

```sh
node --check extension/content.js
```

Contributions are welcome under the project's license. Because this is
**AGPL-3.0**, any distributed fork, or any modified version run as a network
service, must also be open-sourced under AGPL-3.0.

## License

[AGPL-3.0](LICENSE) (`AGPL-3.0-only`). Free and open source. Strong copyleft:
anyone who distributes a modified version, or runs one as a network service, must
release their source under the same license. The network clause is deliberate. It
covers a possible future hosted or accounts backend, so a competitor can't fork
it into a closed-source rival service.
