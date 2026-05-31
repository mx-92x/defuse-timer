# Defuse Time

A **free, open-source** Chrome (MV3) browser extension that shows a **detonation
countdown** when the spike (Valorant, 45s) or bomb (CS2, 40s) is planted —
detected automatically from a Twitch/YouTube stream's video. Built for people
*watching* esports streams, not players or broadcasters.

> **Status:** both games work live on YouTube broadcasts (v0.2.7, debug build).
> Core detection is done and verified. Next: broader testing (Twitch, more
> tournaments) → strip the debug HUD behind a toggle → publish on the Chrome Web
> Store.

---

## How it works

The extension reads pixels from a small region of the stream's `<video>` element
— **locally, in your browser** — and looks for the moment the plant happens:

- **Cross-game signal:** the center round-timer **digits disappear** when the
  plant completes.
- **Valorant confirm:** the red spike icon (matched by *shape*, not just "is it
  red") replaces the digits.
- **CS2 confirm:** a C4 bomb-icon badge appears beside the score bar (found by
  sliding a template across a band, so it works on either side).

It detects the plant **once**, then runs a simple arithmetic countdown — cheap
and robust. A **manual trigger** (Alt+P) always works as a fallback. No
`chrome.debugger`, so there's no "started debugging this browser" banner, and
nothing is ever sent off your device (see [PRIVACY.md](PRIVACY.md)).

The full detection logic lives in
[`extension/content.js`](extension/content.js) — it's heavily commented.

---

## Install & use

The extension lives in [`extension/`](extension/) and loads unpacked. Full
install and testing steps are in [`extension/README.md`](extension/README.md).
Quick version:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `extension/` folder.
2. Open a Valorant/CS2 stream on youtube.com or twitch.tv, pick the game in the
   popup, **Start watching**.
3. Hotkeys: **Alt+P** plant (manual), **Alt+C** reset, **Alt+X** close.

---

## Repository layout

| Path | What it is |
|---|---|
| [`extension/`](extension/) | The MV3 extension (load this). `content.js` is the heart — detection + overlay + pop-out panel. |
| [`extension/README.md`](extension/README.md) | Install & usage guide. |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy (no servers, nothing leaves your device). |
| [`LICENSE`](LICENSE) | AGPL-3.0. |

---

## Building & contributing

There's **no build step** — the extension is plain JavaScript that loads
unpacked as-is. After editing `extension/content.js`, sanity-check it with:

```sh
node --check extension/content.js
```

Contributions are welcome under the project's license. Because this is
**AGPL-3.0**, any distributed fork — or any modified version run as a network
service — must also be open-sourced under AGPL-3.0.

---

## License

[AGPL-3.0](LICENSE) (`AGPL-3.0-only`). Free and open source. Strong copyleft:
anyone who distributes a modified version — **or runs one as a network service**
— must release their source under the same license. The network clause is chosen
deliberately to cover a possible future hosted/accounts backend, so a competitor
can't fork it into a closed-source rival service.
