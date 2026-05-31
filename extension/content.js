/* Defuse Time — content script.
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

  const GAMES = {
    // redAt/yellowAt = countdown color thresholds, in seconds REMAINING.
    //   red when secs <= redAt, yellow when redAt < secs <= yellowAt, else green.
    // Tied to defuse time: red = "too late to defuse", yellow = "tight".
    // Valorant defuse = 7s (red = 7, yellow band = next 14s -> 21).
    // CS2 defuse = 5s (kit) / 10s (no kit); kept at the original 5/10 split.
    valorant: { fuse: 45, label: "Valorant", redAt: 7, yellowAt: 21 },
    cs2: { fuse: 40, label: "CS2", redAt: 5, yellowAt: 10 },
  };

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
  const COOLDOWN_MS = 12000;   // suppress detection right after a round resolves
  // Top score-bar strip (team tags + scores + round) for the pop-out panel.
  // Mirrored as pixels (no OCR) so it's always correct, on any HUD skin.
  const SCORE_ROI = { x: 0.34, y: 0.0, w: 0.33, h: 0.065 };
  // Consecutive samples the plant condition must hold before firing (at TICK_MS
  // = 250ms, 3 → ~0.75s). A real plant persists 40–45s, so this rejects blips
  // while staying responsive.
  const CONFIRM_K = 3;
  // While planted, if the plant indicator is ~absent for GONE_K samples (and
  // time still remains), the round ended early -> treat as DEFUSED and clear.
  // At 250ms/sample, 6 = 1.5s — long enough to ignore brief dips/washouts.
  const GONE_K = 6;

  const cfg = { game: "valorant", running: false };
  let armed = false;        // have we seen timer digits (we're in a live round)?
  let baseline = 0;         // rolling max white-fraction while digits show
  let plantRun = 0;         // consecutive ticks meeting the full plant condition
  let firstPlantAt = 0;     // when the plant condition first held (= plant time)
  let firstDigitsGoneAt = 0;// CS2: when the timer digits first vanished (= plant)
  let dgRun = 0;            // CS2: consecutive ticks the digits have been gone
  let cooldownUntil = 0;    // suppress detection until this time (post-round)
  let planted = false;
  let goneCount = 0;        // consecutive ticks the indicator is absent (defuse)
  let monIoU = null;        // live indicator value while counting down (debug)
  let detonateAt = 0;
  let detectTimer = null, renderTimer = null;

  let hud = null;
  let roiBox = null, badgeBox = null, leftBox = null, dbg = null;
  let drag = { on: false, dx: 0, dy: 0 };
  const VERSION = "0.2.9-debug";
  const TICK_MS = 250;   // sample 4x/sec so confirmation (CONFIRM_K) is fast

  // Valorant spike-icon shape templates (30x16 red-masks), extracted from real
  // plants. Matching the SHAPE (not just "is there red") is what distinguishes
  // the plant from the red low-time round-timer, which is also red in this slot.
  // Broadcasts can render the icon differently (size/style varies per tournament)
  // so iconMatch() takes the BEST IoU across all templates. Add a new broadcast's
  // template here once measured from REAL planted frames (tools/ workflow).
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
  let tcanvas = document.createElement("canvas");
  tcanvas.width = ICON.TW; tcanvas.height = ICON.TH;
  let tcx = tcanvas.getContext("2d", { willReadFrequently: true });

  // ---- video sampling -------------------------------------------------------
  // FrameSampler owns everything that touches the page <video> and the main
  // sampling canvas. ROIs are given as FRACTIONS of the video frame, so sampling
  // is independent of stream resolution and of co-stream/webcam layouts. The
  // other pixel readers (iconMatch, bombScan, paintScore) still keep their own
  // small canvases for now; they share this object's getVideo() and `tainted`.
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

    // {white, red} fractions inside the ROI, or null if no frame / canvas tainted.
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
      let white = 0, red = 0, n = sw * sh;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        const sat = mx === 0 ? 0 : d / mx;
        if (mx >= 0.7 && sat <= 0.25) white++;              // bright low-sat = digits
        if (d > 0.001) {                                    // hue near red
          let h;
          if (mx === r) h = ((g - b) / d) % 6;
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
          if ((h <= 18 || h >= 342) && sat >= 0.4 && mx >= 0.3) red++;
        }
      }
      return { white: white / n, red: red / n };
    }
  }

  const frames = new FrameSampler();

  // IoU of the timer-slot red shape vs the spike-icon template. Drawing the ROI
  // to a fixed 30x16 canvas normalizes size across stream resolutions.
  function iconMatch() {
    const v = frames.getVideo();
    if (!v || !v.videoWidth) return null;
    const vw = v.videoWidth, vh = v.videoHeight;
    try {
      tcx.drawImage(v, TIMER_ROI.x * vw, TIMER_ROI.y * vh,
        TIMER_ROI.w * vw, TIMER_ROI.h * vh, 0, 0, ICON.TW, ICON.TH);
      var d = tcx.getImageData(0, 0, ICON.TW, ICON.TH).data;
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

  // CS2 bomb-icon box: returns {red, iou} — red fill of the box + white-mask IoU
  // of the C4 symbol vs template. A real PLANTED badge has both; the "ROUND WIN"
  // banner is red but has no C4 symbol (low iou).
  let bcanvas = document.createElement("canvas");
  bcanvas.width = CS_BW; bcanvas.height = CS_BOMB.TH;
  let bcx = bcanvas.getContext("2d", { willReadFrequently: true });
  // Slide the C4 template (and its mirror) across the band; return the best
  // match: { iou, side, red }. Position-independent, side-independent.
  function bombScan() {
    const v = frames.getVideo();
    if (!v || !v.videoWidth) return { iou: 0, side: null, red: 0 };
    const vw = v.videoWidth, vh = v.videoHeight, TW = CS_BOMB.TW, TH = CS_BOMB.TH, BW = CS_BW;
    try {
      bcx.drawImage(v, CS_BAND.x * vw, CS_BAND.y * vh, CS_BAND.w * vw, CS_BAND.h * vh, 0, 0, BW, TH);
      var data = bcx.getImageData(0, 0, BW, TH).data;
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

  // ---- debug ROI overlay ----------------------------------------------------
  // Maps a video-content ROI (fractions) to on-screen px, accounting for any
  // letterbox/pillarbox bars inside the <video> element, then draws a box.
  function mkBox(color) {
    const b = document.createElement("div");
    b.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;border:2px solid ${color};box-shadow:0 0 0 1px rgba(0,0,0,.6);`;
    document.documentElement.appendChild(b);
    return b;
  }
  function placeBox(b, roi) {
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
  function updateBoxes() {
    if (!roiBox) roiBox = mkBox("#22d3ee");
    if (cfg.game === "cs2") {
      placeBox(roiBox, CS_TIMER_ROI);
      if (!badgeBox) badgeBox = mkBox("#f59e0b");
      placeBox(badgeBox, CS_BAND);
      if (leftBox) { leftBox.style.display = "none"; }
    } else {
      placeBox(roiBox, TIMER_ROI);
      if (badgeBox) badgeBox.style.display = "none";
      if (leftBox) leftBox.style.display = "none";
    }
  }
  function hideBoxes() {
    if (roiBox) { roiBox.remove(); roiBox = null; }
    if (badgeBox) { badgeBox.remove(); badgeBox = null; }
    if (leftBox) { leftBox.remove(); leftBox = null; }
  }

  // ---- detection loop -------------------------------------------------------
  function detectTick() {
    if (!cfg.running) return;
    panel.paintScore();
    if (planted) { monitorPlant(); return; }
    if (performance.now() < cooldownUntil) {
      plantRun = 0; dgRun = 0;
      setHud("Post-round cooldown…", null);
      return;
    }
    updateBoxes();

    if (cfg.game === "valorant") {
      // Valorant: match the spike-icon SHAPE in the timer slot. This rejects the
      // red low-time round-timer (also red, but digit-shaped -> low IoU).
      const iou = iconMatch();
      if (iou == null) {
        setHud(frames.tainted
          ? "Can't read this player's pixels (cross-origin). Use the manual trigger."
          : "Waiting for stream…", null);
        return;
      }
      if (iou >= ICON_IOU) {
        if (plantRun === 0) firstPlantAt = performance.now();
        plantRun++;
      } else plantRun = 0;
      dbg = { mode: "valo", iou, run: plantRun };
      if (plantRun >= CONFIRM_K) return triggerPlant("auto", firstPlantAt);
      setHud("Watching for plant…", null);
      return;
    }

    // CS2: timer digits DISAPPEAR (-> dash) AND the bomb-icon badge (C4 shape on
    // a red box) is present on EITHER side. Digits-gone gives accurate timing
    // (anchored to when they first vanished, not when the badge solidifies); the
    // C4 SHAPE check rejects the red "ROUND WIN" banner. Cooldown above guards
    // the post-round replay.
    const c = frames.sample(CS_TIMER_ROI);
    if (!c) {
      setHud(frames.tainted
        ? "Can't read this player's pixels (cross-origin). Use the manual trigger."
        : "Waiting for stream…", null);
      return;
    }
    if (c.white > 0.08) { armed = true; baseline = Math.max(baseline * 0.95, c.white); }
    const digitsGone = armed && baseline > 0.08 && c.white < 0.5 * baseline;
    if (digitsGone) { if (dgRun === 0) firstDigitsGoneAt = performance.now(); dgRun++; } else dgRun = 0;

    const bs = bombScan();
    if (digitsGone && bs.iou >= CS_ICON_IOU && bs.side) plantRun++; else plantRun = 0;
    dbg = {
      mode: "cs2", white: c.white, base: baseline, gone: digitsGone,
      scanIoU: bs.iou, scanRed: bs.red, side: bs.side || "-", run: plantRun,
    };
    if (plantRun >= CONFIRM_K) return triggerPlant("auto", firstDigitsGoneAt);

    setHud(armed ? "Watching for plant…" : "Waiting for round HUD…", null);
  }

  function triggerPlant(src, plantTime) {
    if (planted) return;
    planted = true;
    goneCount = 0; monIoU = null;
    hideBoxes();
    const t0 = plantTime || performance.now();
    detonateAt = t0 + GAMES[cfg.game].fuse * 1000;
    startRender();
  }

  // While counting down, watch the plant indicator. If it's absent for GONE_K
  // samples and time still remains, the spike was defused (or round ended).
  function monitorPlant() {
    const rem = detonateAt - performance.now();
    if (rem <= 1500) { monIoU = null; return; }  // too close to detonation
    let present;
    if (cfg.game === "valorant") {
      const iou = iconMatch();
      if (iou == null) return;          // can't read; assume still planted
      monIoU = iou;
      present = iou >= 0.30;            // lenient: brief washouts still "present"
    } else {
      // "Still planted?" — C4 SHAPE only (NOT red: a defuse shows a red "ROUND
      // WIN" banner here, which would keep it falsely "present"). Defused reads
      // ~0.13 vs planted 0.4–1.0, so 0.18 + the GONE_K debounce separates them.
      const bs = bombScan();
      monIoU = bs.iou;
      present = bs.iou > 0.18;
    }
    if (!present) goneCount++; else goneCount = 0;
    if (goneCount >= GONE_K) onDefused();
  }

  function onDefused() {
    stopRender();
    planted = false; goneCount = 0; monIoU = null; dbg = null;
    cooldownUntil = performance.now() + COOLDOWN_MS;   // skip the replay
    setHud(cfg.game === "cs2" ? "Bomb defused / cleared" : "Spike defused / cleared", null, "#22d3ee");
    setTimeout(() => { reset(true); if (cfg.running) setHud("Watching for plant…", null); }, 2500);
  }

  function reset(toWatching) {
    planted = false; plantRun = 0; dgRun = 0; goneCount = 0; monIoU = null;
    if (!toWatching) { armed = false; baseline = 0; }
    stopRender();
  }

  // ---- countdown render -----------------------------------------------------
  function startRender() {
    stopRender();
    renderTimer = setInterval(renderCountdown, 80);
    renderCountdown();
  }
  function stopRender() { if (renderTimer) clearInterval(renderTimer); renderTimer = null; }

  function renderCountdown() {
    const rem = detonateAt - performance.now();
    if (rem <= 0) {
      setHud("DETONATED", 0, "#ef4444");
      cooldownUntil = performance.now() + COOLDOWN_MS;   // skip the replay
      setTimeout(() => { reset(true); }, 2500);
      stopRender();
      return;
    }
    const secs = rem / 1000;
    const g = GAMES[cfg.game];
    const color = secs > g.yellowAt ? "#22c55e" : secs > g.redAt ? "#eab308" : "#ef4444";
    const label = (cfg.game === "cs2" ? "BOMB PLANTED" : "SPIKE PLANTED")
      + (monIoU != null ? `  · ${monIoU.toFixed(2)}` : "");
    setHud(label, secs, color);
  }

  // ---- overlay HUD ----------------------------------------------------------
  // Build the overlay ONCE with stable elements + button handlers; per-tick
  // updates only touch text/styles. (Rebuilding innerHTML each tick was
  // destroying the buttons mid-click, so clicks didn't register.)
  let el = {};
  function ensureHud() {
    if (hud) return;
    hud = document.createElement("div");
    hud.id = "defuse-time-hud";
    hud.style.cssText = [
      "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
      "min-width:200px", "background:rgba(15,23,42,.92)", "color:#e5e7eb",
      "border:1px solid rgba(51,65,85,.9)", "border-radius:12px",
      "padding:12px 14px", "font:13px/1.4 'Segoe UI',system-ui,sans-serif",
      "box-shadow:0 12px 34px rgba(0,0,0,.45)", "cursor:move",
      "user-select:none",
    ].join(";");
    hud.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">
        <b>Defuse Time</b>
        <span style="display:flex;align-items:center;gap:8px;">
          <span id="dt-label" style="font-size:11px;color:#94a3b8;"></span>
          <button id="dt-close" title="Close (stop watching)" style="border:0;border-radius:6px;width:20px;height:20px;line-height:1;background:#334155;color:#e5e7eb;cursor:pointer;font-size:13px;">×</button>
        </span>
      </div>
      <div id="dt-status" style="color:#94a3b8;margin-bottom:2px;"></div>
      <div id="dt-big" style="font-size:28px;font-weight:700;"></div>
      <div style="margin-top:8px;height:6px;background:#1e293b;border-radius:999px;overflow:hidden;">
        <div id="dt-bar" style="height:100%;width:0%;background:#475569;transition:width 80ms linear;"></div>
      </div>
      <div id="dt-dbg" style="margin-top:6px;font:11px/1.5 monospace;color:#7dd3fc;"></div>
      <div style="margin-top:10px;display:flex;gap:6px;">
        <button id="dt-plant" style="flex:1;border:0;border-radius:7px;padding:6px;background:#ef4444;color:#111;font-weight:700;cursor:pointer;">Plant now</button>
        <button id="dt-cancel" style="flex:1;border:0;border-radius:7px;padding:6px;background:#334155;color:#e5e7eb;cursor:pointer;">Reset</button>
      </div>
      <button id="dt-pip" style="margin-top:6px;width:100%;border:0;border-radius:7px;padding:6px;background:#0ea5e9;color:#04293b;font-weight:600;cursor:pointer;">⧉ Pop out panel</button>
      <div style="margin-top:6px;font-size:11px;color:#64748b;">Hotkeys: Alt+P plant · Alt+C reset · Alt+X close</div>`;
    document.documentElement.appendChild(hud);
    el = {
      label: hud.querySelector("#dt-label"), status: hud.querySelector("#dt-status"),
      big: hud.querySelector("#dt-big"), bar: hud.querySelector("#dt-bar"),
      dbg: hud.querySelector("#dt-dbg"),
    };
    hud.querySelector("#dt-plant").onclick = () => triggerPlant("manual");
    hud.querySelector("#dt-cancel").onclick = () => { reset(true); setHud("Watching for plant…", null); };
    hud.querySelector("#dt-close").onclick = () => stop();
    hud.querySelector("#dt-pip").onclick = () => panel.open();

    // Drag to move (anywhere except the buttons). Position is persisted.
    hud.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.tagName === "BUTTON") return;
      const r = hud.getBoundingClientRect();
      drag.on = true; drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
      e.preventDefault();
    });
    // Restore saved position.
    try {
      chrome.storage.local.get("hudPos").then(({ hudPos }) => {
        if (hudPos && hud) placeHud(hudPos.left, hudPos.top);
      });
    } catch (e) { /* storage may be unavailable */ }
  }

  function placeHud(left, top) {
    const r = hud.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, left));
    const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, top));
    hud.style.left = x + "px"; hud.style.top = y + "px";
    hud.style.right = "auto"; hud.style.bottom = "auto";
  }

  function setHud(status, secs, color) {
    ensureHud();
    const fuse = GAMES[cfg.game].fuse;
    const pct = secs == null ? 0 : Math.max(0, Math.min(1, secs / fuse));
    const bigTxt = secs == null ? "—" : secs.toFixed(1) + "s";
    el.label.textContent = `${GAMES[cfg.game].label} · ${VERSION}`;
    el.status.textContent = status;
    el.big.textContent = bigTxt;
    el.big.style.color = color || "#e5e7eb";
    el.bar.style.width = (pct * 100).toFixed(1) + "%";
    el.bar.style.background = color || "#475569";
    // Mirror to the pop-out panel if open.
    panel.update(status, bigTxt, color, pct);
    if (secs == null && dbg) {
      const f = (x) => x == null ? "–" : x.toFixed(3);
      const body = dbg.mode === "valo"
        ? `iconIoU=${f(dbg.iou)} (need ≥${ICON_IOU})<br>${dbg.iou >= ICON_IOU ? "ICON✓" : "no-icon"}`
        : `${dbg.gone ? "GONE" : "digits"} (w=${f(dbg.white)})<br>scan iou=${f(dbg.scanIoU)} red=${f(dbg.scanRed)}<br>bomb=${dbg.side}`;
      el.dbg.innerHTML = `${body}<br>plantRun=${dbg.run}/${CONFIRM_K}`;
    } else {
      el.dbg.innerHTML = "";
    }
  }

  function removeHud() { if (hud) hud.remove(); hud = null; el = {}; }

  // ---- pop-out panel (Document Picture-in-Picture) --------------------------
  // A second-monitor window: the countdown + a LIVE pixel mirror of the
  // score/round bar (no OCR — copied pixels can't misread). Owns its own window
  // and element refs. setHud() pushes countdown updates here via update().
  class PopoutPanel {
    constructor() {
      this.win = null;
      this.els = {};
    }

    async open() {
      if (!("documentPictureInPicture" in window)) {
        setHud("Pop-out needs Chrome 116+ (not supported here)", null);
        return;
      }
      if (this.win) { try { this.win.focus(); } catch (e) {} return; }
      let w;
      try {
        w = await window.documentPictureInPicture.requestWindow({ width: 320, height: 220 });
      } catch (e) { return; }
      this.win = w;
      const d = w.document;
      d.body.style.cssText = "margin:0;background:#0f172a;color:#e5e7eb;font:13px/1.4 'Segoe UI',system-ui,sans-serif;";
      d.body.innerHTML = `
        <div style="padding:12px 14px;">
          <canvas id="p-score" style="width:100%;display:block;border-radius:6px;background:#1e293b;margin-bottom:8px;"></canvas>
          <div id="p-status" style="color:#94a3b8;margin-bottom:2px;">Watching for plant…</div>
          <div id="p-big" style="font-size:38px;font-weight:700;line-height:1.1;">—</div>
          <div style="margin-top:8px;height:7px;background:#1e293b;border-radius:999px;overflow:hidden;">
            <div id="p-bar" style="height:100%;width:0%;background:#475569;transition:width 80ms linear;"></div>
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
      this.els.big.style.color = color || "#e5e7eb";
      this.els.bar.style.width = (pct * 100).toFixed(1) + "%";
      this.els.bar.style.background = color || "#475569";
    }

    // Mirror the score-bar strip (team tags + scores + round) into the panel.
    paintScore() {
      if (!this.win || !this.els.score) return;
      const v = frames.getVideo();
      if (!v || !v.videoWidth) return;
      const vw = v.videoWidth, vh = v.videoHeight;
      const sw = Math.max(1, Math.round(SCORE_ROI.w * vw));
      const sh = Math.max(1, Math.round(SCORE_ROI.h * vh));
      if (this.els.score.width !== sw) { this.els.score.width = sw; this.els.score.height = sh; }
      try {
        this.els.sctx.drawImage(v, SCORE_ROI.x * vw, SCORE_ROI.y * vh,
          SCORE_ROI.w * vw, SCORE_ROI.h * vh, 0, 0, sw, sh);
      } catch (e) { /* tainted/unavailable */ }
    }
  }

  const panel = new PopoutPanel();

  // ---- control --------------------------------------------------------------
  function start() {
    if (detectTimer) clearInterval(detectTimer);
    cfg.running = true;
    reset(false);
    setHud("Watching for plant…", null);
    detectTimer = setInterval(detectTick, TICK_MS);
  }
  function stop() {
    cfg.running = false;
    if (detectTimer) clearInterval(detectTimer); detectTimer = null;
    stopRender(); reset(false); hideBoxes(); panel.close(); removeHud();
  }

  window.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    if (e.code === "KeyP") { e.preventDefault(); if (!cfg.running) start(); triggerPlant("manual"); }
    if (e.code === "KeyC") { e.preventDefault(); reset(true); if (cfg.running) setHud("Watching for plant…", null); }
    if (e.code === "KeyX") { e.preventDefault(); stop(); }
  });

  window.addEventListener("mousemove", (e) => {
    if (!drag.on || !hud) return;
    placeHud(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  window.addEventListener("mouseup", () => {
    if (!drag.on || !hud) return;
    drag.on = false;
    const r = hud.getBoundingClientRect();
    try { chrome.storage.local.set({ hudPos: { left: r.left, top: r.top } }); } catch (e) {}
  });

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === "DT_SET_GAME") { cfg.game = msg.game; if (cfg.running) setHud("Watching for plant…", null); }
    else if (msg.type === "DT_START") { cfg.game = msg.game || cfg.game; start(); }
    else if (msg.type === "DT_STOP") { stop(); }
    else if (msg.type === "DT_PLANT") { if (!cfg.running) start(); triggerPlant("manual"); }
    else if (msg.type === "DT_STATE") { send({ running: cfg.running, game: cfg.game, tainted: frames.tainted }); return true; }
    send && send({ ok: true });
  });
})();
