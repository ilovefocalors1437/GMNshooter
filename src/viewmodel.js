// viewmodel.js — ปืน/แท่นยิงที่ขอบล่างจอ
//
// ไม่มี animation file ทุกอย่างเป็นโค้ด (spec §7)
// - วาดด้วย canvas ใบเดียว แล้วแปะเป็น plane ใน orthographic overlay scene
// - recoil = เลื่อนลง แล้ว recoil *= exp(-k*dt)
// - idle = ขยับเป็นเลข 8 ช้าๆ ด้วย sin/cos
// - sway = เอียงตามความเร็วการหันกล้อง (ทำให้รู้สึกว่ามีน้ำหนัก)
//
// ส่วน muzzle flash + PointLight อยู่ใน turret-rig.js เพราะต้องวาบที่ "ปากกระบอกจริง"
// ในฉาก 3D ไม่ใช่ที่ overlay — ฉากถึงจะวาบตามได้

import * as THREE from 'three';
import { CFG, clamp } from './config.js';

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);

    const tex = makeMountTexture();
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.scene.add(this.mesh);

    this.recoil = 0;
    this.t = 0;
    this.sway = 0;
    this.w = 1; this.h = 1;
    this.resize(window.innerWidth, window.innerHeight);
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.camera.left = 0; this.camera.right = w;
    this.camera.bottom = 0; this.camera.top = h;
    this.camera.updateProjectionMatrix();

    const s = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--ui-scale')) || 1.5;
    // กว้างเกินจอไว้หน่อย จะได้ sway แล้วไม่เห็นขอบ
    this.baseW = w * 1.35;
    this.baseH = CFG.viewmodel.heightPx * s;
    this.mesh.scale.set(this.baseW, this.baseH, 1);
  }

  fire() { this.recoil = 1; }

  update(dt, yawVel = 0) {
    const V = CFG.viewmodel;
    this.t += dt;
    this.recoil *= Math.exp(-V.kRecoil * dt);

    // sway ต้อง clamp เสมอ — yawVel ตอนกวาดเร็วๆ ขึ้นไปได้ถึง 6 rad/s
    // ถ้าคูณดิบๆ จะได้ offset เป็นร้อย px แล้วแผ่นเลื่อนหลุดจอ (เคยเป็นมาแล้ว)
    const want = clamp(yawVel * V.swayFromAim, -V.swayMaxPx, V.swayMaxPx);
    this.sway += (want - this.sway) * (1 - Math.exp(-9 * dt));

    // เลข 8: x เดินความถี่ 1 เท่า, y เดิน 2 เท่า
    const a = this.t * Math.PI * 2 * V.idleSpeed;
    const ix = Math.sin(a) * V.idleAmpX;
    const iy = Math.sin(a * 2) * V.idleAmpY;

    // ไม่หมุน: แผ่นกว้างกว่าจอ เอียงนิดเดียวขอบล่างก็เฉียงจนดูเหมือนจอเอียง
    this.mesh.position.set(
      this.w / 2 + ix + this.sway,
      this.baseH / 2 + iy - this.recoil * V.recoilPx,
      0,
    );
  }

  render(renderer) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}

// แท่นยิง/โล่กันสะเก็ด — silhouette เข้ม + ขอบเรืองแสง
// ระยะดูจริง 3 เมตรจากโปรเจกเตอร์ ไม่ต้องละเอียด
function makeMountTexture(w = 1024, h = 256) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const cx = w / 2;

  // ขอบบังปืน: แบนๆ ยกสูงสองข้าง แอ่นลงตรงกลางให้มองผ่านได้
  // ห้ามสูง ห้ามมีช่องลึก — มันจะไปบังป้อมปืนซึ่งเป็นพระเอกของจอ
  g.fillStyle = '#0a0d16';
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(0, h * 0.34);
  g.lineTo(w * 0.13, h * 0.30);
  g.lineTo(w * 0.30, h * 0.46);
  g.quadraticCurveTo(cx, h * 0.70, w * 0.70, h * 0.46);   // แอ่นกลาง
  g.lineTo(w * 0.87, h * 0.30);
  g.lineTo(w, h * 0.34);
  g.lineTo(w, h);
  g.closePath();
  g.fill();

  // ขอบบนเรืองแสง — เส้นเดียวที่ทำให้ silhouette อ่านออกบนฉากมืด
  g.strokeStyle = 'rgba(89,192,255,.55)';
  g.lineWidth = 3;
  g.stroke();

  // ร่องเสริมความรู้สึกว่าเป็นเหล็ก
  g.strokeStyle = 'rgba(140,180,220,.13)';
  g.lineWidth = 2;
  for (let i = 1; i < 9; i++) {
    const x = (w / 9) * i;
    if (Math.abs(x - cx) < w * 0.20) continue;
    g.beginPath(); g.moveTo(x, h * 0.5); g.lineTo(x, h); g.stroke();
  }

  // แถบส้มเตือนซ้าย-ขวา
  g.fillStyle = 'rgba(255,155,61,.28)';
  g.fillRect(w * 0.04, h * 0.60, w * 0.11, h * 0.10);
  g.fillRect(w * 0.85, h * 0.60, w * 0.11, h * 0.10);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
