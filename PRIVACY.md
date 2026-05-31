# Privacy Policy — Defuse Time

**Last updated: 2026-05-31**

---

## Summary

Defuse Time does **not** collect, transmit, or store any data on external
servers. There are no servers. Everything happens locally in your browser, and
nothing ever leaves your device.

---

## What the extension does

Defuse Time watches the video on a Valorant or CS2 stream (on youtube.com or
twitch.tv) and shows a countdown timer when the spike/bomb is planted. To detect
the plant, it reads pixels from a small region of the **video frame already
playing in your browser tab** and analyzes them on your device. These pixels are
used for detection in that instant and are never saved, copied off your device,
or sent anywhere.

The extension makes **no network requests of its own**.

---

## What data is stored locally

The following is saved in your browser's local extension storage
(`chrome.storage.local`) and never leaves your device:

| Data | Purpose |
|---|---|
| Selected game (Valorant / CS2) | Remember your choice between sessions |
| Overlay position | Remember where you dragged the countdown overlay |

You can clear this at any time by removing the extension.

---

## Permissions and why they're needed

- **`storage`** — to save the two preferences listed above.
- **Host access to `youtube.com` and `twitch.tv`** — so the content script can
  run on those stream pages and read the video frame for detection. The
  extension does not run on any other site.

The extension does **not** use `chrome.debugger`, `tabCapture`, or any
screen-recording permission, and shows no "started debugging this browser"
banner.

---

## Third parties

None. Defuse Time has no analytics, no ads, no tracking, and no third-party SDKs.

---

## Contact

Questions about this policy: mx92dev@gmail.com
