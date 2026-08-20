// net.js — socket client ฝั่งจอใหญ่
//
// หน้าที่มีแค่ 3 อย่าง:
//   1. หา offset นาฬิกาเทียบ server  ← หัวใจของทั้ง architecture
//   2. รับมุมเล็งของทุกคนแล้วทำให้นุ่ม
//   3. ส่งต่อ event spawn/hit/miss ให้ screen-main
//
// *** ทำไม clock offset ถึงสำคัญ ***
// อุกกาบาตไม่ได้ถูกส่งตำแหน่งมาทุก frame (ห้ามทำ) — server ส่งแค่ "เกิดเมื่อไร ไปทางไหน"
// แล้วจอใหญ่คำนวณตำแหน่งเองจาก getPosition(m, now)
// ถ้า now ของจอใหญ่เพี้ยนจาก server 200ms อุกกาบาตจะอยู่คนละที่กับที่ server ตัดสิน
// → ยิงตรงเป้าแล้วไม่โดน โดยไม่มีใครอธิบายได้ว่าทำไม

import { CFG, damp } from './config.js';

export class Net {
  constructor() {
    this.socket = null;
    this.connected = false;

    // serverNow() = performance.now() + this.offset
    this.offset = 0;
    this.bestRtt = Infinity;
    this.synced = false;

    this.slots = [];                 // roster ล่าสุด
    this.aim = new Map();            // slot -> {yaw, pitch, tYaw, tPitch}
    this._handlers = new Map();
  }

  serverNow() { return performance.now() + this.offset; }

  on(evt, fn) {
    if (!this._handlers.has(evt)) this._handlers.set(evt, []);
    this._handlers.get(evt).push(fn);
  }

  _fire(evt, data) {
    const hs = this._handlers.get(evt);
    if (hs) for (const h of hs) h(data);
  }

  connect() {
    // socket.io ถูกโหลดมาก่อนหน้าแบบ global script (ไม่ใช่ ES module)
    this.socket = window.io({ transports: ['websocket', 'polling'] });
    const s = this.socket;

    s.on('connect', () => {
      this.connected = true;
      s.emit('screen_hello', {});
      this._syncClock();
    });

    s.on('disconnect', () => { this.connected = false; });

    s.on('hello', (d) => {
      this.hello = d;
      this._fire('hello', d);
    });

    s.on('time_sync', (d) => this._onSync(d));

    s.on('roster', (d) => { this.slots = d.slots; this._fire('roster', d); });
    s.on('state', (d) => { this.slots = d.slots; this._fire('state', d); });
    s.on('lobby', (d) => this._fire('lobby', d));

    // มุมเล็งของทุกคนมารวมกันทีเดียว — เล็กมาก (2 float ต่อคน)
    s.on('aims', (d) => {
      for (const k of Object.keys(d.a)) {
        const slot = +k, [y, p] = d.a[k];
        let a = this.aim.get(slot);
        if (!a) { a = { yaw: y, pitch: p, tYaw: y, tPitch: p }; this.aim.set(slot, a); }
        a.tYaw = y; a.tPitch = p;
      }
    });

    for (const evt of ['spawn', 'hit', 'burnup', 'kicked', 'round']) {
      s.on(evt, (d) => this._fire(evt, d));
    }

    setInterval(() => { if (this.connected) this._syncClock(); }, CFG.net.resyncSec * 1000);
  }

  // ── clock sync ────────────────────────────────────────────
  _syncClock() {
    let n = 0;
    const tick = () => {
      if (n++ >= CFG.net.syncPings) return;
      this.socket.emit('time_sync', { c: performance.now() });
      setTimeout(tick, CFG.net.syncIntervalMs);
    };
    tick();
  }

  _onSync(d) {
    const recv = performance.now();
    const rtt = recv - d.c;
    if (rtt >= this.bestRtt) return;      // เอาเฉพาะรอบที่เน็ตนิ่งที่สุด
    this.bestRtt = rtt;
    // เวลาที่ server อ่านค่า ตกอยู่กลางทางไป-กลับพอดี
    this.offset = d.s - d.c - rtt / 2;
    this.synced = true;
  }

  // ── เรียกทุก frame ────────────────────────────────────────
  update(dt) {
    const k = damp(CFG.net.kAimRemote, dt);
    for (const a of this.aim.values()) {
      a.yaw += (a.tYaw - a.yaw) * k;
      a.pitch += (a.tPitch - a.pitch) * k;
    }
  }

  aimOf(slot) {
    return this.aim.get(slot) || null;
  }

  slotInfo(slot) {
    return this.slots.find(s => s.slot === slot) || null;
  }

  activeSlots() {
    return this.slots.filter(s => s.taken);
  }
}
