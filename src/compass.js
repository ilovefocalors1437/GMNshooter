// compass.js — แถบ compass บนสุด
//
// spec §8: "ชิ้นที่ทำให้ทั้งเกมทำงาน"
// แสดงซุ้ม 180° เต็มแถบพอดี → เป้าไม่มีทางหลุดออกนอกแถบได้เลย
// (ขอบซ้ายแถบ = yaw +90°, กลาง = 0°, ขอบขวา = -90°)
//
// Phase B จะเพิ่ม marker ของเพื่อน → addMarker() รับสีได้ตั้งแต่ตอนนี้

import { CFG, DEG } from './config.js';
import { anglesTo } from './camera-control.js';

export class Compass {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0;
    this.dpr = 1;
    this._a = {};
    this.extra = [];          // Phase B: [{yaw, color, label}]
    this.resize();
  }

  resize() {
    const s = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--ui-scale')) || 1.5;
    this.h = CFG.compass.heightPx * s;
    this.w = window.innerWidth;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.scale = s;
  }

  /** yaw → x บนแถบ. yaw +90° (ซ้ายสุด) = x 0, yaw -90° = x กว้างสุด */
  xOf(yaw) { return (0.5 - yaw / Math.PI) * this.w; }

  /**
   * @param now      gameTime (ms)
   * @param yaw      ทิศที่ผู้เล่นหันอยู่
   * @param meteors  array จาก MeteorField.active
   * @param camPos   ตำแหน่งกล้อง (คำนวณ yaw ของเป้า)
   * @param fov      องศาแนวนอนของกล้อง — วาดกรอบ "ตรงนี้คือที่เห็นอยู่"
   */
  draw(now, yaw, meteors, camPos, fovDeg) {
    const g = this.ctx, w = this.w, h = this.h, s = this.scale;
    const C = CFG.compass;
    g.clearRect(0, 0, w, h);

    // พื้นแถบ
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(6,10,22,.92)');
    grad.addColorStop(1, 'rgba(6,10,22,.35)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // กรอบ "สิ่งที่เห็นบนจอตอนนี้"
    const half = (fovDeg * DEG) / 2;
    const xa = this.xOf(yaw + half), xb = this.xOf(yaw - half);
    g.fillStyle = 'rgba(255,255,255,.06)';
    g.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), h);

    // ขีดทุก 15° — ขีดใหญ่ที่ 0 และ ±90 (ขอบซุ้ม)
    g.lineWidth = Math.max(1, 1 * s);
    for (let d = -90; d <= 90; d += 15) {
      const x = this.xOf(d * DEG);
      const major = d === 0 || d === 90 || d === -90;
      g.strokeStyle = major ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.20)';
      g.beginPath();
      g.moveTo(x, h - (major ? 20 * s : 11 * s));
      g.lineTo(x, h - 3 * s);
      g.stroke();
    }

    // ป้ายขอบซุ้ม + กลาง — ชิดขอบด้วย textAlign ไม่ใช่ตำแหน่ง ไม่งั้นตัวหนังสือโดนตัด
    g.font = `700 ${11 * s}px Bahnschrift, Segoe UI, sans-serif`;
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,.42)';
    g.textAlign = 'left';
    g.fillText('ซ้ายสุด', 8 * s, h - 30 * s);
    g.textAlign = 'right';
    g.fillText('ขวาสุด', w - 8 * s, h - 30 * s);
    g.textAlign = 'center';
    g.fillStyle = C.selfColor;
    g.fillText('กลางซุ้ม', this.xOf(0), h - 30 * s);

    // ── marker อุกกาบาต ──
    const blink = Math.sin(now * 0.001 * Math.PI * 2 * C.blinkHz) > 0;
    for (const m of meteors) {
      const a = anglesTo(camPos, m.position, this._a);
      const x = this.xOf(a.yaw);
      const tele = m.telegraph;
      if (tele && !blink) continue;                 // กระพริบตอน telegraph
      this._marker(x, h, tele ? C.telegraphColor : C.meteorColor, tele, s);
    }

    // ── marker เพิ่มเติม (Phase B: ป้อมเพื่อน) ──
    for (const e of this.extra) this._marker(this.xOf(e.yaw), h, e.color, false, s);

    // ── หัวลูกศรบอกทิศที่ผู้เล่นหันอยู่ ──
    const x = this.xOf(yaw);
    g.fillStyle = C.selfColor;
    g.beginPath();
    g.moveTo(x, h - 1);
    g.lineTo(x - 8 * s, h - 13 * s);
    g.lineTo(x + 8 * s, h - 13 * s);
    g.closePath();
    g.fill();

    // เส้นใต้แถบ
    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.lineWidth = Math.max(1, s);
    g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
  }

  _marker(x, h, color, telegraph, s) {
    const g = this.ctx;
    const size = CFG.compass.markerSize * s;
    const y = h * 0.34;

    g.save();
    g.translate(x, y);
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = (telegraph ? 16 : 9) * s;

    if (telegraph) {
      // สามเหลี่ยมชี้ลง + ขีดยาว = "ยังมาไม่ถึง แต่มาแน่"
      g.beginPath();
      g.moveTo(0, size * 0.55);
      g.lineTo(-size * 0.5, -size * 0.4);
      g.lineTo(size * 0.5, -size * 0.4);
      g.closePath(); g.fill();
      g.globalAlpha = 0.5;
      g.fillRect(-1 * s, size * 0.6, 2 * s, h - y - size * 0.6);
    } else {
      g.beginPath();
      g.arc(0, 0, size * 0.42, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}
