// audio.js — เสียง 3 ชั้น: ยิง / โดน / เมืองโดน
// "เสียงคือครึ่งหนึ่งของความรู้สึก" (spec §9)
//
// ── หมายเหตุ: ทำไมไม่ใช้ Howler ──────────────────────────────
// spec §9 เขียนไว้ว่าให้ใช้ Howler.js ผ่าน CDN แต่ในโปรเจกต์ไม่มีไฟล์เสียงสักไฟล์
// (3D asset/ มีแต่ .glb) — Howler ไม่มีประโยชน์ถ้าไม่มีไฟล์ให้เล่น และการไปโหลด
// เสียงจากเน็ตมาเองไม่ควรทำโดยไม่ถาม
//
// Phase A เลยสังเคราะห์เสียงสดด้วย WebAudio: ไม่ต้องมี asset เลย ได้เปรียบตรงที่
// เปลี่ยน pitch ตาม combo ได้ฟรีๆ (ถ้าใช้ไฟล์ ต้องอัด 8 เวอร์ชัน)
//
// ถ้าจะสลับไป Howler ทีหลัง: แก้ไฟล์นี้ไฟล์เดียว เมธอดข้างล่างคือ interface ทั้งหมด
//   sfx.shoot() / sfx.hit(combo) / sfx.cityHit() / sfx.whistle(yaw) / sfx.gameOver()

import { CFG, clamp } from './config.js';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.ready = false;
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
      this.noiseBuf = this._makeNoise(1.0);
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

  // ── ชั้นที่ 1: ยิง ──────────────────────────────────────────
  shoot() {
    if (!this.ready) return;
    this._noise({ dur: 0.07, gain: 0.35, type: 'bandpass', f0: 2400, f1: 600, q: 0.7 });
    this._tone({ dur: 0.10, gain: 0.28, type: 'square', f0: 260, f1: 70 });
    this._tone({ dur: 0.05, gain: 0.14, type: 'sawtooth', f0: 1400, f1: 400 });
  }

  // ── ชั้นที่ 2: โดน — pitch ขึ้นตาม combo ────────────────────
  hit(combo = 0) {
    if (!this.ready) return;
    const A = CFG.audio;
    const semis = Math.min(A.comboSemitoneMax, combo * A.comboSemitone);
    const k = Math.pow(2, semis / 12);

    this._noise({ dur: 0.16, gain: 0.34, type: 'highpass', f0: 900 * k, f1: 2600 * k, q: 0.5 });
    this._tone({ dur: 0.22, gain: 0.30, type: 'triangle', f0: 880 * k, f1: 240 * k });
    this._tone({ dur: 0.30, gain: 0.34, type: 'sine', f0: 150, f1: 48 });     // สับ sub ให้ตึ้บ
    // เสียงเหรียญเล็กๆ ตอน combo สูง — ให้รู้ว่ากำลังทำอะไรถูก
    if (combo >= 2) this._tone({ dur: 0.10, gain: 0.10, type: 'square', f0: 1200 * k, f1: 1800 * k, delay: 0.04 });
  }

  // ── ชั้นที่ 3: เมืองโดน — ต่ำ ดัง นาน คนละโลกกับเสียงยิง ────
  cityHit() {
    if (!this.ready) return;
    this._tone({ dur: 0.85, gain: 0.55, type: 'sine', f0: 110, f1: 34 });
    this._noise({ dur: 0.65, gain: 0.40, type: 'lowpass', f0: 900, f1: 90, q: 0.8 });
    this._tone({ dur: 0.35, gain: 0.18, type: 'sawtooth', f0: 70, f1: 28 });
  }

  /**
   * ปล่อยให้ไหม้หมดกลางอากาศ — เสียงเบาๆ ไม่ใช่เสียงระเบิด
   * ต้องไม่ดังเท่าเสียงยิงโดน ไม่งั้นเด็กจะสับสนว่าตัวเองทำสำเร็จหรือพลาด
   */
  burnout() {
    if (!this.ready) return;
    this._noise({ dur: 0.34, gain: 0.13, type: 'lowpass', f0: 1400, f1: 180, q: 0.7 });
    this._tone({ dur: 0.30, gain: 0.10, type: 'sine', f0: 380, f1: 120 });
  }

  /** เสียงหวีดตอน telegraph — pan ตาม yaw ให้เด็กหันไปถูกทาง */
  whistle(yaw = 0, dur = 1.2) {
    if (!this.ready) return;
    const pan = clamp(-Math.sin(yaw), -1, 1) * -1;   // yaw บวก = ซ้าย → pan ซ้าย
    this._tone({ dur, gain: CFG.audio.whistleVolume, type: 'sine', f0: 2100, f1: 620, pan });
    this._noise({ dur, gain: CFG.audio.whistleVolume * 0.45, type: 'bandpass', f0: 2600, f1: 800, q: 8, pan });
  }

  radioBeep() {
    if (!this.ready) return;
    this._tone({ dur: 0.08, gain: 0.25, type: 'sine', f0: 880, f1: 880 });
    this._tone({ dur: 0.12, gain: 0.25, type: 'sine', f0: 1760, f1: 1760, delay: 0.08 });
  }

  gameOver() {
    if (!this.ready) return;
    this._tone({ dur: 1.5, gain: 0.5, type: 'sine', f0: 220, f1: 42 });
    this._noise({ dur: 1.2, gain: 0.3, type: 'lowpass', f0: 600, f1: 60 });
    this._tone({ dur: 1.0, gain: 0.2, type: 'triangle', f0: 160, f1: 55, delay: 0.15 });
  }
}
