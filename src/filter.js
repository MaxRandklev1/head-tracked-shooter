// One Euro filter (Casiez et al.) per axis, plus a smoothed velocity used to
// extrapolate the head position forward and hide camera-to-display latency.

const alpha = (cutoffHz, dt) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor() {
    this.x = null;
    this.dx = 0;
  }

  step(x, dt, minCutoff, beta, dCutoff) {
    if (this.x === null) {
      this.x = x;
      return x;
    }
    const rawDx = (x - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

export class HeadFilter {
  constructor(params) {
    this.params = params;
    this.reset();
  }

  reset() {
    this.axes = [new OneEuro(), new OneEuro(), new OneEuro()];
    this.pos = null;
    this.vel = [0, 0, 0];
    this.t = 0;
  }

  // pos in meters, t in ms (capture time on the performance.now() timeline).
  push(pos, t) {
    const p = this.params;
    const dt = this.pos ? Math.min(Math.max((t - this.t) / 1000, 1e-3), 0.2) : 1 / 30;
    const prev = this.pos;
    // Depth comes from the eye spacing in pixels, so it is far noisier than x/y.
    const next = [
      this.axes[0].step(pos[0], dt, p.minCutoff, p.beta, 1.5),
      this.axes[1].step(pos[1], dt, p.minCutoff, p.beta, 1.5),
      this.axes[2].step(pos[2], dt, p.minCutoff * 0.4, p.beta * 0.3, 1.0),
    ];
    if (prev) {
      const a = alpha(p.velCutoff, dt);
      for (let i = 0; i < 3; i++) {
        this.vel[i] += a * ((next[i] - prev[i]) / dt - this.vel[i]);
      }
    }
    this.pos = next;
    this.t = t;
  }

  // Extrapolated position at `now` + the configured latency.
  predict(now, out) {
    if (!this.pos) return false;
    const p = this.params;
    const ahead = Math.min(Math.max(now - this.t + p.latencyMs, 0), 150) / 1000;
    // Fade prediction out at low speed so it does not amplify jitter at rest.
    const speed = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
    // A stale sample means the face was lost: hold position, do not drift.
    const fresh = now - this.t < 250 ? 1 : 0;
    const k = Math.min(Math.max((speed - 0.02) / 0.1, 0), 1) * p.predict * fresh;
    out[0] = this.pos[0] + this.vel[0] * ahead * k;
    out[1] = this.pos[1] + this.vel[1] * ahead * k;
    out[2] = this.pos[2] + this.vel[2] * ahead * k * 0.5;
    return true;
  }
}
