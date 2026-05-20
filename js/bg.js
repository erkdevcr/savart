/* ============================================================
   Savart — Animated dot-grid background canvas
   Each blob has its own speed multiplier + dual-frequency drift
   so motion stays organic and never fully repeats.
   ============================================================ */

(() => {
  const canvas = document.getElementById('bg-dots');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const SPACING = 17;
  const DOT_R   = 0.9;
  const SPEED   = 0.0625; // base cycles/s — 16 s per full cycle

  // sp  = individual speed multiplier (each blob drifts at its own rate)
  // ax2/ay2, px2/py2 = second wave for extra randomness
  const blobs = [
    { bx:0.08, by:0.12, r:0.18, ax:0.07, ay:0.05, px:0.00, py:1.00, sp:1.00, ax2:0.03, ay2:0.04, px2:0.50, py2:1.30 },
    { bx:0.35, by:0.05, r:0.14, ax:0.06, ay:0.07, px:1.20, py:0.30, sp:1.37, ax2:0.04, ay2:0.02, px2:2.10, py2:0.70 },
    { bx:0.65, by:0.18, r:0.20, ax:0.08, ay:0.06, px:2.10, py:0.80, sp:0.83, ax2:0.02, ay2:0.05, px2:0.90, py2:2.00 },
    { bx:0.90, by:0.08, r:0.16, ax:0.05, ay:0.08, px:0.70, py:1.50, sp:1.21, ax2:0.05, ay2:0.03, px2:1.60, py2:0.40 },
    { bx:0.15, by:0.50, r:0.17, ax:0.07, ay:0.06, px:1.80, py:0.20, sp:0.74, ax2:0.03, ay2:0.06, px2:2.80, py2:1.10 },
    { bx:0.50, by:0.45, r:0.22, ax:0.06, ay:0.07, px:0.40, py:2.00, sp:1.55, ax2:0.06, ay2:0.03, px2:0.30, py2:1.80 },
    { bx:0.80, by:0.55, r:0.15, ax:0.08, ay:0.05, px:2.50, py:0.60, sp:0.91, ax2:0.04, ay2:0.05, px2:1.20, py2:2.50 },
    { bx:0.05, by:0.85, r:0.19, ax:0.05, ay:0.07, px:1.00, py:1.20, sp:1.18, ax2:0.05, ay2:0.04, px2:0.70, py2:0.60 },
    { bx:0.40, by:0.90, r:0.16, ax:0.07, ay:0.06, px:0.20, py:0.90, sp:0.66, ax2:0.03, ay2:0.06, px2:2.20, py2:1.40 },
    { bx:0.72, by:0.82, r:0.20, ax:0.06, ay:0.08, px:1.60, py:0.40, sp:1.43, ax2:0.06, ay2:0.03, px2:0.50, py2:2.10 },
    { bx:0.95, by:0.75, r:0.14, ax:0.08, ay:0.05, px:3.00, py:1.80, sp:0.79, ax2:0.04, ay2:0.05, px2:1.80, py2:0.30 },
    { bx:0.25, by:0.70, r:0.13, ax:0.06, ay:0.07, px:0.90, py:2.20, sp:1.30, ax2:0.05, ay2:0.04, px2:0.10, py2:1.70 },
  ];

  let W, H, cols, rows, gridX, gridY, then = null, t = 0;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
    cols = Math.ceil(W / SPACING) + 1;
    rows = Math.ceil(H / SPACING) + 1;
    gridX = new Float32Array(cols);
    gridY = new Float32Array(rows);
    for (let c = 0; c < cols; c++) gridX[c] = c * SPACING + SPACING / 2;
    for (let r = 0; r < rows; r++) gridY[r] = r * SPACING + SPACING / 2;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (then === null) then = now;
    t += (now - then) / 1000;
    then = now;

    ctx.clearRect(0, 0, W, H);

    const maxDim = Math.max(W, H);
    const bPos = blobs.map(b => {
      const f  = t * SPEED * Math.PI * 2 * b.sp;
      const f2 = t * SPEED * Math.PI * 2 * b.sp * 1.618; // golden ratio offset for second wave
      return {
        x:  (b.bx + Math.sin(f  + b.px)  * b.ax
                  + Math.sin(f2 + b.px2) * b.ax2) * W,
        y:  (b.by + Math.cos(f  + b.py)  * b.ay
                  + Math.cos(f2 + b.py2) * b.ay2) * H,
        r2: (b.r * maxDim) ** 2,
      };
    });

    ctx.fillStyle = 'rgb(80,150,255)';

    for (let c = 0; c < cols; c++) {
      const x = gridX[c];
      for (let r = 0; r < rows; r++) {
        const y = gridY[r];
        let minRatio = Infinity;
        for (const b of bPos) {
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

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();
