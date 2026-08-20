// hud.js — คะแนน / HP เมือง / combo / crosshair / overlay
//
// ทุกอย่างเป็น DOM ไม่ใช่ canvas — เพราะ CSS ทำ transition/animation ให้ฟรี
// และปรับขนาดตัวอักษรทั้งเกมได้จากตัวแปรเดียว (--ui-scale = 1.5) ตาม spec §8

import { CFG } from './config.js';

export class Hud {
  constructor() {
    this.el = {
      score: document.getElementById('score'),
      combo: document.getElementById('combo'),
      hpFill: document.getElementById('hpfill'),
      crosshair: document.getElementById('crosshair'),
      start: document.getElementById('start'),
      gameover: document.getElementById('gameover'),
      finalScore: document.getElementById('finalscore'),
      finalStats: document.getElementById('finalstats'),
    };
    this._score = -1;
    this._combo = -1;
    this._hp = -1;
    this._lock = null;
    this._popTimer = null;
  }

  setScore(v) {
    if (v === this._score) return;
    this._score = v;
    this.el.score.textContent = v.toLocaleString('en-US');

    // เด้งตัวเลข — เล็กน้อยแต่ทำให้รู้ว่า "ได้แต้มแล้ว" โดยไม่ต้องอ่าน
    this.el.score.classList.remove('pop');
    void this.el.score.offsetWidth;          // force reflow ให้ animation รีสตาร์ท
    this.el.score.classList.add('pop');
    clearTimeout(this._popTimer);
    this._popTimer = setTimeout(() => this.el.score.classList.remove('pop'), CFG.juice.scorePopMs);
  }

  setCombo(v) {
    if (v === this._combo) return;
    this._combo = v;
    this.el.combo.textContent = `COMBO ×${v}`;
    this.el.combo.classList.toggle('on', v >= 2);
  }

  setHp(cur, max) {
    const pct = Math.max(0, cur / max);
    if (pct === this._hp) return;
    this._hp = pct;
    this.el.hpFill.style.width = (pct * 100).toFixed(1) + '%';
    this.el.hpFill.style.background = pct > 0.5 ? '#59c0ff' : pct > 0.25 ? '#ffb648' : '#ff4d6d';
    this.el.hpFill.style.boxShadow = `0 0 14px ${pct > 0.5 ? '#59c0ff' : pct > 0.25 ? '#ffb648' : '#ff4d6d'}`;
  }

  /** crosshair แดง+โตขึ้น = aim assist จับเป้าอยู่ กดยิงตอนนี้โดนแน่ */
  setLock(on) {
    if (on === this._lock) return;
    this._lock = on;
    this.el.crosshair.classList.toggle('locked', !!on);
  }

  hideStart() { this.el.start.classList.add('hidden'); }

  showGameOver(score, kills, accuracy) {
    this.el.finalScore.textContent = score.toLocaleString('en-US');
    this.el.finalStats.textContent = `ยิงโดน ${kills} ดวง · แม่นยำ ${Math.round(accuracy * 100)}%`;
    this.el.gameover.classList.remove('hidden');
  }

  hideGameOver() { this.el.gameover.classList.add('hidden'); }
}
