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

  play(name: SfxName): void {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case "shoot":
        this.tone("square", 920, 240, 0.11, 0.09);
        this.noise(0.06, 0.05, 3400, 2);
        break;
      case "enemyshoot":
        this.tone("sawtooth", 620, 180, 0.14, 0.07);
        break;
      case "hit":
        this.tone("sawtooth", 220, 70, 0.12, 0.12);
        this.noise(0.08, 0.08, 1800, 1.4);
        break;
      case "hurt":
        this.tone("sawtooth", 150, 46, 0.3, 0.16);
        this.noise(0.2, 0.1, 500, 0.8);
        break;
      case "kill":
        this.tone("square", 700, 40, 0.32, 0.12);
        this.tone("sine", 1400, 90, 0.26, 0.09, 0.02);
        this.noise(0.25, 0.1, 900, 0.7);
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
        this.noise(0.18, 0.1, 2400, 0.6);
        this.tone("sine", 300, 900, 0.14, 0.05);
        break;
      case "stairs":
        this.tone("triangle", 330, 330, 0.14, 0.08);
        this.tone("triangle", 415, 415, 0.14, 0.08, 0.11);
        this.tone("triangle", 523, 523, 0.2, 0.08, 0.22);
        this.tone("sine", 1046, 1046, 0.3, 0.05, 0.33);
        break;
      case "crate":
        this.noise(0.16, 0.14, 700, 0.5);
        this.tone("square", 120, 60, 0.12, 0.1);
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
    }
  }

  startDrone(): void {
    if (!this.ctx || !this.master || this.droneNodes.length > 0) return;
    try {
      const mk = (freq: number, detune: number): void => {
        if (!this.ctx || !this.master) return;
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
        osc.connect(lp).connect(g).connect(this.master);
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
  }

  destroy(): void {
    this.stopDrone();
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}
