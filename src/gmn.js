// gmn.js — ดึงอุกกาบาตจริงจาก Global Meteor Network มาป้อนให้ spawner
//
// สิ่งที่มาจากข้อมูลจริง:  ทิศ (radiant az/alt) · ความเร็ว (Vgeo) · ความสว่าง (mag)
// สิ่งที่มาจากเกม:        จังหวะการเกิด (spawnRate) · ระยะทาง · จุดตก
//
// spec §7: "เวลามาจากเกม · ทิศ/ความเร็ว/ขนาดมาจากข้อมูลจริง"
// และ **ห้ามใช้ตัวคูณเวลา** (×200, ×10k) เพราะอุกกาบาตมาเป็นกลุ่ม (ฝนดาวตก)
// คูณเท่าไหร่ก็ยังกระจุก จะเงียบ 3 นาทีแล้วถล่ม 200 ดวงรวด
// คุมด้วย spawnRate ของเกมเท่านั้น ซึ่งเป็น difficulty knob อยู่แล้ว
//
// server แปลง RA/Dec → alt/az ของกรุงเทพ ณ เวลาจริงให้แล้ว (game/db.py)
// ดวงที่เรดิแอนต์อยู่ใต้ขอบฟ้าหรือนอกซุ้ม server คัดออกให้ตั้งแต่ต้นทาง

import { CFG, clamp, DEG } from './config.js';

export class GmnFeed {
  constructor() {
    this.buf = [];
    this.available = false;
    this.checked = false;
    this.stats = null;
    this._loading = false;
    this.used = 0;
    this.loops = 0;
    this.fetchFails = 0;
  }

  async init() {
    try {
      const r = await fetch('/gmn/stats', { cache: 'no-store' });
      const s = await r.json();
      this.available = !!s.available;
      this.stats = s;
      this.checked = true;
      if (this.available) await this._refill();
    } catch (e) {
      this.available = false;
      this.checked = true;
    }
    return this.available;
  }

  async _refill() {
    if (this._loading) return;
    this._loading = true;
    try {
      const r = await fetch(`/gmn/spawn?n=${CFG.gmn.batch}`, { cache: 'no-store' });
      const d = await r.json();
      if (d.events && d.events.length) {
        this.buf.push(...d.events);
        this.fetchFails = 0;
      }
    } catch (e) {
      // ดึงไม่ได้ก็ลองใหม่รอบหน้า — ห้ามเอาค่าสุ่มมาแทนเด็ดขาด
      this.fetchFails++;
    }
    this._loading = false;
  }

  /**
   * ดึง 1 ดวง — คืน null ถ้าคิวว่าง
   * ผู้เรียก **ห้าม** เอา null ไปเป็นข้ออ้างสุ่มเอง ต้องรอแล้วลองใหม่เท่านั้น
   */
  take() {
    if (this.buf.length < CFG.gmn.refillAt) this._refill();
    if (!this.buf.length) return null;
    this.used++;
    return this.buf.shift();
  }

  /**
   * เรียกตอนคิวว่างนานผิดปกติ — วนดึงรอบใหม่จากทั้งปีที่ bake ไว้
   *
   * DB สุ่มหยิบแบบมีการคืนที่ (sampling with replacement) เลยไม่มีวัน "ใช้หมด"
   * ที่ทำให้แห้งได้จริงมีแค่ fetch พลาด/ช้า — อันนั้นแก้ด้วยการยิงซ้ำ
   * @param dryMs คิวว่างมานานเท่าไรแล้ว
   */
  poke(dryMs) {
    this._refill();
    if (dryMs >= CFG.gmn.restartLoopMs && !this._loading) {
      this._loading = false;
      this.buf.length = 0;
      this.loops++;
      this._refill();          // เริ่มวนรอบใหม่
    }
  }

  /**
   * แปลงเหตุการณ์จริง → พารามิเตอร์เส้นทางที่ meteors.js ใช้ได้
   *
   * @param ev   event จาก /gmn/spawn
   * @param now  gameTime (ms)
   * @param rand ฟังก์ชันสุ่มของ field (จะได้ deterministic ตามที่ field คุม)
   */
  toWire(ev, now, id, rand) {
    const M = CFG.meteor, G = CFG.gmn;

    const yaw0 = ev.yawDeg * DEG;
    const pitch0 = ev.altDeg * DEG;

    // วางจุดเกิด "ตามแนวเรดิแอนต์ที่ระยะคงที่" ไม่ใช่ระยะแนวนอนคงที่
    // ถ้าใช้ระยะแนวนอนคงที่ ดวงที่เรดิแอนต์เกือบกลางหัว (alt 87°) จะถูกดันขึ้นไป
    // สูงเป็นหมื่นเมตรจาก tan(87°) แล้วกลายเป็นจุดจิ๋วมองไม่เห็น
    const R = G.spawnRange;
    const dist0 = Math.max(40, R * Math.cos(pitch0));
    const alt0 = R * Math.sin(pitch0);

    // ── ความเร็วจริง → เวลาบิน (เร็วจริง = ถึงเร็วในเกมด้วย) ──
    const vt = clamp((ev.vgeo - G.vgeoSlow) / (G.vgeoFast - G.vgeoSlow), 0, 1);
    const flightSec = M.flightSecMax + (M.flightSecMin - M.flightSecMax) * vt;

    // ── ความสว่างจริง → ขนาดในเกม (mag ยิ่งติดลบยิ่งสว่าง = ยิ่งใหญ่) ──
    const mag = (ev.mag === null || ev.mag === undefined) ? G.magDim : ev.mag;
    const mt = clamp((G.magDim - mag) / (G.magDim - G.magBright), 0, 1);
    const size = M.sizeMin + (M.sizeMax - M.sizeMin) * mt;

    // ── จุดตกยังเป็นของเกม (ต้องอยู่ในซุ้มและใกล้พอให้เห็นระเบิด) ──
    const lim = (CFG.camera.yawLimitDeg - M.yawMarginDeg) * DEG;
    const drift = (rand() - 0.5) * 2 * M.yawDriftDeg * DEG;

    return {
      id,
      t0: now,
      yaw0,
      dist0,
      alt0,
      yawImpact: clamp(yaw0 + drift, -lim, lim),
      distImpact: M.impactDistMin + rand() * (M.impactDistMax - M.impactDistMin),
      flightSec,
      size,
      spinAxis: null,           // meteors.js จะสร้างให้จาก spin
      spin: [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, (rand() * 2 - 1) * M.spinSpeed],
      gmn: ev,                  // ติดไปด้วยเพื่อ contact log
    };
  }
}
