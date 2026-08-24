// audio.js — ระบบสังเคราะห์เสียง WebAudio API 3D Space & Ground Defense SFX
//
// 1. เสียงป้อมปืนภาคพื้น: shoot(), hit(combo), burnout(), whistle()
// 2. เสียงยานอวกาศ: startEngine(), stopEngine(), updateEngine(speed, turn), laserBlast()
// 3. เสียงเหตุการณ์: radioBeep(), navRing(), shipExplosion(), victoryFanfare(), gameOver()

import { CFG, clamp } from './config.js';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.ready = false;

    // เครื่องยนต์ยานอวกาศ (Engine Audio Loop)
    this.engineRunning = false;
    this.engineOsc1 = null;
    this.engineOsc2 = null;
    this.engineNoise = null;
    this.engineGain = null;
    this.engineFilter = null;
  }

  /** ต้องเรียกจาก user gesture — browser autoplay policy บล็อก AudioContext ถ้าไม่มี */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = CFG.audio.master;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this._makeNoise(2.0);
      this.ready = true;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  _makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ── building blocks ─────────────────────────────────────────
  _noise({ dur = 0.1, gain = 0.4, type = 'bandpass', f0 = 1200, f1 = f0, q = 1, pan = 0, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g);
    this._out(g, pan, t);
    src.start(t); src.stop(t + dur + 0.02);
  }

  _tone({ dur = 0.15, gain = 0.3, type = 'sine', f0 = 440, f1 = f0, pan = 0, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this._out(g, pan, t);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _out(node, pan, t) {
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.setValueAtTime(clamp(pan, -1, 1), t);
      node.connect(p).connect(this.master);
    } else {
      node.connect(this.master);
    }
  }

  // ══ 1. เสียงป้อมปืนเลเซอร์ภาคพื้น ═════════════════════════════
  shoot() {
    if (!this.ready) return;
    this._noise({ dur: 0.07, gain: 0.35, type: 'bandpass', f0: 2400, f1: 600, q: 0.7 });
    this._tone({ dur: 0.10, gain: 0.28, type: 'square', f0: 260, f1: 70 });
    this._tone({ dur: 0.05, gain: 0.14, type: 'sawtooth', f0: 1400, f1: 400 });
  }

  laserBlast() {
    if (!this.ready) return;
    this._tone({ dur: 0.12, gain: 0.32, type: 'sawtooth', f0: 880, f1: 180 });
    this._noise({ dur: 0.08, gain: 0.22, type: 'bandpass', f0: 3200, f1: 800, q: 2 });
  }

  hit(combo = 0) {
    if (!this.ready) return;
    const A = CFG.audio;
    const semis = Math.min(A.comboSemitoneMax, combo * A.comboSemitone);
    const k = Math.pow(2, semis / 12);

    this._tone({ dur: 0.18, gain: 0.38, type: 'sine', f0: 140 * k, f1: 52 * k });
    this._noise({ dur: 0.22, gain: 0.45, type: 'lowpass', f0: 950 * k, f1: 120 * k });
    this._noise({ dur: 0.10, gain: 0.24, type: 'highpass', f0: 1800 * k, f1: 400 * k });
    if (combo >= 2) {
      this._tone({ dur: 0.14, gain: 0.18, type: 'triangle', f0: 520 * k, f1: 260 * k, delay: 0.03 });
    }
  }

  burnout() {
    if (!this.ready) return;
    this._noise({ dur: 0.34, gain: 0.13, type: 'lowpass', f0: 1400, f1: 180, q: 0.7 });
    this._tone({ dur: 0.30, gain: 0.10, type: 'sine', f0: 380, f1: 120 });
  }

  whistle(yaw = 0, dur = 1.2) {
    if (!this.ready) return;
    const pan = clamp(-Math.sin(yaw), -1, 1) * -1;
    this._tone({ dur, gain: CFG.audio.whistleVolume, type: 'sine', f0: 2100, f1: 620, pan });
    this._noise({ dur, gain: CFG.audio.whistleVolume * 0.45, type: 'bandpass', f0: 2600, f1: 800, q: 8, pan });
  }

  // ══ 2. เครื่องยนต์ยานอวกาศ (Engine Loop) ═════════════════════
  startEngine() {
    if (!this.ready || this.engineRunning) return;
    try {
      const c = this.ctx;
      this.engineRunning = true;

      this.engineGain = c.createGain();
      this.engineGain.gain.setValueAtTime(0.001, c.currentTime);
      this.engineGain.gain.exponentialRampToValueAtTime(0.22, c.currentTime + 0.5);

      this.engineFilter = c.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.setValueAtTime(280, c.currentTime);

      this.engineOsc1 = c.createOscillator();
      this.engineOsc1.type = 'sawtooth';
      this.engineOsc1.frequency.setValueAtTime(65, c.currentTime);

      this.engineOsc2 = c.createOscillator();
      this.engineOsc2.type = 'triangle';
      this.engineOsc2.frequency.setValueAtTime(130, c.currentTime);

      this.engineNoise = c.createBufferSource();
      this.engineNoise.buffer = this.noiseBuf;
      this.engineNoise.loop = true;

      const noiseGain = c.createGain();
      noiseGain.gain.value = 0.15;
      this.engineNoise.connect(noiseGain).connect(this.engineFilter);

      this.engineOsc1.connect(this.engineFilter);
      this.engineOsc2.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain).connect(this.master);

      this.engineOsc1.start();
      this.engineOsc2.start();
      this.engineNoise.start();
    } catch (e) {
      console.warn('[audio] engine start error:', e);
    }
  }

  updateEngine(turnIntensity = 0) {
    if (!this.engineRunning || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 65 + Math.abs(turnIntensity) * 25;
    const filterF = 280 + Math.abs(turnIntensity) * 120;
    this.engineOsc1.frequency.setTargetAtTime(f, t, 0.08);
    this.engineOsc2.frequency.setTargetAtTime(f * 2, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(filterF, t, 0.08);
  }

  stopEngine() {
    if (!this.engineRunning || !this.ctx) return;
    try {
      this.engineGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.2);
      setTimeout(() => {
        if (this.engineOsc1) { this.engineOsc1.stop(); this.engineOsc1.disconnect(); }
        if (this.engineOsc2) { this.engineOsc2.stop(); this.engineOsc2.disconnect(); }
        if (this.engineNoise) { this.engineNoise.stop(); this.engineNoise.disconnect(); }
        this.engineRunning = false;
      }, 250);
    } catch (e) {}
  }

  // ══ 3. เสียงวิทยุ & สัญญาณนำร่อง & ฉากจบ ══════════════════════
  radioBeep() {
    if (!this.ready) return;
    this._tone({ dur: 0.08, gain: 0.25, type: 'sine', f0: 880, f1: 880 });
    this._tone({ dur: 0.12, gain: 0.25, type: 'sine', f0: 1760, f1: 1760, delay: 0.08 });
  }

  navRing() {
    if (!this.ready) return;
    this._tone({ dur: 0.14, gain: 0.32, type: 'sine', f0: 587.33, f1: 880.00 }); // D5 -> A5
    this._tone({ dur: 0.24, gain: 0.28, type: 'sine', f0: 1174.66, f1: 1760.00, delay: 0.08 }); // D6 -> A6
  }

  shipExplosion() {
    if (!this.ready) return;
    this.stopEngine();
    this._noise({ dur: 2.2, gain: 0.85, type: 'lowpass', f0: 420, f1: 30 });
    this._tone({ dur: 1.8, gain: 0.65, type: 'sawtooth', f0: 160, f1: 35 });
    this._noise({ dur: 1.2, gain: 0.50, type: 'bandpass', f0: 1600, f1: 100, q: 3, delay: 0.05 });
  }

  victoryFanfare() {
    if (!this.ready) return;
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98]; // C5, E5, G5, C6, E6, G6
    notes.forEach((freq, i) => {
      this._tone({ dur: 0.35, gain: 0.25, type: 'triangle', f0: freq, f1: freq, delay: i * 0.12 });
      this._tone({ dur: 0.40, gain: 0.18, type: 'sine', f0: freq, f1: freq * 1.002, delay: i * 0.12 });
    });
  }

  gameOver() {
    if (!this.ready) return;
    this._tone({ dur: 1.5, gain: 0.5, type: 'sine', f0: 220, f1: 42 });
    this._noise({ dur: 1.2, gain: 0.3, type: 'lowpass', f0: 600, f1: 60 });
    this._tone({ dur: 1.0, gain: 0.2, type: 'triangle', f0: 160, f1: 55, delay: 0.15 });
  }
}
