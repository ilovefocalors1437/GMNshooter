// viewports.js — แบ่งจอเป็น 4 ช่องด้วย scissor
//
//   ┌─────────────┬─────────────┐
//   │  Player 1   │  Player 2   │
//   ├─────────────┼─────────────┤
//   │  Player 3   │ SHARED HUD  │
//   └─────────────┴─────────────┘
//
// ห้ามแบ่ง 3 คอลัมน์ (spec §5) — 16:9 หาร 3 ได้ช่องชะลูด เล่น FPS แล้วอึดอัด
//
// renderer ตัวเดียว scene ตัวเดียว (ฟ้าเดียว เมืองเดียว) กล้อง 3 ตัว
// ถ้าแยก renderer/scene ต่อคน = โหลด asset 3 รอบ และฟ้าจะไม่ใช่ผืนเดียวกันจริง

import * as THREE from 'three';

export class Viewports {
  constructor(renderer) {
    this.renderer = renderer;
    this.w = 1; this.h = 1;
    this.rects = {};
    this.resize(window.innerWidth, window.innerHeight);
  }

  resize(w, h) {
    this.w = w; this.h = h;
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    // หมายเหตุ: three.js นับแกน y จาก "ล่างขึ้นบน" ตรงข้ามกับ CSS
    this.rects = {
      1:   { x: 0,  y: hh, w: hw,     h: h - hh },   // บนซ้าย
      2:   { x: hw, y: hh, w: w - hw, h: h - hh },   // บนขวา
      3:   { x: 0,  y: 0,  w: hw,     h: hh },       // ล่างซ้าย
      hud: { x: hw, y: 0,  w: w - hw, h: hh },       // ล่างขวา
    };
    return this.rects;
  }

  /** กรอบของช่อง HUD ในพิกัด CSS (นับจากบน) เอาไปวาง DOM ทับ */
  hudCss() {
    const r = this.rects.hud;
    return { left: r.x, top: this.h - r.y - r.h, width: r.w, height: r.h };
  }

  /** กรอบของช่องผู้เล่นในพิกัด CSS — ใช้วาง HUD ย่อยของแต่ละคน */
  slotCss(slot) {
    const r = this.rects[slot];
    if (!r) return null;
    return { left: r.x, top: this.h - r.y - r.h, width: r.w, height: r.h };
  }

  /** aspect ที่กล้องแต่ละตัวต้องใช้ (ไม่ใช่ aspect ของทั้งจอ) */
  aspect(slot) {
    const r = this.rects[slot] || this.rects[1];
    return r.w / r.h;
  }

  /**
   * @param cameras Map: slot -> PerspectiveCamera  (เฉพาะ slot ที่มีคนเล่น)
   */
  render(scene, cameras, beforeEach) {
    const R = this.renderer;
    R.setScissorTest(false);
    R.clear();                       // ล้างทั้งจอก่อน ช่องที่ไม่มีคนจะได้เป็นสีพื้น
    R.setScissorTest(true);

    for (const [slot, cam] of cameras) {
      const r = this.rects[slot];
      if (!r) continue;
      // hook สำหรับของที่ต้องหันตามกล้อง (billboard ของอุกกาบาต)
      if (beforeEach) beforeEach(cam, slot);
      R.setViewport(r.x, r.y, r.w, r.h);
      R.setScissor(r.x, r.y, r.w, r.h);
      R.render(scene, cam);
    }

    R.setScissorTest(false);
    R.setViewport(0, 0, this.w, this.h);
  }
}
