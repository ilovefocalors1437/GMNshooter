// camera-control.js — กล้อง FPS + clamp + aim assist
//
// ระบบพิกัด (ยึดอันนี้ทั้งเกม):
//   yaw  = 0  → มองไปทาง -Z          yaw บวก = หันซ้าย   clamp ±90°
//   pitch= 0  → มองขนานพื้น          pitch บวก = เงยขึ้น  clamp 0..80°
//   dir(yaw,pitch) = (-sin·cos, sin(pitch), -cos·cos)
//
// smoothing ใช้ 1-exp(-k*dt) ทุกที่ ห้าม lerp ค่าคงที่ (spec §4)

import * as THREE from 'three';
import { CFG, DEG, clamp, damp } from './config.js';

const _v = new THREE.Vector3();

/** มุมของจุดในโลก เทียบกับตำแหน่งกล้อง → {yaw, pitch, dist} */
export function anglesTo(camPos, target, out = {}) {
  const dx = target.x - camPos.x, dy = target.y - camPos.y, dz = target.z - camPos.z;
  const horiz = Math.hypot(dx, dz);
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, horiz);
  out.dist = Math.hypot(horiz, dy);
  return out;
}

/** yaw/pitch → เวกเตอร์ทิศทาง (normalized) */
export function dirFrom(yaw, pitch, out = new THREE.Vector3()) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** ผลต่างมุมแบบสั้นสุด (-π..π) */
export function angleDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class CameraControl {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;

    const c = CFG.camera;
    this.yawLimit = c.yawLimitDeg * DEG;
    this.pitchMin = c.pitchMinDeg * DEG;
    this.pitchMax = c.pitchMaxDeg * DEG;

    this.yaw = 0; this.pitch = 12 * DEG;
    this.targetYaw = 0; this.targetPitch = 12 * DEG;

    this.locked = false;        // pointer lock อยู่ไหม
    this.recentering = false;
    this.enabled = true;

    // เป้าที่ aim assist จับอยู่ตอนนี้ (HUD ใช้โชว์ crosshair แดง)
    this.assistTarget = null;

    this._absX = 0.5; this._absY = 0.45;   // fallback ตอนไม่มี pointer lock
    this._hasAbs = false;
    this._angles = {};

    this._onMove = this._onMove.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestLock() {
    if (!CFG.camera.usePointerLock) return;
    const el = document.body;
    if (el.requestPointerLock) {
      const r = el.requestPointerLock();
      if (r && r.catch) r.catch(() => { /* browser ไม่ให้ ก็ใช้โหมด absolute */ });
    }
  }

  _onLockChange() {
    this.locked = document.pointerLockElement === document.body;
  }

  _onMove(e) {
    if (!this.enabled) return;

    if (this.locked) {
      const s = CFG.camera.sensitivity;
      this.targetYaw -= e.movementX * s;      // เมาส์ขวา = yaw ลด (yaw บวก = ซ้าย)
      this.targetPitch -= e.movementY * s;
      this.recentering = false;
    } else {
      // ไม่มี pointer lock → แมพตำแหน่งเมาส์บนจอตรงๆ กับซุ้ม
      // (ขอบซ้ายจอ = -90°, ขอบขวา = +90°) ไม่มีทางเล็งหลุดซุ้ม
      this._hasAbs = true;
      this._absX = e.clientX / window.innerWidth;
      this._absY = e.clientY / window.innerHeight;
      this.recentering = false;
    }
    this._clampTargets();
  }

  _clampTargets() {
    this.targetYaw = clamp(this.targetYaw, -this.yawLimit, this.yawLimit);
    this.targetPitch = clamp(this.targetPitch, this.pitchMin, this.pitchMax);
  }

  /** กด Space / double-click → กลับกลางซุ้ม */
  recenter() {
    this.recentering = true;
  }

  /**
   * @param dt      วินาที (เป็น 0 ตอน hitstop → ทุกอย่างหยุดสนิท)
   * @param targets array ของ {position: Vector3, hittable: bool} สำหรับ aim assist
   */
  update(dt, targets) {
    if (!this.locked && this._hasAbs) {
      this.targetYaw = -(this._absX - 0.5) * 2 * this.yawLimit;
      this.targetPitch = clamp(
        (1 - this._absY) * CFG.camera.absPitchTopDeg * DEG, this.pitchMin, this.pitchMax);
    }

    if (this.recentering) {
      const k = damp(CFG.camera.kRecenter, dt);
      this.targetYaw += (0 - this.targetYaw) * k;
      this.targetPitch += (14 * DEG - this.targetPitch) * k;
      if (Math.abs(this.targetYaw) < 0.002) this.recentering = false;
    }

    // ── aim assist: หาเป้าที่ใกล้แนวเล็งที่สุดในกรวย coneDeg ──
    this.assistTarget = this._applyAssist(dt, targets);

    this._clampTargets();

    const k = damp(CFG.camera.kAim, dt);
    this.yaw += angleDelta(this.targetYaw, this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
  }

  _applyAssist(dt, targets) {
    if (!targets || !targets.length || dt <= 0) return this.assistTarget;

    const cone = CFG.assist.coneDeg * DEG;
    const camPos = this.camera.position;
    let best = null, bestAng = cone, bestYaw = 0, bestPitch = 0;

    for (const t of targets) {
      if (!t.hittable) continue;
      const a = anglesTo(camPos, t.position, this._angles);
      const dy = angleDelta(a.yaw, this.targetYaw);
      const dp = a.pitch - this.targetPitch;
      const ang = Math.hypot(dy, dp);          // ประมาณระยะเชิงมุม พอสำหรับกรวย 6°
      if (ang < bestAng) { bestAng = ang; best = t; bestYaw = a.yaw; bestPitch = a.pitch; }
    }
    if (!best) return null;

    // ยิ่งใกล้กลางกรวย ยิ่งดูดแรง — ขอบกรวยแรงเป็น 0 จะได้ไม่กระตุกตอนเป้าหลุด
    const w = 1 - bestAng / cone;
    this.targetPitch += (bestPitch - this.targetPitch) * damp(CFG.assist.pitchPullK * w, dt);
    this.targetYaw += angleDelta(bestYaw, this.targetYaw) * damp(CFG.assist.yawPullK * w, dt);
    return best;
  }

  /**
   * เป้าที่จะโดนถ้ากดยิงตอนนี้ — null = พลาด
   * ใช้กรวย lockOnDeg แยกจากกรวยดูดกล้อง จะได้จูนแยกกันได้
   */
  /**
   * เป้าที่ระบบจะ "ช่วยแก้ทิศ" ให้ถ้ากดยิงตอนนี้ — null = ไม่ช่วยเลย ยิงตรงตาม crosshair
   * ผลพลอยได้: this.pickError01 = ความห่างจากกลางกรวย 0..1
   * (0 = เล็งตรงกลางเป๊ะ, 1 = คาบเส้นขอบกรวย) main.js เอาไปคิดว่าจะช่วยแก้แค่ไหน
   */
  pickTarget(targets) {
    const cone = CFG.assist.lockOnDeg * DEG;
    const camPos = this.camera.position;
    let best = null, bestScore = Infinity;

    for (const t of targets) {
      if (!t.hittable) continue;
      const a = anglesTo(camPos, t.position, this._angles);
      const ang = Math.hypot(angleDelta(a.yaw, this.yaw), a.pitch - this.pitch);

      // ดวงที่อยู่ใกล้กินพื้นที่จอกว้างกว่ากรวย 4° — ถ้าใช้กรวยคงที่
      // เล็งโดนตัวมันเต็มๆ แล้วยังนับว่าพลาด ซึ่งอธิบายให้เด็กไม่ได้
      const angularRadius = t.radius ? Math.atan(t.radius / Math.max(1, a.dist)) : 0;
      const limit = Math.max(cone, angularRadius);
      if (ang > limit) continue;

      const score = ang / limit;              // normalize ไม่งั้นดวงใหญ่ได้เปรียบเกิน
      if (score < bestScore) { bestScore = score; best = t; }
    }
    this.pickError01 = best ? bestScore : 1;
    return best;
  }

  getAimDir(out = _v) { return dirFrom(this.yaw, this.pitch, out); }

  /** เขียนลงกล้องจริง — shake ถูกบวกทับตรงนี้ที่เดียว */
  applyTo(camera, shake) {
    camera.rotation.set(
      this.pitch + (shake ? shake.pitch : 0),
      this.yaw + (shake ? shake.yaw : 0),
      shake ? shake.roll : 0,
      'YXZ',
    );
  }

  dispose() {
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
