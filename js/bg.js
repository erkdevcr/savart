/* ============================================================
   Savart — Animated dot-grid background canvas
   Draws on two canvases simultaneously:
     #bg-dots      — global fixed background (behind all page content)
     #bg-dots-exp  — inside #player-expanded (above its solid dark bg,
                     below its in-flow content via z-index: -1)
   Each blob has its own speed multiplier + dual-frequency drift
   so motion stays organic and never fully repeats.
   ============================================================ */

(() => {
  const canvasMain = document.getElementById('bg-dots');
  const canvasExp  = document.getElementById('bg-dots-exp');
  if (!canvasMain) return;

  const ctxMain = canvasMain.getContext('2d');
  const ctxExp  = canvasExp ? canvasExp.getContext('2d') : null;

  const SPACING = 17;
  const DOT_R   = 0.9;
  const SPEED   = 0.0625; // base cycles/s — 16 s per full cycle

  const blobs = [
    { bx:0.20, by:0.20, r:0.20, ax:0.25, ay:0.22, px:0.00, py:1.00, sp:1.00, ax2:0.10, ay2:0.08, px2:0.50, py2:1.30 },
    { bx:0.75, by:0.15, r:0.18, ax:0.22, ay:0.18, px:1.20, py:0.30, sp:1.37, ax2:0.08, ay2:0.10, px2:2.10, py2:0.70 },
    { bx:0.80, by:0.55, r:0.20, ax:0.22, ay:0.35, px:2.10, py:0.80, sp:0.83, ax2:0.08, ay2:0.08, px2:0.90, py2:2.00 },
    { bx:0.20, by:0.65, r:0.20, ax:0.22, ay:0.32, px:1.80, py:0.20, sp:0.74, ax2:0.08, ay2:0.10, px2:2.80, py2:1.10 },
    { bx:0.50, by:0.45, r:0.24, ax:0.42, ay:0.42, px:0.40, py:2.00, sp:1.55, ax2:0.08, ay2:0.08, px2:0.30, py2:1.80 },
    { bx:0.25, by:0.85, r:0.20, ax:0.28, ay:0.18, px:1.00, py:1.20, sp:1.18, ax2:0.08, ay2:0.08, px2:0.70, py2:0.60 },
    { bx:0.75, by:0.80, r:0.20, ax:0.28, ay:0.22, px:1.60, py:0.40, sp:1.43, ax2:0.08, ay2:0.08, px2:0.50, py2:2.10 },
  ];

  // Global canvas state
  let W, H, cols, rows, gridX, gridY;
  // Expanded-player canvas state
  let Wexp = 0, Hexp = 0, colsExp, rowsExp, gridXexp, gridYexp;
  let then = null, t = 0;

  /* ── Resize helpers ──────────────────────────────────────── */

  function resizeMain() {
    W = canvasMain.width  = window.innerWidth;
    H = canvasMain.height = window.innerHeight;
    cols = Math.ceil(W / SPACING) + 1;
    rows = Math.ceil(H / SPACING) + 1;
    gridX = new Float32Array(cols);
    gridY = new Float32Array(rows);
    for (let c = 0; c < cols; c++) gridX[c] = c * SPACING + SPACING / 2;
    for (let r = 0; r < rows; r++) gridY[r] = r * SPACING + SPACING / 2;
  }

  function resizeExp(w, h) {
    if (!canvasExp) return;
    Wexp = canvasExp.width  = w;
    Hexp = canvasExp.height = h;
    colsExp = Math.ceil(Wexp / SPACING) + 1;
    rowsExp = Math.ceil(Hexp / SPACING) + 1;
    gridXexp = new Float32Array(colsExp);
    gridYexp = new Float32Array(rowsExp);
    for (let c = 0; c < colsExp; c++) gridXexp[c] = c * SPACING + SPACING / 2;
    for (let r = 0; r < rowsExp; r++) gridYexp[r] = r * SPACING + SPACING / 2;
  }

  /* ResizeObserver watches the player element — fires whenever it becomes
     visible or changes size, even if window.resize hasn't fired.
     This is the key fix for mobile: the player is display:none at boot,
     so offsetWidth/Height are 0 until the user opens it. */
  if (canvasExp && window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { inlineSize: w, blockSize: h } = entry.contentBoxSize?.[0] ||
          { inlineSize: entry.contentRect.width, blockSize: entry.contentRect.height };
        if (w > 0 && h > 0) resizeExp(Math.round(w), Math.round(h));
      }
    });
    ro.observe(canvasExp.parentElement); // observe #player-expanded
  }

  /* ── Draw grid on any canvas ─────────────────────────────── */

  function drawGrid(ctx, gW, gH, gCols, gRows, gX, gY, bPos) {
    ctx.clearRect(0, 0, gW, gH);
    const maxDim = Math.max(gW, gH);
    const localBPos = bPos.map((p, i) => ({
      x:  p.nx * gW,
      y:  p.ny * gH,
      r2: (blobs[i].r * maxDim) ** 2,
    }));

    ctx.fillStyle = 'rgb(80,150,255)';
    for (let c = 0; c < gCols; c++) {
      const x = gX[c];
      for (let r = 0; r < gRows; r++) {
        const y = gY[r];
        let minRatio = Infinity;
        for (const b of localBPos) {
          const dx = x - b.x, dy = y - b.y;
          const ratio = (dx * dx + dy * dy) / b.r2;
          if (ratio < minRatio) minRatio = ratio;
        }
        let alpha;
        if      (minRatio < 0.25) alpha = 0;
        else if (minRatio < 1.00) alpha = (minRatio - 0.25) / 0.75;
        else                      alpha = 1;
        if (alpha <= 0.01) continue;
        ctx.globalAlpha = alpha * 0.35;
        ctx.beginPath();
        ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ── Animation loop ──────────────────────────────────────── */

  function frame(now) {
    requestAnimationFrame(frame);
    if (then === null) then = now;
    t += (now - then) / 1000;
    then = now;

    // Compute normalised blob positions once — shared by both canvases
    const bPos = blobs.map(b => {
      const f  = t * SPEED * Math.PI * 2 * b.sp;
      const f2 = t * SPEED * Math.PI * 2 * b.sp * 1.618;
      return {
        nx: b.bx + Math.sin(f  + b.px)  * b.ax + Math.sin(f2 + b.px2) * b.ax2,
        ny: b.by + Math.cos(f  + b.py)  * b.ay + Math.cos(f2 + b.py2) * b.ay2,
      };
    });

    drawGrid(ctxMain, W, H, cols, rows, gridX, gridY, bPos);

    if (ctxExp && Wexp > 0 && Hexp > 0) {
      drawGrid(ctxExp, Wexp, Hexp, colsExp, rowsExp, gridXexp, gridYexp, bPos);
    }
  }

  window.addEventListener('resize', resizeMain);
  resizeMain();
  requestAnimationFrame(frame);
})();
