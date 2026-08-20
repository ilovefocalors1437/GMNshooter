// touch-look.js — เล็งด้วยการลากนิ้ว แบบหมุนจออิสระ (shift-lock ของ Roblox)
//
// สิ่งที่ *ไม่* ทำ: ปุ่มลูกศรกดค้างเพื่อหมุน — เด็กที่เล่นมือถือคุ้นกับการ "ลากแล้วมันหมุนตาม"
// ลากไปเรื่อยๆ ก็หมุนไปเรื่อยๆ นิ้วปล่อยแล้วค้างมุมเดิม ไม่สปริงกลับ
//
// นิ้วไหนก็ลากได้ ยกเว้นนิ้วที่แตะปุ่มยิงอยู่ → ยิงไปเล็งไปพร้อมกันได้ 2 นิ้ว
// (ข้อนี้สำคัญมาก ถ้าลากได้ทีละนิ้วเดียว เด็กจะยิงตอนกำลังหมุนไม่ได้เลย)

import { CFG, DEG, clamp, damp } from './config.js';

export class TouchLook {
  constructor(el) {
    this.el = el;
    this.yaw = 0;
    this.pitch = 14 * DEG;
    this.tYaw = 0;
    this.tPitch = 14 * DEG;

    this.yawLimit = CFG.camera.yawLimitDeg * DEG;
    this.pitchMin = CFG.camera.pitchMinDeg * DEG;
    this.pitchMax = CFG.camera.pitchMaxDeg * DEG;

    this.enabled = true;
    this._touch = null;          // นิ้วที่กำลังใช้ลากเล็ง
    this._sens = { x: 0.005, y: 0.005 };
    this._lastTapAt = 0;
    this.onDoubleTap = null;

    this._bind();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const T = CFG.touch;
    // ลากเต็มความกว้างจอ = กวาดกี่องศา — ผูกกับขนาดจอ ไม่ใช่ค่าคงที่ต่อ px
    // ไม่งั้นมือถือจอใหญ่กับจอเล็กจะรู้สึกคนละเกม
    this._sens.x = (T.sweepYawDeg * DEG) / Math.max(1, r.width || window.innerWidth);
    this._sens.y = (T.sweepPitchDeg * DEG) / Math.max(1, r.height || window.innerHeight);
  }

  _bind() {
    const opt = { passive: false };
    this.el.addEventListener('touchstart', (e) => this._start(e), opt);
    this.el.addEventListener('touchmove', (e) => this._move(e), opt);
    this.el.addEventListener('touchend', (e) => this._end(e), opt);
    this.el.addEventListener('touchcancel', (e) => this._end(e), opt);

    // เผื่อทดสอบบนคอม — ลากเมาส์ได้เหมือนกัน
    let mouse = false;
    this.el.addEventListener('mousedown', (e) => { mouse = true; this._px = e.clientX; this._py = e.clientY; });
    window.addEventListener('mouseup', () => { mouse = false; });
    window.addEventListener('mousemove', (e) => {
      if (!mouse || !this.enabled) return;
      this._apply(e.clientX - this._px, e.clientY - this._py);
      this._px = e.clientX; this._py = e.clientY;
    });
  }

  _start(e) {
    if (!this.enabled) return;
    if (this._touch === null) {
      const t = e.changedTouches[0];
      this._touch = { id: t.identifier, x: t.clientX, y: t.clientY,
                      t: performance.now(), moved: 0 };
    }
    e.preventDefault();
  }

  _move(e) {
    if (!this.enabled || !this._touch) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== this._touch.id) continue;
      const dx = t.clientX - this._touch.x, dy = t.clientY - this._touch.y;
      this._touch.moved += Math.abs(dx) + Math.abs(dy);
      this._touch.x = t.clientX; this._touch.y = t.clientY;
      this._apply(dx, dy);
    }
    e.preventDefault();
  }

  _end(e) {
    if (!this._touch) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== this._touch.id) continue;
      const dur = performance.now() - this._touch.t;
      const tap = dur < CFG.touch.tapMs && this._touch.moved < CFG.touch.tapPx;
      this._touch = null;
      if (tap) {
        const now = performance.now();
        if (now - this._lastTapAt < CFG.touch.doubleTapMs) {
          this._lastTapAt = 0;
          this.recenter();                       // แตะสองที = กลับกลางซุ้ม
        } else {
          this._lastTapAt = now;
        }
      }
    }
    e.preventDefault();
  }

  _apply(dx, dy) {
    // ลากขวา = หันขวา (yaw ลด เพราะ yaw บวก = ซ้าย) / ลากขึ้น = เงยขึ้น
    this.tYaw = clamp(this.tYaw - dx * this._sens.x, -this.yawLimit, this.yawLimit);
    this.tPitch = clamp(this.tPitch - dy * this._sens.y, this.pitchMin, this.pitchMax);
  }

  recenter() {
    this.tYaw = 0;
    this.tPitch = 14 * DEG;
    if (this.onDoubleTap) this.onDoubleTap();
  }

  /** ทำให้นุ่ม — frame-rate independent เหมือนทุกที่ในเกมนี้ */
  update(dt) {
    const k = damp(CFG.touch.kSmooth, dt);
    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;
  }
}
