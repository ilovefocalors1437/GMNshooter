// float-text.js — ตัวเลขวินาทีลอยขึ้นตอนยิงโดน
//
// เด็กเพิ่งใช้เวลาราวๆ 1 วินาทีเล็งและยิงมัน แล้วเกมบอกว่ามันมีอยู่จริง 1.24 วินาที
// เป็นจังหวะเดียวที่ข้อมูลจริงกับสิ่งที่เด็กเพิ่งทำมาบรรจบกันพอดี
//
// ใช้ DOM ทับ canvas ไม่ใช่ 3D object เพราะตัวหนังสือคมกว่ามากบนมือถือ
// และไม่ต้องแบก texture atlas / SDF font

import { CFG } from './config.js';

export class FloatText {
  constructor(camera) {
    this.camera = camera;
    this.items = [];
    let el = document.getElementById('floatlayer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'floatlayer';
      el.style.cssText = 'position:fixed;inset:0;z-index:7;pointer-events:none;overflow:hidden';
      document.body.appendChild(el);
    }
    this.layer = el;
  }

  add(pos, duration) {
    if (duration === null || duration === undefined) return;
    const F = CFG.floatText;
    if (this.items.length >= F.maxVisible) return;   // ยิงรัวแล้วทับกันจนอ่านไม่ออก

    const el = document.createElement('div');
    el.textContent = `${duration.toFixed(2)}s`;
    el.style.cssText =
      'position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font-weight:700;' +
      `font-size:${F.fontPx}px;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.9)`;
    this.layer.appendChild(el);

    this.items.push({
      el, pos: pos.clone(), t: 0, life: F.lifeMs * 0.001,
      offX: (Math.random() < 0.5 ? -1 : 1) * F.offsetX,   // เยื้อง ไม่ให้บังจุดเล็ง
    });
  }

  update(dt) {
    if (!this.items.length) return;
    const F = CFG.floatText;
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) { it.el.remove(); this.items.splice(i, 1); continue; }

      const p = it.pos.clone().project(this.camera);
      if (p.z > 1) { it.el.style.opacity = '0'; continue; }   // อยู่หลังกล้อง
      it.el.style.left = ((p.x * 0.5 + 0.5) * w + it.offX) + 'px';
      it.el.style.top = ((1 - (p.y * 0.5 + 0.5)) * h - k * F.risePx) + 'px';
      it.el.style.opacity = String(Math.min(1, (1 - k) * 2.4));
    }
  }

  clear() {
    for (const it of this.items) it.el.remove();
    this.items.length = 0;
  }
}
