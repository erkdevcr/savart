/* ============================================================
   Savart — Dot-grid background canvas
   Draws a white dot grid over the base background, with
   "blobs" that fade the dots near their centres, creating
   organic dark zones across the surface.
   Redraws on window resize (debounced 150 ms).
   ============================================================ */

(() => {
  const canvas = document.getElementById('bg-dots');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  /* Blob positions (relative to viewport) and radii */
  const BLOBS = [
    { x: 0.08, y: 0.12, r: 0.18 },
    { x: 0.35, y: 0.05, r: 0.14 },
    { x: 0.65, y: 0.18, r: 0.20 },
    { x: 0.90, y: 0.08, r: 0.16 },
    { x: 0.15, y: 0.50, r: 0.17 },
    { x: 0.50, y: 0.45, r: 0.22 },
    { x: 0.80, y: 0.55, r: 0.15 },
    { x: 0.05, y: 0.85, r: 0.19 },
    { x: 0.40, y: 0.90, r: 0.16 },
    { x: 0.72, y: 0.82, r: 0.20 },
    { x: 0.95, y: 0.75, r: 0.14 },
    { x: 0.25, y: 0.70, r: 0.13 },
  ];

  const SPACING = 17; // px between dot centres
  const DOT_R   = 0.9;  // dot radius in px (−10 %)

  function draw() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;

    const maxDim = Math.max(W, H);

    for (let x = SPACING / 2; x < W; x += SPACING) {
      for (let y = SPACING / 2; y < H; y += SPACING) {
        /* Find the closest blob (normalized distance) */
        let minDist = Infinity;
        for (const b of BLOBS) {
          const bx = b.x * W, by = b.y * H, br = b.r * maxDim;
          const dx = x - bx, dy = y - by;
          const d = Math.sqrt(dx * dx + dy * dy) / br;
          if (d < minDist) minDist = d;
        }

        /* Alpha: fade to 0 near blob centres */
        let alpha;
        if      (minDist < 0.5) { alpha = 0; }
        else if (minDist < 1.0) { alpha = (minDist - 0.5) / 0.5; }
        else                    { alpha = 1; }

        if (alpha <= 0) continue;

        ctx.beginPath();
        ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${(0.17 * alpha).toFixed(3)})`;
        ctx.fill();
      }
    }
  }

  /* Debounced resize */
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(draw, 150);
  });

  draw();
})();
