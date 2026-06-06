/* Defuse Timer — content script.
 *
 * Detects the spike/bomb plant from the stream video and runs a detonation
 * countdown overlay. Detection uses the validated, cross-game signal: the
 * CENTER ROUND-TIMER DIGITS DISAPPEAR at plant-complete (Valorant: digits ->
 * red spike icon; CS2: digits -> dash). For Valorant we also accept the red
 * spike icon appearing in the same slot as a fast path.
 *
 * We sample the <video> element directly via canvas, so the ROI is relative to
 * the video frame (not the tab) -- this handles co-stream/webcam layouts where
 * the video doesn't fill the page. No tabCapture/debugger needed (no banner).
 */
(() => {
  if (window.__defuseTimeLoaded) return;
  window.__defuseTimeLoaded = true;

  // GAMES (per-game config + plant detectors) is defined below as Game
  // subclasses, after the ROI/template constants those classes depend on.

  // Center round-timer slot, as fractions of the video frame (covers the timer
  // digits in both games). Tunable; validated on 720p VCT + CS2 broadcasts.
  const TIMER_ROI = { x: 0.455, y: 0.015, w: 0.09, h: 0.075 };
  // CS2 dedicated ROIs (validated on a real CS2 broadcast):
  //  - center timer DIGITS slot (below the "ROUND n/24" label),
  //  - a horizontal BAND we slide the bomb-icon (C4) template across. The badge
  //    sits left or right of the score bar (sides swap each half) AND its exact
  //    x varies, and its layout is mirrored between sides — so a sliding search
  //    (trying the template + its mirror) beats fixed ROIs. The C4 SHAPE match
  //    rejects the red "ROUND WIN" banner.
  const CS_TIMER_ROI = { x: 0.466, y: 0.022, w: 0.068, h: 0.059 };
  const CS_ICON_W = 0.052;   // bomb-icon source width (template scale anchor)
  const CS_BAND = { x: 0.25, y: 0.022, w: 0.47, h: 0.062 };
  const CS_BOMB = {
    TW: 20, TH: 14,
    mask: "0000000000000000000000010000100000000000000100001000000000000001111111000000000000011000110000000000000110001000000000000001100010000000000000011000100000000000000110001000000000000001111110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  };
  const CS_ICON_IOU = 0.30;   // detection keys on the C4 shape, not red
  const CS_BW = Math.round(CS_BAND.w / CS_ICON_W * CS_BOMB.TW);   // band px-width
  const CS_MASK = Uint8Array.from(CS_BOMB.mask, (c) => c === "1" ? 1 : 0);
  const CS_MASK_M = new Uint8Array(CS_BOMB.TW * CS_BOMB.TH);      // mirrored (left side)
  for (let yy = 0; yy < CS_BOMB.TH; yy++)
    for (let xx = 0; xx < CS_BOMB.TW; xx++)
      CS_MASK_M[yy * CS_BOMB.TW + xx] = CS_MASK[yy * CS_BOMB.TW + (CS_BOMB.TW - 1 - xx)];
  // CS2 HUD "Profile 1" (standard/default broadcast HUD, e.g. ESL / IEM): the
  // round timer sits in the CENTER of the score bar and is REPLACED by a red C4
  // icon when planted — Valorant-style — rather than Profile 2's badge beside the
  // bar. Detection here is broadcast-agnostic ON PURPOSE: a fixed icon TEMPLATE
  // proved per-tournament fragile (ESL's icon sits/scales differently from IEM's,
  // and these HUDs are semi-transparent so the red is noisy). Instead we use the
  // signal that holds across tournaments without any template: in this small
  // center slot the timer DIGITS vanish AND red appears. CS2's round timer never
  // turns red at low time (unlike Valorant — verified with the user), so "red in
  // the center slot" can only be the C4 icon, not a low timer. The ROI is wide
  // enough to contain the icon across broadcasts but excludes the flanking scores.
  const CS_CENTER_ROI = { x: 0.475, y: 0.05, w: 0.04, h: 0.08 };
  // "warm" (red+orange) fraction in the slot that = "the C4 icon is there". Uses
  // warm, not strict red, because broadcasts draw the planted icon differently:
  // ESL/IEM red (hue ~0–10°), PGL orange/amber (hue ~28–35°). The flanking scores
  // (incl. an orange T-side score) are OUTSIDE this tight center ROI, so warm is
  // safe here. Measured planted 0.13–0.49 vs counting/cutaway ~0–0.05.
  const CS_CENTER_WARM = 0.10;
  // CS2 HUD "Profile 3" (player POV — a streamer PLAYING, not an observer/broadcast
  // feed). The in-game round timer sits at the very TOP-CENTER of the screen
  // (higher than the observer score bar) and is replaced by the red/orange bomb
  // timer on plant. Same digits-gone + warm logic as Profile 1 — only the ROI
  // differs. Measured on a FACEIT player stream: timer white ~0.14 while counting
  // (and it STAYS up through the player's own death/spectate, so digits-gone does
  // NOT false-fire on death) → ~0.03 at plant, with warm 0.17–0.32 in the slot.
  const CS_PLAYER_ROI = { x: 0.47, y: 0.008, w: 0.06, h: 0.034 };
  const COOLDOWN_MS = 12000;   // suppress detection right after a round resolves
  // The score-bar strip mirrored into the pop-out panel (pixels, no OCR) is now
  // PER-GAME (`Game.scoreRoi`) — the default CS2 HUD stacks a banner over the
  // scores (taller) while Valorant's is a single top bar, so one shared crop cut
  // the CS2 scores off.
  // Consecutive samples the plant condition must hold before firing (at TICK_MS
  // = 250ms, 3 → ~0.75s). A real plant persists 40–45s, so this rejects blips
  // while staying responsive.
  const CONFIRM_K = 3;
  // While planted, if the plant indicator is ~absent for GONE_K samples (and
  // time still remains), the round ended early -> treat as DEFUSED and clear.
  // At 250ms/sample, 6 = 1.5s — long enough to ignore brief dips/washouts.
  const GONE_K = 6;

  const cfg = { game: "valorant", running: false };
  let dbg = null;           // latest per-tick debug snapshot (read by the overlay)
  let debugOn = false;      // debug HUD toggle (ROI boxes + value readout); default off
  const VERSION = "0.3.11";
  const TICK_MS = 250;   // sample 4x/sec so confirmation (CONFIRM_K) is fast

  // ---- brand palette --------------------------------------------------------
  // Single source of truth for the overlay + pop-out colors (mirrors the
  // popup's CSS :root). primary = violet, secondary = teal; the countdown runs
  // through emerald -> amber -> rose as the fuse burns down.
  const PALETTE = {
    violet: "#8b5cf6", violetLo: "#7c3aed", teal: "#2dd4bf",
    text: "#ece9f5", muted: "#9b93b4",
    safe: "#34d399", caution: "#fbbf24", danger: "#f43f5e",
    barIdle: "#3a3357",            // empty progress bar / neutral surface
  };

  // The overlay + pop-out are injected into the host page (YouTube/Twitch), so
  // to use the bundled Poppins they must (1) be listed in the manifest's
  // web_accessible_resources and (2) have an @font-face pointing at the
  // extension URL injected into that document. The family is namespaced
  // "Poppins DT" so it can't clash with a font the host page already calls
  // "Poppins". If chrome.runtime is unavailable it silently falls back to the
  // system font.
  const FONT_STACK = "'Poppins DT','Segoe UI',system-ui,sans-serif";
  function injectFont(doc) {
    try {
      if (!doc || doc.getElementById("dt-font-face")) return;
      const u = (w) => chrome.runtime.getURL(`fonts/poppins-${w}.woff2`);
      const face = (w) =>
        `@font-face{font-family:'Poppins DT';font-weight:${w};font-style:normal;` +
        `font-display:swap;src:url(${u(w)}) format('woff2');}`;
      const s = doc.createElement("style");
      s.id = "dt-font-face";
      s.textContent = [400, 600, 700, 800].map(face).join("");
      (doc.head || doc.documentElement).appendChild(s);
    } catch (e) { /* getURL unavailable -> system font fallback */ }
  }

  // Is the Document Picture-in-Picture API (the Floating timer) actually usable?
  // It works correctly only on Chromium. Firefox exposes a non-conformant
  // `documentPictureInPicture.requestWindow` that opens a plain blank browser
  // window instead of a chromeless PiP panel, so neither the property name nor
  // the method's existence is a reliable test. Also require a Chromium signal:
  // `navigator.userAgentData` is implemented by Chromium and intentionally not
  // by Firefox, so its presence gates the feature to where it genuinely works.
  function hasDocPiP() {
    return !!(navigator.userAgentData &&
      window.documentPictureInPicture &&
      typeof window.documentPictureInPicture.requestWindow === "function");
  }

  // Valorant spike-icon shape templates (30x16 red-masks), extracted from real
  // plants. Matching the SHAPE (not just "is there red") is what distinguishes
  // the plant from the red low-time round-timer, which is also red in this slot.
  // Broadcasts can render the icon differently (size/style varies per tournament)
  // so ValorantGame.match() takes the BEST IoU across all templates. Add a new
  // broadcast's template here once measured from REAL planted frames (tools/).
  const ICON = {
    TW: 30, TH: 16,
    masks: [
      // VCT / VCT-style broadcasts (planted icon IoU ~0.77-0.97):
      "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111111110000000000000000000011111011111000000000000000000011111101110000000000000000000001111111110000000000000000000001111011110000000000000000000001101111100000000000100000000000110001000000000000111000000000111111000000000000000000000000011111000000000000000000000000011110000000000000000000000000001110000000000000000000000000000100000000000000000000000000000000000000000000",
      // VCT 2026 "solid triangle + center circle" icon (e.g. mahk9_K1cYc @20:39):
      // settled-plant IoU ~0.80-0.96 (mean 0.91) here vs ~0.45 on the VCT mask.
      "000000000111111111110000000000000000000111111111111000000000000000001111111111111100000000000000001111101111111100000000000000000111111111111000000000000000000111110011111000000000000000000011110011110000000000000000000011111111110000000000000000000001111011100000000000000000000001111111100000000000000000000000111111000000000000000000000000111111000000000000000000000000011110000000000000000000000000011110000000000000000000000000000000000000000000000000000000000000000000000000",
    ],
  };
  const ICON_IOU = 0.6;   // plant if best-template IoU >= this (digit red ~0.45)
  const ICON_TPLS = ICON.masks.map((s) => Uint8Array.from(s, (c) => c === "1" ? 1 : 0));

  // ---- video sampling -------------------------------------------------------
  // FrameSampler owns everything that touches the page <video> and the main
  // sampling canvas. ROIs are given as FRACTIONS of the video frame, so sampling
  // is independent of stream resolution and of co-stream/webcam layouts. The
  // other pixel readers (ValorantGame.match, CS2Game.scan, PopoutPanel) keep
  // their own small canvases but share this object's getVideo() and `tainted`.
  class FrameSampler {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.cx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.tainted = false;   // true once a cross-origin video blocks pixel reads
    }

    // The largest decoded <video> on the page. Just needs a decoded frame —
    // don't drop on transient pause/buffering (that was wasting detection ticks).
    getVideo() {
      let best = null, area = 0;
      for (const v of document.querySelectorAll("video")) {
        if (!v.videoWidth || v.readyState < 2) continue;
        const a = v.videoWidth * v.videoHeight;
        if (a > area) { area = a; best = v; }
      }
      return best;
    }

    // {white, red, warm} fractions inside the ROI, or null if no frame / canvas
    // tainted. `red` = strict red hue; `warm` = red+orange (some broadcasts draw
    // the planted C4 icon orange/amber, not red — CS2 Profile 1 keys on `warm`).
    sample(roi) {
      const v = this.getVideo();
      if (!v) return null;
      const vw = v.videoWidth, vh = v.videoHeight;
      const sw = Math.max(1, Math.round(roi.w * vw));
      const sh = Math.max(1, Math.round(roi.h * vh));
      this.canvas.width = sw; this.canvas.height = sh;
      let data;
      try {
        this.cx.drawImage(v, roi.x * vw, roi.y * vh,
          roi.w * vw, roi.h * vh, 0, 0, sw, sh);
        data = this.cx.getImageData(0, 0, sw, sh).data;
      } catch (e) {
        this.tainted = true;          // cross-origin canvas blocked pixel read
        return null;
      }
      let white = 0, red = 0, warm = 0, n = sw * sh;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        const sat = mx === 0 ? 0 : d / mx;
        if (mx >= 0.7 && sat <= 0.25) white++;              // bright low-sat = digits
        if (d > 0.001 && sat >= 0.4 && mx >= 0.3) {
          let h;
          if (mx === r) h = ((g - b) / d) % 6;
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
          if (h <= 18 || h >= 342) red++;                   // strict red
          if (h <= 45 || h >= 342) warm++;                  // red + orange/amber
        }
      }
      return { white: white / n, red: red / n, warm: warm / n };
    }
  }

  const frames = new FrameSampler();

  // ---- games ----------------------------------------------------------------
  // A Game owns one title's plant-detection signal. Both share the countdown
  // config (fuse + color thresholds); each implements its own pixel matcher.
  class Game {
    constructor({ fuse, label, redAt, yellowAt, threshold, cooldownMs, scoreRoi }) {
      this.fuse = fuse; this.label = label; this.redAt = redAt; this.yellowAt = yellowAt;
      this.threshold = threshold;     // plant-match threshold (user-tunable slider)
      this.cooldownMs = cooldownMs;   // post-round suppression window (user-tunable)
      this.scoreRoi = scoreRoi;       // score-bar strip mirrored into the pop-out (per-HUD)
      this.confirmK = CONFIRM_K;      // ticks the plant must hold before firing (user-tunable)
      this.run = 0;   // consecutive ticks meeting the full plant condition (confirm)
    }
    reset(hard) { this.run = 0; }   // hard = also clear round-learned state (subclasses)
  }

  // Valorant: the plant shows a red spike ICON in the timer slot. Match its
  // SHAPE (best IoU vs the embedded templates), NOT just "is there red", so the
  // red low-time round-timer (also red, but digit-shaped) doesn't false-fire.
  class ValorantGame extends Game {
    constructor() {
      super({ fuse: 45, label: "Valorant", redAt: 7, yellowAt: 21, threshold: ICON_IOU, cooldownMs: COOLDOWN_MS,
        scoreRoi: { x: 0.34, y: 0.0, w: 0.33, h: 0.08 } });   // single-tier top score bar
      this.canvas = document.createElement("canvas");
      this.canvas.width = ICON.TW; this.canvas.height = ICON.TH;
      this.cx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.firstAt = 0;   // when the icon first appeared (= plant time)
    }

    // IoU of the timer-slot red shape vs the spike-icon template. Drawing the ROI
    // to a fixed 30x16 canvas normalizes size across stream resolutions.
    match() {
      const v = frames.getVideo();
      if (!v || !v.videoWidth) return null;
      const vw = v.videoWidth, vh = v.videoHeight;
      let d;
      try {
        this.cx.drawImage(v, TIMER_ROI.x * vw, TIMER_ROI.y * vh,
          TIMER_ROI.w * vw, TIMER_ROI.h * vh, 0, 0, ICON.TW, ICON.TH);
        d = this.cx.getImageData(0, 0, ICON.TW, ICON.TH).data;
      } catch (e) { frames.tainted = true; return null; }
      const N = ICON.TW * ICON.TH;
      const red = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), de = mx - mn;
        const sat = mx === 0 ? 0 : de / mx;
        if (de > 0.001) {
          let h = mx === r ? ((g - b) / de) % 6 : mx === g ? (b - r) / de + 2 : (r - g) / de + 4;
          h = (h * 60 + 360) % 360;
          if ((h <= 18 || h >= 342) && sat >= 0.4 && mx >= 0.3) red[i] = 1;
        }
      }
      // Best IoU across all known broadcast templates (handles per-tournament icons).
      let best = 0;
      for (const t of ICON_TPLS) {
        let inter = 0, uni = 0;
        for (let i = 0; i < N; i++) {
          if (red[i] & t[i]) inter++;
          if (red[i] | t[i]) uni++;
        }
        const iou = uni > 0 ? inter / uni : 0;
        if (iou > best) best = iou;
      }
      return best;
    }

    // Per-tick detection. Returns { plant, plantTime?, status?, debug }.
    poll() {
      const iou = this.match();
      if (iou == null) return { plant: false, status: waitingStatus(), debug: null };
      if (iou >= this.threshold) { if (this.run === 0) this.firstAt = performance.now(); this.run++; }
      else this.run = 0;
      const debug = { mode: "valo", iou, run: this.run };
      if (this.run >= this.confirmK) return { plant: true, plantTime: this.firstAt, debug };
      return { plant: false, status: "Watching for plant…", debug };
    }

    // "Still planted?" while counting down. present===null means can't read (skip).
    // Lenient (>=0.30) so brief washouts over the semi-transparent HUD still count.
    stillPlanted() {
      const iou = this.match();
      if (iou == null) return { present: null };
      return { present: iou >= 0.30, value: iou };
    }

    reset(hard) { super.reset(hard); this.firstAt = 0; }
  }

  // CS2: a C4 bomb-icon badge appears beside the score bar. Slide the C4 template
  // (and its mirror) across a band, taking the best match — the badge swaps sides
  // each half and its x drifts, so a sliding search beats fixed ROIs. The SHAPE
  // match rejects the red "ROUND WIN" banner (red, but no C4 symbol).
  class CS2Game extends Game {
    constructor() {
      super({ fuse: 40, label: "CS2", redAt: 5, yellowAt: 10, threshold: CS_ICON_IOU, cooldownMs: COOLDOWN_MS,
        scoreRoi: { x: 0.33, y: 0.02, w: 0.34, h: 0.145 } });  // taller: default HUD stacks banner over scores
      this.canvas = document.createElement("canvas");
      this.canvas.width = CS_BW; this.canvas.height = CS_BOMB.TH;
      this.cx = this.canvas.getContext("2d", { willReadFrequently: true });
      this.profile = 1;       // 1 = center icon (default HUD); 2 = badge beside bar; 3 = top-center (player POV)
      this.centerRoi = CS_CENTER_ROI;  // which slot pollCenter samples (profile 1 vs 3)
      this.warmThreshold = CS_CENTER_WARM;  // center/player (P1/P3) warm gate — user-tunable slider
      this.armed = false;     // have we seen timer digits (we're in a live round)?
      this.baseline = 0;      // rolling max white-fraction while digits show
      this.dgRun = 0;         // consecutive ticks the digits have been gone
      this.firstGoneAt = 0;   // when the digits first vanished (= plant time)
    }

    setProfile(p) {
      this.profile = (Number(p) === 2 || Number(p) === 3) ? Number(p) : 1;
      this.centerRoi = this.profile === 3 ? CS_PLAYER_ROI : CS_CENTER_ROI;
      this.reset(true);
    }

    // Best match { iou, side, red }: white-mask IoU of the C4 symbol vs template,
    // position- and side-independent (slides the template + its mirror).
    scan() {
      const v = frames.getVideo();
      if (!v || !v.videoWidth) return { iou: 0, side: null, red: 0 };
      const vw = v.videoWidth, vh = v.videoHeight, TW = CS_BOMB.TW, TH = CS_BOMB.TH, BW = CS_BW;
      let data;
      try {
        this.cx.drawImage(v, CS_BAND.x * vw, CS_BAND.y * vh, CS_BAND.w * vw, CS_BAND.h * vh, 0, 0, BW, TH);
        data = this.cx.getImageData(0, 0, BW, TH).data;
      } catch (e) { frames.tainted = true; return { iou: 0, side: null, red: 0 }; }
      const white = new Uint8Array(BW * TH), red = new Uint8Array(BW * TH);
      for (let i = 0; i < BW * TH; i++) {
        const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), de = mx - mn;
        const sat = mx === 0 ? 0 : de / mx;
        if (mx >= 0.65 && sat <= 0.35) white[i] = 1;
        if (de > 0.001) {   // STRICT red (excludes orange score/logos)
          let h = mx === r ? ((g - b) / de) % 6 : mx === g ? (b - r) / de + 2 : (r - g) / de + 4;
          h = (h * 60 + 360) % 360;
          if ((h <= 20 || h >= 340) && sat >= 0.4 && mx >= 0.3) red[i] = 1;
        }
      }
      let best = 0, bestP = -1, bestRed = 0;
      for (let p = 0; p <= BW - TW; p++) {
        let rsum = 0;
        for (let ty = 0; ty < TH; ty++)
          for (let tx = 0; tx < TW; tx++) rsum += red[ty * BW + p + tx];
        const rfrac = rsum / (TW * TH);
        if (rfrac < 0.15) continue;   // the icon sits on a red box
        for (let m = 0; m < 2; m++) {
          const mask = m === 0 ? CS_MASK : CS_MASK_M;
          let inter = 0, uni = 0;
          for (let ty = 0; ty < TH; ty++)
            for (let tx = 0; tx < TW; tx++) {
              const t = mask[ty * TW + tx], w = white[ty * BW + p + tx];
              if (w && t) inter++;
              if (w || t) uni++;
            }
          const iou = uni > 0 ? inter / uni : 0;
          if (iou > best) { best = iou; bestP = p; bestRed = rfrac; }
        }
      }
      return { iou: best, side: bestP < 0 ? null : (bestP < (BW - TW) / 2 ? "L" : "R"), red: bestRed };
    }

    // Per-tick detection: timer digits DISAPPEAR (-> dash) AND the C4 badge is
    // present on either side. Digits-gone gives accurate timing (anchored to when
    // they first vanished); the C4 SHAPE rejects the red "ROUND WIN" banner.
    poll() {
      if (this.profile === 1 || this.profile === 3) return this.pollCenter();
      const c = frames.sample(CS_TIMER_ROI);
      if (!c) return { plant: false, status: waitingStatus(), debug: null };
      if (c.white > 0.08) { this.armed = true; this.baseline = Math.max(this.baseline * 0.95, c.white); }
      const digitsGone = this.armed && this.baseline > 0.08 && c.white < 0.5 * this.baseline;
      if (digitsGone) { if (this.dgRun === 0) this.firstGoneAt = performance.now(); this.dgRun++; } else this.dgRun = 0;
      const bs = this.scan();
      if (digitsGone && bs.iou >= this.threshold && bs.side) this.run++; else this.run = 0;
      const debug = {
        mode: "cs2", white: c.white, base: this.baseline, gone: digitsGone,
        scanIoU: bs.iou, scanRed: bs.red, side: bs.side || "-", run: this.run,
      };
      if (this.run >= this.confirmK) return { plant: true, plantTime: this.firstGoneAt, debug };
      return { plant: false, status: this.armed ? "Watching for plant…" : "Waiting for round HUD…", debug };
    }

    // Profile 1 per-tick detection: in the center slot the timer DIGITS vanish AND
    // red appears (the C4 icon replaces the timer). The digits-gone baseline is
    // adaptive (learns this stream's white level), so it works across broadcasts;
    // requiring red too rejects a brief timer occlusion. Anchored to when the
    // digits first vanished, like Profile 2.
    pollCenter() {
      const c = frames.sample(this.centerRoi);
      if (!c) return { plant: false, status: waitingStatus(), debug: null };
      if (c.white > 0.06) { this.armed = true; this.baseline = Math.max(this.baseline * 0.95, c.white); }
      const digitsGone = this.armed && this.baseline > 0.06 && c.white < 0.5 * this.baseline;
      const warmPresent = c.warm >= this.warmThreshold;
      // The plant signal. PLAYER POV (P3) needs a "more red than white" trigger:
      // `warm > white` is flicker-free where the bright in-game background bounces
      // the white reading around the digits-gone threshold (which otherwise keeps
      // resetting the confirm counter → lag). But on a BROADCAST center HUD (P1)
      // that OR caused random MID-ROUND false fires — a warm background (fire,
      // molotov, a reddish map area, an orange element bleeding into the slot) can
      // push warm above white WHILE the timer digits are still showing. So P1
      // relies on digits-gone alone (its robust, validated signal); warm>white is
      // restricted to P3. (warmPresent still gates both.)
      const slotRed = digitsGone || (this.profile === 3 && c.warm > c.white);
      // Anchor to when slotRed+warm FIRST hold (the real plant), not digits-gone
      // alone — in player POV the timer can read "gone" for ~20s during a death/
      // spectate before any plant, which would wind the countdown down.
      if (slotRed && warmPresent) { if (this.run === 0) this.firstGoneAt = performance.now(); this.run++; } else this.run = 0;
      const debug = { mode: "cs2-center", white: c.white, base: this.baseline, gone: digitsGone, warm: c.warm, c4: slotRed && warmPresent, run: this.run };
      if (this.run >= this.confirmK) return { plant: true, plantTime: this.firstGoneAt, debug };
      return { plant: false, status: this.armed ? "Watching for plant…" : "Waiting for round HUD…", debug };
    }

    // "Still planted?" — Profile 2: C4 SHAPE only (NOT red: a defuse shows a red
    // "ROUND WIN" banner here, which would keep it falsely "present"). Defused
    // ~0.13 vs planted 0.4–1.0, so 0.18 + the GONE_K debounce separates them.
    // Profile 1: the red C4 icon is present in the center slot while planted; it
    // disappears on defuse/detonate. Lenient threshold so brief washouts hold.
    stillPlanted() {
      if (this.profile === 1 || this.profile === 3) {
        const c = frames.sample(this.centerRoi);
        if (!c) return { present: null };
        return { present: c.warm >= this.warmThreshold * 0.6, value: c.warm };
      }
      const bs = this.scan();
      return { present: bs.iou > 0.18, value: bs.iou };
    }

    reset(hard) {
      super.reset(hard);
      this.dgRun = 0; this.firstGoneAt = 0;
      if (hard) { this.armed = false; this.baseline = 0; }
    }
  }

  const GAMES = { valorant: new ValorantGame(), cs2: new CS2Game() };

  // ---- debug ROI overlay ----------------------------------------------------
  // Draws the sampled ROI rectangles over the video (debug build only). Maps a
  // video-content ROI (fractions) to on-screen px, accounting for letterbox/
  // pillarbox bars inside the <video> element.
  class DebugBoxes {
    constructor() {
      this.roiBox = null;
      this.badgeBox = null;
      this.leftBox = null;
    }

    mkBox(color) {
      const b = document.createElement("div");
      b.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;border:2px solid ${color};box-shadow:0 0 0 1px rgba(0,0,0,.6);`;
      document.documentElement.appendChild(b);
      return b;
    }

    placeBox(b, roi) {
      const v = frames.getVideo();
      if (!v || !v.videoWidth) { b.style.display = "none"; return; }
      const r = v.getBoundingClientRect();
      const arEl = r.width / r.height, arVid = v.videoWidth / v.videoHeight;
      let cw, ch, ox, oy;
      if (arVid > arEl) { cw = r.width; ch = r.width / arVid; ox = 0; oy = (r.height - ch) / 2; }
      else { ch = r.height; cw = r.height * arVid; oy = 0; ox = (r.width - cw) / 2; }
      b.style.display = "block";
      b.style.left = (r.left + ox + roi.x * cw) + "px";
      b.style.top = (r.top + oy + roi.y * ch) + "px";
      b.style.width = (roi.w * cw) + "px";
      b.style.height = (roi.h * ch) + "px";
    }

    update() {
      if (!this.roiBox) this.roiBox = this.mkBox(PALETTE.teal);
      if (cfg.game === "cs2") {
        if (GAMES.cs2.profile === 1 || GAMES.cs2.profile === 3) {
          this.placeBox(this.roiBox, GAMES.cs2.centerRoi);   // center (P2) or top-center (P3) timer/C4-icon slot
          if (this.badgeBox) this.badgeBox.style.display = "none";
        } else {
          this.placeBox(this.roiBox, CS_TIMER_ROI);
          if (!this.badgeBox) this.badgeBox = this.mkBox("#f59e0b");
          this.placeBox(this.badgeBox, CS_BAND);
        }
        if (this.leftBox) { this.leftBox.style.display = "none"; }
      } else {
        this.placeBox(this.roiBox, TIMER_ROI);
        if (this.badgeBox) this.badgeBox.style.display = "none";
        if (this.leftBox) this.leftBox.style.display = "none";
      }
    }

    hide() {
      if (this.roiBox) { this.roiBox.remove(); this.roiBox = null; }
      if (this.badgeBox) { this.badgeBox.remove(); this.badgeBox = null; }
      if (this.leftBox) { this.leftBox.remove(); this.leftBox = null; }
    }
  }

  const boxes = new DebugBoxes();

  // ---- detection loop -------------------------------------------------------
  // Status shown when we can't read a frame (no video yet, or cross-origin taint).
  function waitingStatus() {
    return frames.tainted
      ? "Can't read this player's pixels (cross-origin). Use the manual trigger."
      : "Waiting for stream…";
  }

  // The detection state machine + loops. Polls the active game 4x/sec; on a
  // confirmed plant, anchors the countdown and renders it; while counting down,
  // watches for a defuse. Owns all the runtime timing state.
  class Detector {
    constructor() {
      this.planted = false;
      this.detonateAt = 0;
      this.goneCount = 0;        // consecutive ticks the indicator is absent (defuse)
      this.monIoU = null;        // live indicator value while counting down (debug)
      this.cooldownUntil = 0;    // suppress detection until this time (post-round)
      this.detectTimer = null;
      this.renderTimer = null;
    }

    start() {
      if (this.detectTimer) clearInterval(this.detectTimer);
      cfg.running = true;
      this.reset(false);
      overlay.set("Watching for plant…", null);
      this.detectTimer = setInterval(() => this.tick(), TICK_MS);
    }

    stop() {
      cfg.running = false;
      if (this.detectTimer) clearInterval(this.detectTimer); this.detectTimer = null;
      this.stopRender(); this.reset(false); boxes.hide(); panel.close(); overlay.remove();
    }

    reset(toWatching) {
      this.planted = false; this.goneCount = 0; this.monIoU = null;
      // hard reset (!toWatching) also clears each game's round-learned state.
      for (const g of Object.values(GAMES)) g.reset(!toWatching);
      this.stopRender();
    }

    tick() {
      if (!cfg.running) return;
      panel.paintScore();
      if (this.planted) { this.monitorPlant(); return; }
      const game = GAMES[cfg.game];
      if (performance.now() < this.cooldownUntil) {
        game.reset(false);                 // clear confirm counters; keep baseline
        overlay.set("Post-round cooldown…", null);
        return;
      }
      if (debugOn) boxes.update();
      // Each game owns its per-tick detection (icon shape / digits-gone + C4 scan).
      const r = game.poll();
      if (r.debug) dbg = r.debug;          // leave dbg stale when a frame can't be read
      if (r.plant) return this.triggerPlant("auto", r.plantTime);
      overlay.set(r.status, null);
    }

    triggerPlant(src, plantTime) {
      if (this.planted) return;
      this.planted = true;
      this.goneCount = 0; this.monIoU = null;
      boxes.hide();
      const t0 = plantTime || performance.now();
      this.detonateAt = t0 + GAMES[cfg.game].fuse * 1000;
      this.startRender();
    }

    // While counting down, watch the plant indicator. If it's absent for GONE_K
    // samples and time still remains, the spike was defused (or round ended).
    monitorPlant() {
      const rem = this.detonateAt - performance.now();
      if (rem <= 1500) { this.monIoU = null; return; }  // too close to detonation
      const s = GAMES[cfg.game].stillPlanted();
      if (s.present === null) return;     // can't read; assume still planted
      this.monIoU = s.value;
      if (!s.present) this.goneCount++; else this.goneCount = 0;
      if (this.goneCount >= GONE_K) this.onDefused();
    }

    onDefused() {
      this.stopRender();
      this.planted = false; this.goneCount = 0; this.monIoU = null; dbg = null;
      this.cooldownUntil = performance.now() + GAMES[cfg.game].cooldownMs;   // skip the replay
      overlay.set(cfg.game === "cs2" ? "Bomb defused / cleared" : "Spike defused / cleared", null, PALETTE.teal);
      setTimeout(() => { this.reset(true); if (cfg.running) overlay.set("Watching for plant…", null); }, 2500);
    }

    startRender() {
      this.stopRender();
      this.renderTimer = setInterval(() => this.renderCountdown(), 80);
      this.renderCountdown();
    }
    stopRender() { if (this.renderTimer) clearInterval(this.renderTimer); this.renderTimer = null; }

    renderCountdown() {
      const rem = this.detonateAt - performance.now();
      if (rem <= 0) {
        overlay.set("DETONATED", 0, PALETTE.danger);
        this.cooldownUntil = performance.now() + GAMES[cfg.game].cooldownMs;   // skip the replay
        setTimeout(() => { this.reset(true); }, 2500);
        this.stopRender();
        return;
      }
      const secs = rem / 1000;
      const g = GAMES[cfg.game];
      const color = secs > g.yellowAt ? PALETTE.safe : secs > g.redAt ? PALETTE.caution : PALETTE.danger;
      const label = (cfg.game === "cs2" ? "BOMB PLANTED" : "SPIKE PLANTED")
        + (debugOn && this.monIoU != null ? `  · ${this.monIoU.toFixed(2)}` : "");
      overlay.set(label, secs, color);
    }
  }

  // ---- overlay HUD ----------------------------------------------------------
  // The bottom-right countdown card. Built ONCE with stable elements + button
  // handlers; per-tick updates only touch text/styles (rebuilding innerHTML each
  // tick was destroying buttons mid-click). Draggable; position is persisted.
  class Overlay {
    constructor() {
      this.hud = null;
      this.el = {};
      this.minimized = false;
      this.drag = { on: false, dx: 0, dy: 0 };
      // Drag handled at the window level so the pointer can leave the card.
      window.addEventListener("mousemove", (e) => {
        if (!this.drag.on || !this.hud) return;
        this.place(e.clientX - this.drag.dx, e.clientY - this.drag.dy);
      });
      window.addEventListener("mouseup", () => {
        if (!this.drag.on || !this.hud) return;
        this.drag.on = false;
        const r = this.hud.getBoundingClientRect();
        try { chrome.storage.local.set({ hudPos: { left: r.left, top: r.top } }); } catch (e) {}
      });
    }

    ensure() {
      if (this.hud) return;
      injectFont(document);
      const pipSupported = "documentPictureInPicture" in window;
      const hud = document.createElement("div");
      hud.id = "defuse-time-hud";
      hud.style.cssText = [
        "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
        "min-width:180px", "color:" + PALETTE.text,
        // Subdued take on the popup's violet gradient + teal glow (sits over a
        // live stream, so it's near-opaque).
        "background:radial-gradient(120% 90% at 100% 0%,rgba(45,212,191,.12),transparent 55%),linear-gradient(160deg,rgba(14,11,26,.96),rgba(46,29,82,.96))",
        "border:1px solid rgba(167,139,250,.18)", "border-radius:14px",
        "padding:10px 12px", "font:12px/1.4 " + FONT_STACK,
        "box-shadow:0 12px 34px rgba(0,0,0,.45)", "cursor:move",
        "user-select:none",
      ].join(";");
      hud.innerHTML = `
        <div id="dt-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">
          <b id="dt-title">Defuse Timer</b>
          <span style="display:flex;align-items:center;gap:8px;">
            <span id="dt-label" style="font-size:11px;color:#9b93b4;"></span>
            <button id="dt-min" title="Minimize" style="border:0;border-radius:6px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;background:#2e2748;color:#ece9f5;cursor:pointer;font-size:14px;">–</button>
            <button id="dt-close" title="Close (stop watching)" style="border:0;border-radius:6px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;background:#2e2748;color:#ece9f5;cursor:pointer;font-size:14px;">×</button>
          </span>
        </div>
        <div id="dt-status" style="color:#9b93b4;margin-bottom:2px;"></div>
        <div id="dt-big" style="font-size:16px;font-weight:700;"></div>
        <div style="margin-top:8px;height:6px;background:#211a36;border-radius:999px;overflow:hidden;">
          <div id="dt-bar" style="height:100%;width:0%;background:${PALETTE.barIdle};transition:width 80ms linear;"></div>
        </div>
        <div id="dt-dbg" style="margin-top:6px;font:11px/1.5 monospace;color:#5eead4;"></div>
        <div style="margin-top:8px;display:flex;gap:6px;">
          <button id="dt-plant" style="flex:1;border:0;border-radius:7px;padding:6px;background:linear-gradient(180deg,#e11d48,#9f1239);color:#fdeef1;font-weight:700;cursor:pointer;">Plant now</button>
          <button id="dt-cancel" style="border:0;border-radius:7px;padding:6px 10px;background:#2e2748;color:#ece9f5;cursor:pointer;">Reset</button>
          ${pipSupported ? `<button id="dt-pip" title="Open the floating timer" style="border:0;border-radius:7px;padding:6px 10px;background:#2dd4bf;color:#04342f;font-weight:600;cursor:pointer;">⧉ Float</button>` : ``}
        </div>`;
      document.documentElement.appendChild(hud);
      this.hud = hud;
      this.el = {
        label: hud.querySelector("#dt-label"), status: hud.querySelector("#dt-status"),
        big: hud.querySelector("#dt-big"), bar: hud.querySelector("#dt-bar"),
        dbg: hud.querySelector("#dt-dbg"),
      };
      hud.querySelector("#dt-plant").onclick = () => detector.triggerPlant("manual");
      hud.querySelector("#dt-cancel").onclick = () => { detector.reset(true); this.set("Watching for plant…", null); };
      hud.querySelector("#dt-close").onclick = () => detector.stop();
      hud.querySelector("#dt-pip").onclick = () => panel.open();
      // The Floating timer uses Document Picture-in-Picture (Chromium only).
      // On browsers without it (e.g. Firefox) hide the button so there's no
      // dead control. Same capability check PopoutPanel.open() guards on.
      if (!hasDocPiP()) {
        hud.querySelector("#dt-pip").style.display = "none";
      }
      hud.querySelector("#dt-min").onclick = () => this.toggleMin();
      // Hidden when minimized (leaves header + countdown). Remember each one's
      // display so restoring keeps the buttons row as flex (not block), etc.
      this.collapsible = [
        hud.querySelector("#dt-title"), this.el.label, this.el.status,
        this.el.bar.parentElement, this.el.dbg,
        hud.querySelector("#dt-plant").parentElement,
      ].filter(Boolean).map((el) => ({ el, disp: el.style.display }));

      // Drag to move (anywhere except the buttons).
      hud.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.tagName === "BUTTON") return;
        const r = hud.getBoundingClientRect();
        this.drag.on = true; this.drag.dx = e.clientX - r.left; this.drag.dy = e.clientY - r.top;
        e.preventDefault();
      });
      // Restore saved position + minimized state.
      try {
        chrome.storage.local.get(["hudPos", "hudMin"]).then(({ hudPos, hudMin }) => {
          if (hudPos && this.hud) this.place(hudPos.left, hudPos.top);
          if (hudMin) { this.minimized = true; this.applyMin(); }
        });
      } catch (e) { /* storage may be unavailable */ }
    }

    place(left, top) {
      const r = this.hud.getBoundingClientRect();
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, left));
      const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, top));
      this.hud.style.left = x + "px"; this.hud.style.top = y + "px";
      this.hud.style.right = "auto"; this.hud.style.bottom = "auto";
    }

    // Collapse to just the header + countdown (and back). Persisted across reloads.
    toggleMin() {
      this.minimized = !this.minimized;
      this.applyMin();
      try { chrome.storage.local.set({ hudMin: this.minimized }); } catch (e) {}
    }
    applyMin() {
      for (const c of this.collapsible || []) c.el.style.display = this.minimized ? "none" : c.disp;
      // Minimized = a tight chip: hide the title (in `collapsible`), shrink padding
      // + the countdown number, and hug the controls to the right so it's a small
      // badge showing just the countdown.
      if (this.hud) {
        this.hud.style.minWidth = this.minimized ? "0px" : "180px";
        this.hud.style.padding = this.minimized ? "7px 10px" : "10px 12px";
      }
      const hdr = this.hud && this.hud.querySelector("#dt-header");
      if (hdr) {
        hdr.style.marginBottom = this.minimized ? "2px" : "6px";
        hdr.style.justifyContent = this.minimized ? "flex-end" : "space-between";
      }
      if (this.el && this.el.big) this.el.big.style.fontSize = this.minimized ? "13px" : "16px";
      const b = this.hud && this.hud.querySelector("#dt-min");
      if (b) { b.textContent = this.minimized ? "□" : "–"; b.title = this.minimized ? "Expand" : "Minimize"; }
    }

    set(status, secs, color) {
      this.ensure();
      const el = this.el;
      const fuse = GAMES[cfg.game].fuse;
      const pct = secs == null ? 0 : Math.max(0, Math.min(1, secs / fuse));
      const bigTxt = secs == null ? "—" : secs.toFixed(1) + "s";
      el.label.textContent = `${GAMES[cfg.game].label}${debugOn ? " · debug" : ""}`;
      el.status.textContent = status;
      el.big.textContent = bigTxt;
      el.big.style.color = color || PALETTE.text;
      el.bar.style.width = (pct * 100).toFixed(1) + "%";
      el.bar.style.background = color || PALETTE.barIdle;
      // Mirror to the pop-out panel if open.
      panel.update(status, bigTxt, color, pct);
      if (debugOn && secs == null && dbg) {
        const f = (x) => x == null ? "–" : x.toFixed(3);
        const th = GAMES[cfg.game].threshold;
        const body = dbg.mode === "valo"
          ? `iconIoU=${f(dbg.iou)} (need ≥${th})<br>${dbg.iou >= th ? "ICON✓" : "no-icon"}`
          : dbg.mode === "cs2-center"
          ? `${dbg.gone ? "GONE" : "digits"} (w=${f(dbg.white)})<br>warm=${f(dbg.warm)} (need ≥${GAMES.cs2.warmThreshold})<br>${dbg.c4 ? "C4✓" : "no-C4"}`
          : `${dbg.gone ? "GONE" : "digits"} (w=${f(dbg.white)})<br>scan iou=${f(dbg.scanIoU)} red=${f(dbg.scanRed)}<br>bomb=${dbg.side}`;
        el.dbg.innerHTML = `${body}<br>plantRun=${dbg.run}/${GAMES[cfg.game].confirmK}`;
      } else {
        el.dbg.innerHTML = "";
      }
    }

    remove() { if (this.hud) this.hud.remove(); this.hud = null; this.el = {}; }
  }

  const overlay = new Overlay();

  // ---- pop-out panel (Document Picture-in-Picture) --------------------------
  // A second-monitor window: the countdown + a LIVE pixel mirror of the
  // score/round bar (no OCR — copied pixels can't misread). Owns its own window
  // and element refs. overlay.set() pushes countdown updates here via update().
  class PopoutPanel {
    constructor() {
      this.win = null;
      this.els = {};
    }

    async open() {
      if (!hasDocPiP()) {
        overlay.set("Floating timer needs Chrome 116+ (not supported here)", null);
        return;
      }
      if (this.win) { try { this.win.focus(); } catch (e) {} return; }
      let w;
      try {
        w = await window.documentPictureInPicture.requestWindow({ width: 320, height: 220 });
      } catch (e) { return; }
      this.win = w;
      const d = w.document;
      injectFont(d);
      d.body.style.cssText = "margin:0;background:#120e22;color:" + PALETTE.text +
        ";font:13px/1.4 " + FONT_STACK + ";";
      d.body.innerHTML = `
        <div style="padding:12px 14px;">
          <canvas id="p-score" style="width:100%;display:block;border-radius:6px;background:#211a36;margin-bottom:8px;"></canvas>
          <div id="p-status" style="color:#9b93b4;margin-bottom:2px;">Watching for plant…</div>
          <div id="p-big" style="font-size:38px;font-weight:700;line-height:1.1;">—</div>
          <div style="margin-top:8px;height:7px;background:#211a36;border-radius:999px;overflow:hidden;">
            <div id="p-bar" style="height:100%;width:0%;background:${PALETTE.barIdle};transition:width 80ms linear;"></div>
          </div>
        </div>`;
      const sc = d.getElementById("p-score");
      this.els = {
        score: sc, sctx: sc.getContext("2d"),
        status: d.getElementById("p-status"), big: d.getElementById("p-big"), bar: d.getElementById("p-bar"),
      };
      w.addEventListener("pagehide", () => { this.win = null; this.els = {}; });
      this.paintScore();
    }

    close() {
      if (this.win) { try { this.win.close(); } catch (e) {} }
      this.win = null; this.els = {};
    }

    // Mirror the countdown text + progress bar from the main overlay.
    update(status, bigTxt, color, pct) {
      if (!this.win || !this.els.big) return;
      this.els.status.textContent = status;
      this.els.big.textContent = bigTxt;
      this.els.big.style.color = color || PALETTE.text;
      this.els.bar.style.width = (pct * 100).toFixed(1) + "%";
      this.els.bar.style.background = color || PALETTE.barIdle;
    }

    // Mirror the score-bar strip (team tags + scores + round) into the panel.
    paintScore() {
      if (!this.win || !this.els.score) return;
      const v = frames.getVideo();
      if (!v || !v.videoWidth) return;
      const vw = v.videoWidth, vh = v.videoHeight;
      const roi = GAMES[cfg.game].scoreRoi;
      const sw = Math.max(1, Math.round(roi.w * vw));
      const sh = Math.max(1, Math.round(roi.h * vh));
      if (this.els.score.width !== sw || this.els.score.height !== sh) { this.els.score.width = sw; this.els.score.height = sh; }
      try {
        this.els.sctx.drawImage(v, roi.x * vw, roi.y * vh,
          roi.w * vw, roi.h * vh, 0, 0, sw, sh);
      } catch (e) { /* tainted/unavailable */ }
    }
  }

  const panel = new PopoutPanel();

  // ---- control --------------------------------------------------------------
  const detector = new Detector();

  window.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    if (e.code === "KeyP") { e.preventDefault(); if (!cfg.running) detector.start(); detector.triggerPlant("manual"); }
    if (e.code === "KeyC") { e.preventDefault(); detector.reset(true); if (cfg.running) overlay.set("Watching for plant…", null); }
    if (e.code === "KeyX") { e.preventDefault(); detector.stop(); }
  });

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === "DT_SET_GAME") { cfg.game = msg.game; if (cfg.running) overlay.set("Watching for plant…", null); }
    else if (msg.type === "DT_START") { cfg.game = msg.game || cfg.game; detector.start(); }
    else if (msg.type === "DT_STOP") { detector.stop(); }
    else if (msg.type === "DT_PLANT") { if (!cfg.running) detector.start(); detector.triggerPlant("manual"); }
    else if (msg.type === "DT_SET_SETTINGS") { applySettings(msg.game, msg); }
    else if (msg.type === "DT_SET_PROFILE") {
      GAMES.cs2.setProfile(msg.profile);
      if (debugOn) boxes.update();
      if (cfg.running) overlay.set("Watching for plant…", null);
    }
    else if (msg.type === "DT_SET_DEBUG") { setDebug(msg.on); }
    else if (msg.type === "DT_STATE") { send({ running: cfg.running, game: cfg.game, tainted: frames.tainted, csProfile: GAMES.cs2.profile }); return true; }
    send && send({ ok: true });
  });

  // Per-game user settings (sliders): detection threshold + post-round cooldown.
  // Defaults live on the Game instances; this only overrides when a value is set.
  function applySettings(game, s) {
    const g = GAMES[game];
    if (!g || !s) return;
    if (typeof s.threshold === "number") g.threshold = s.threshold;
    if (typeof s.warmThreshold === "number" && "warmThreshold" in g) g.warmThreshold = s.warmThreshold;  // CS2 center/player warm gate
    if (typeof s.cooldown === "number") g.cooldownMs = s.cooldown * 1000;   // slider is in seconds
    // Confirmation delay: how long the plant must hold before showing (filters
    // brief false positives). Slider is seconds; convert to ticks (>=1). The
    // countdown still anchors to the true plant moment, so it stays accurate.
    if (typeof s.confirmDelay === "number") g.confirmK = Math.max(1, Math.round(s.confirmDelay * 1000 / TICK_MS));
  }
  // Debug HUD toggle (ROI boxes + live value readout). Default OFF for release.
  function setDebug(on) {
    debugOn = !!on;
    if (!debugOn) boxes.hide();
  }
  try {
    chrome.storage.local.get(["settings", "debug", "csProfile"]).then(({ settings, debug, csProfile }) => {
      if (settings) for (const k of ["valorant", "cs2"]) applySettings(k, settings[k]);
      if (csProfile) GAMES.cs2.setProfile(csProfile);
      setDebug(debug);
    });
  } catch (e) { /* storage unavailable */ }
})();
