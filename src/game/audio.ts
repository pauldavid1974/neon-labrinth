/**
 * Procedural audio — no samples, everything synthesized with WebAudio.
 * Voices are fire-and-forget oscillator/noise nodes; a single preallocated
 * 1s white-noise buffer is reused for all noise-based effects.
 */
import type { ISfx, SfxName } from "./types";

export class SynthSfx implements ISfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private droneNodes: AudioNode[] = [];
  private droneBus: GainNode | null = null;
  muted = false;

  /** Must be called from a user gesture. Safe to call repeatedly. */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => undefined);
      return;
    }
    try {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      this.ctx = null;
      console.error("[neon] WebAudio unavailable:", e);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  private tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, q = 1, delay = 0): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(freq, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.4), t0 + dur);
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  private click(vol: number, f0 = 2100, dur = 0.016): void {
    this.tone("square", f0, Math.max(80, f0 * 0.22), dur, vol);
  }

  /** Briefly duck the sector drone so hit transients read through. */
  private duckDrone(amt = 0.42, recover = 0.16): void {
    if (!this.ctx || !this.droneBus) return;
    const t = this.ctx.currentTime;
    const g = this.droneBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.12, amt), t);
    g.exponentialRampToValueAtTime(1, t + recover);
  }

  play(name: SfxName): void {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case "shoot":
        this.click(0.08, 2400, 0.014);
        this.tone("square", 980, 220, 0.09, 0.11);
        this.noise(0.045, 0.07, 3800, 2.4);
        break;
      case "enemyshoot":
        this.click(0.05, 1600, 0.012);
        this.tone("sawtooth", 620, 180, 0.12, 0.08);
        break;
      case "hit":
        this.click(0.1, 1600, 0.012);
        this.tone("sawtooth", 240, 55, 0.09, 0.14);
        this.noise(0.05, 0.1, 2200, 1.8);
        this.duckDrone(0.4, 0.12);
        break;
      case "hurt":
        this.click(0.09, 900, 0.02);
        this.tone("sawtooth", 150, 46, 0.22, 0.18);
        this.noise(0.14, 0.12, 600, 0.9);
        this.duckDrone(0.28, 0.2);
        break;
      case "kill":
        this.click(0.11, 1900, 0.018);
        this.tone("square", 720, 36, 0.28, 0.15);
        this.tone("sine", 1480, 70, 0.22, 0.1, 0.015);
        this.noise(0.2, 0.12, 1000, 0.8);
        this.duckDrone(0.32, 0.22);
        break;
      case "pickup":
        this.tone("sine", 660, 660, 0.07, 0.08);
        this.tone("sine", 990, 990, 0.09, 0.08, 0.07);
        break;
      case "weapon":
        this.tone("triangle", 440, 880, 0.1, 0.09);
        this.tone("triangle", 660, 1320, 0.12, 0.09, 0.09);
        this.tone("sine", 1760, 1760, 0.16, 0.06, 0.18);
        break;
      case "dash":
        this.click(0.05, 900, 0.02);
        this.noise(0.14, 0.13, 2800, 0.7);
        this.tone("sine", 220, 1100, 0.12, 0.07);
        break;
      case "stairs":
        this.tone("triangle", 330, 330, 0.14, 0.08);
        this.tone("triangle", 415, 415, 0.14, 0.08, 0.11);
        this.tone("triangle", 523, 523, 0.2, 0.08, 0.22);
        this.tone("sine", 1046, 1046, 0.3, 0.05, 0.33);
        break;
      case "crate":
        this.click(0.08, 400, 0.02);
        this.noise(0.12, 0.16, 800, 0.6);
        this.tone("square", 140, 48, 0.1, 0.13);
        break;
      case "charge":
        this.tone("sawtooth", 80, 190, 0.4, 0.1);
        break;
      case "ui":
        this.tone("square", 840, 840, 0.045, 0.05);
        break;
      case "denied":
        this.tone("square", 170, 120, 0.12, 0.07);
        break;
      case "explode":
        this.click(0.14, 1200, 0.02);
        this.noise(0.32, 0.24, 500, 0.8);
        this.tone("sawtooth", 100, 22, 0.32, 0.2);
        this.tone("square", 68, 18, 0.4, 0.16, 0.015);
        this.duckDrone(0.25, 0.28);
        break;
      case "shock":
        this.tone("sawtooth", 1400, 220, 0.16, 0.12);
        this.noise(0.12, 0.1, 4800, 3.5);
        this.tone("square", 880, 440, 0.1, 0.08, 0.03);
        break;
      case "scatter":
        this.tone("square", 820, 280, 0.09, 0.08);
        this.tone("sawtooth", 740, 210, 0.1, 0.07, 0.02);
        this.noise(0.08, 0.06, 2800, 1.6);
        break;
      case "emp":
        this.click(0.1, 2800, 0.02);
        this.tone("sine", 1400, 55, 0.4, 0.16);
        this.tone("triangle", 700, 32, 0.32, 0.13, 0.03);
        this.noise(0.22, 0.12, 1600, 1.4);
        this.duckDrone(0.35, 0.25);
        break;
      case "shrine":
        this.tone("sine", 523, 1046, 0.35, 0.1);
        this.tone("triangle", 659, 1318, 0.4, 0.08, 0.08);
        this.tone("sine", 784, 1568, 0.5, 0.06, 0.16);
        break;
      case "chrono":
        this.tone("sine", 1480, 240, 0.24, 0.14);
        this.tone("square", 880, 110, 0.18, 0.09, 0.02);
        this.noise(0.14, 0.09, 4400, 2.8);
        break;
      case "crit":
        this.tone("sawtooth", 380, 920, 0.16, 0.13);
        this.tone("sine", 760, 1520, 0.18, 0.11, 0.02);
        this.noise(0.1, 0.08, 3600, 2.2);
        break;
    }
  }

  updateDroneSector(floor: number): void {
    if (!this.ctx || !this.master || this.droneNodes.length === 0) return;
    try {
      const baseFreq = floor <= 3 ? 55 : floor <= 6 ? 48.99 : floor <= 9 ? 65.41 : 43.65;
      let oscIndex = 0;
      for (const node of this.droneNodes) {
        if (node instanceof OscillatorNode && node.type === "sawtooth") {
          const detune = oscIndex === 0 ? 0 : oscIndex === 1 ? 8 : -6;
          node.frequency.setTargetAtTime(baseFreq * (oscIndex === 2 ? 2 : 1), this.ctx.currentTime, 0.8);
          node.detune.setTargetAtTime(detune, this.ctx.currentTime, 0.5);
          oscIndex++;
        }
      }
    } catch {
      /* ignore */
    }
  }

  startDrone(): void {
    if (!this.ctx || !this.master || this.droneNodes.length > 0) return;
    try {
      this.droneBus = this.ctx.createGain();
      this.droneBus.gain.value = 1;
      this.droneBus.connect(this.master);
      const mk = (freq: number, detune: number): void => {
        if (!this.ctx || !this.droneBus) return;
        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 240;
        lp.Q.value = 4;
        const g = this.ctx.createGain();
        g.gain.value = 0.028;
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.07 + detune * 0.001;
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 120;
        lfo.connect(lfoGain).connect(lp.frequency);
        osc.connect(lp).connect(g).connect(this.droneBus);
        osc.start();
        lfo.start();
        this.droneNodes.push(osc, lfo, g);
      };
      mk(55, 0);
      mk(55.4, 8);
      mk(110.3, -6);
    } catch {
      /* drone is decorative — never crash the game for it */
    }
  }

  stopDrone(): void {
    for (const n of this.droneNodes) {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* fine */
      }
    }
    this.droneNodes.length = 0;
    if (this.droneBus) {
      try {
        this.droneBus.disconnect();
      } catch {
        /* fine */
      }
      this.droneBus = null;
    }
  }

  destroy(): void {
    this.stopDrone();
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}
