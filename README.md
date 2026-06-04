# Defuse Timer

A **free, open-source** Chrome (MV3) browser extension that shows a **detonation
countdown** when the spike (Valorant, 45s) or bomb (CS2, 40s) is planted —
detected automatically from a Twitch or YouTube stream's video. Built for people
*watching* esports streams, not players or broadcasters.

> **Status:** working MVP (v0.3.9). Both games auto-detect plants live on
> **YouTube and Twitch**; CS2 has three selectable HUD profiles. Clean,
> publishable build (debug overlay off by default). Next: broader tournament
> testing → Chrome Web Store listing.

<!-- Screenshots: add before publishing, e.g.
![Popup](docs/popup.png)  ![Overlay](docs/overlay.png)
-->

---

## Features

- **Automatic plant detection** straight from the stream video — no manual
  region-picking, no setup per stream.
- **Both games:** Valorant (45s spike) and CS2 (40s bomb).
- **YouTube and Twitch** — samples the `<video>` element directly, so
  co-stream/webcam layouts still work.
- **CS2 HUD profiles** (pick the one that matches the broadcast):
  - **Profile 1 — center timer** (the standard broadcast HUD; default).
  - **Profile 2 — badge beside the score bar.**
  - **Profile 3 — player POV** (a streamer who's playing, not an observer feed).
- **Manual fallback** — `Alt+P` always starts the countdown.
- **Defuse-aware** — clears the countdown if the bomb/spike is defused.
- **Floating timer** — a Picture-in-Picture window for a second monitor, with a
  live mirror of the score bar.
- **Tunable** — per-game detection threshold, round cooldown, and confirmation
  delay sliders (under "Advanced settings").
- **Private by design** — everything runs locally; nothing leaves your device.
  Only the `storage` permission, and no `chrome.debugger` (so no "started
  debugging this browser" banner).

---

## How it works

The extension reads pixels from a small region of the stream's `<video>` element
— **locally, in your browser** — and looks for the moment the plant happens:

- **Cross-game signal:** the center round-timer **digits disappear** when the
  plant completes.
- **Valorant:** the red spike icon (matched by *shape*, not just "is it red")
  replaces the digits.
- **CS2:** depending on the HUD profile, either a warm (red/orange) C4 icon
  appears in the center timer slot (Profiles 1 & 3), or a C4 badge appears beside
  the score bar (Profile 2, found by sliding a template so it works on either
  side).

It detects the plant **once**, then runs a simple arithmetic countdown — cheap
and robust. The detection logic lives in
[`extension/content.js`](extension/content.js) and is heavily commented.

---

## Install & use

Loads unpacked — no build step. Full steps are in
[`extension/README.md`](extension/README.md). Quick version:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   the [`extension/`](extension/) folder.
2. Open a Valorant/CS2 stream on youtube.com or twitch.tv, pick the game (and the
   CS2 HUD profile) in the popup, then **Start watching**.
3. Click **?** in the popup for a full reference of every control.
4. Hotkeys: **Alt+P** plant (manual), **Alt+C** reset, **Alt+X** close.

---

## Repository layout

| Path | What it is |
|---|---|
| [`extension/`](extension/) | The MV3 extension (load this). `content.js` is the heart — detection + overlay + floating timer. |
| `extension/popup.html` · `popup.js` | Popup UI: game + CS2 profile selectors, tuning sliders, help panel. |
| `extension/fonts/` · `extension/icons/` | Bundled Poppins font and the extension icon. |
| [`extension/README.md`](extension/README.md) | Install & usage guide. |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy (no servers, nothing leaves your device). |
| [`LICENSE`](LICENSE) | AGPL-3.0. |

---

## Building & contributing

There's **no build step** — the extension is plain JavaScript that loads unpacked
as-is. After editing `extension/content.js`, sanity-check it with:

```sh
node --check extension/content.js
```

Contributions are welcome under the project's license. Because this is
**AGPL-3.0**, any distributed fork — or any modified version run as a network
service — must also be open-sourced under AGPL-3.0.

---

## License

[AGPL-3.0](LICENSE) (`AGPL-3.0-only`). Free and open source. Strong copyleft:
anyone who distributes a modified version — **or runs one as a network service** —
must release their source under the same license. The network clause is chosen
deliberately to cover a possible future hosted/accounts backend, so a competitor
can't fork it into a closed-source rival service.
