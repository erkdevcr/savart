'use strict';
/**
 * Phase Vocoder — pitch shift only, tempo unchanged.
 * audio.playbackRate = _tempo (speed only).
 * Worklet receives { pf: _pitch/100 }.
 * pf=1.0 → passthrough, pf=2.0 → octave up (chipmunk), pf=0.5 → octave down.
 */
registerProcessor('pitch-processor', class extends AudioWorkletProcessor {
  constructor() {
    super();
    const N = this.N = 2048;
    const H = this.H = 512;   // 4× overlap — balance quality/CPU

    // Hann window
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++)
      this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

    // OLA norm = sum(win²) / H  ≈ 1.5 for Hann 4× overlap
    let s = 0;
    for (let i = 0; i < N; i++) s += this.win[i] * this.win[i];
    this.norm = s / H;

    this.pf = 1.0;

    // Input ring (absolute pointers)
    this.iBuf = new Float32Array(N * 4);
    this.iLen = N * 4;
    this.iW   = N;   // pre-fill N zeros so first frame is valid
    this.iR   = 0;

    // Phase state
    this.lPhi = new Float32Array(N);
    this.sPhi = new Float32Array(N);

    // Output OLA buffer (absolute pointers, starts N ahead for latency budget)
    this.oBuf = new Float32Array(N * 16);
    this.oLen = N * 16;
    this.oW   = N;
    this.oR   = 0;

    // Pre-allocated FFT scratch — NO allocation inside process()
    this.re  = new Float32Array(N);
    this.im  = new Float32Array(N);
    this.oRe = new Float32Array(N);
    this.oIm = new Float32Array(N);

    // Bit-reversal table for N=2048
    this.br = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0, v = i;
      for (let b = 0; b < 11; b++) { r = (r << 1) | (v & 1); v >>= 1; }
      this.br[i] = r;
    }

    this.port.onmessage = ({ data }) => {
      if (data?.pf != null) {
        this.pf = Math.max(0.25, Math.min(4.0, +data.pf));
        this.lPhi.fill(0);
        this.sPhi.fill(0);
      }
      if (data?.flush) {
        this.iBuf.fill(0); this.iW = this.N; this.iR = 0;
        this.oBuf.fill(0); this.oW = this.N; this.oR = 0;
        this.lPhi.fill(0); this.sPhi.fill(0);
      }
    };
  }

  _fft(re, im, inv) {
    const N = this.N, br = this.br;
    for (let i = 0; i < N; i++) {
      const j = br[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sg = inv ? 1 : -1;
    for (let len = 2; len <= N; len <<= 1) {
      const h = len >> 1, ang = sg * Math.PI / h;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < h; j++) {
          const ur = re[i+j],         ui = im[i+j];
          const vr = re[i+j+h]*cr - im[i+j+h]*ci;
          const vi = re[i+j+h]*ci + im[i+j+h]*cr;
          re[i+j]   = ur+vr; im[i+j]   = ui+vi;
          re[i+j+h] = ur-vr; im[i+j+h] = ui-vi;
          const t = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = t;
        }
      }
    }
    if (inv) { const k = 1/N; for (let i = 0; i < N; i++) { re[i]*=k; im[i]*=k; } }
  }

  _frame() {
    const { N, H, win, re, im, oRe, oIm, iBuf, iLen, oBuf, oLen, norm } = this;
    const pf = this.pf;
    const Nh = N >> 1;
    const P2 = 2 * Math.PI;
    const ex = P2 * H / N;

    // Windowed analysis frame
    for (let i = 0; i < N; i++) {
      re[i] = iBuf[(this.iR + i) % iLen] * win[i];
      im[i] = 0;
    }
    this._fft(re, im, false);

    // Clear output spectrum
    for (let i = 0; i < N; i++) { oRe[i] = 0; oIm[i] = 0; }

    // Phase vocoder + spectral shift
    for (let k = 0; k <= Nh; k++) {
      const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
      if (mag < 1e-12) { this.lPhi[k] = Math.atan2(im[k], re[k]); continue; }

      const phi = Math.atan2(im[k], re[k]);
      let dp = phi - this.lPhi[k] - k * ex;
      dp -= P2 * Math.round(dp / P2);
      this.sPhi[k] += H * (k * P2 / N + dp / H);
      this.lPhi[k] = phi;

      const kp = Math.round(k * pf);
      if (kp < 0 || kp > Nh) continue;

      const c = Math.cos(this.sPhi[k]);
      const s = Math.sin(this.sPhi[k]);
      oRe[kp] += mag * c;
      oIm[kp] += mag * s;
      if (kp > 0 && kp < Nh) {
        oRe[N - kp] += mag * c;
        oIm[N - kp] -= mag * s;
      }
    }

    this._fft(oRe, oIm, true);

    // OLA synthesis
    for (let i = 0; i < N; i++)
      oBuf[(this.oW + i) % oLen] += oRe[i] * win[i] / norm;

    this.oW += H;
    this.iR += H;
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    const bs = inp.length;

    // Write input
    for (let i = 0; i < bs; i++) {
      this.iBuf[this.iW % this.iLen] = inp[i];
      this.iW++;
    }

    // Process frames
    while (this.iW - this.iR >= this.N) this._frame();

    // Read output
    for (let i = 0; i < bs; i++) {
      const p = this.oR % this.oLen;
      out[i] = this.oBuf[p];
      this.oBuf[p] = 0;
      this.oR++;
    }
    return true;
  }
});
