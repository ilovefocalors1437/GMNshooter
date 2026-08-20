// turret-rig.js — Meteor Watch
// ป้อมปืนสำหรับ "เห็นป้อมของเพื่อน" ในฉาก (ไม่ใช่ viewmodel ของตัวเอง)
//
// convention:
//   +Z = ปากกระบอกปืน  (ตรงกับ Object3D.lookAt ของ three.js)
//   yaw   = หมุน Head รอบแกน Y   ซุ้ม ±90°
//   pitch = หมุน Barrel รอบแกน X  0..80°   ***ใส่ค่าเป็นลบ***  barrel.rotation.x = -pitch
//
// import { createTurret, buildTurretProcedural } from './turret-rig.js'

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const YAW_LIMIT   = Math.PI / 2;          // ±90°
const PITCH_MIN   = 0;
const PITCH_MAX   = THREE.MathUtils.degToRad(80);   // ห้ามถึง 90° (gimbal คว้าง)

// ────────────────────────────────────────────────
// Rig — ใช้ได้กับทั้ง GLB และตัว procedural
// ────────────────────────────────────────────────
class TurretRig {
  constructor(root, parts, color) {
    this.root   = root;
    this.head   = parts.head;
    this.barrel = parts.barrel;
    this.muzzle = parts.muzzle;

    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.recoil = 0;
    this._barrelZ = this.barrel.position.z;

    // muzzle flash: billboard + additive + PointLight สั้นๆ
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0,
    }));
    this.flash.scale.setScalar(0.9);
    this.muzzle.add(this.flash);

    this.light = new THREE.PointLight(0xffd9a0, 0, 24, 2);
    this.muzzle.add(this.light);
    this._flashT = 0;

    if (color) this.setColor(color);
  }

  // สีประจำผู้เล่น — ทาเฉพาะวัสดุ Accent ตัวถังยังเป็น silhouette ดำ
  setColor(hex) {
    this.root.traverse(o => {
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.name === 'Accent') {
            m.color.set(hex);
            if (m.emissive) m.emissive.set(hex).multiplyScalar(0.6);
          }
        }
      }
    });
  }

  aim(yaw, pitch) {
    this.targetYaw   = clamp(yaw,   -YAW_LIMIT, YAW_LIMIT);
    this.targetPitch = clamp(pitch,  PITCH_MIN, PITCH_MAX);
  }

  fire() {
    this.recoil  = 1;
    this._flashT = 1;
    this.flash.material.rotation = Math.random() * Math.PI * 2;  // สุ่มทุกนัด
  }

  // world position + direction ของปากกระบอก (ใช้สปอว์นกระสุน)
  getMuzzle(outPos = new THREE.Vector3(), outDir = new THREE.Vector3()) {
    this.muzzle.getWorldPosition(outPos);
    this.barrel.getWorldDirection(outDir);   // +Z ของ barrel
    return { pos: outPos, dir: outDir };
  }

  // dt เป็นวินาที — ทุกอย่าง frame-rate independent
  update(dt) {
    const kAim = 10, kRecoil = 14, kFlash = 26;

    this.yaw   += (this.targetYaw   - this.yaw)   * (1 - Math.exp(-kAim * dt));
    this.pitch += (this.targetPitch - this.pitch) * (1 - Math.exp(-kAim * dt));

    this.head.rotation.y   =  this.yaw;
    this.barrel.rotation.x = -this.pitch;      // ลบ = เงยขึ้น

    this.recoil  *= Math.exp(-kRecoil * dt);
    this._flashT *= Math.exp(-kFlash  * dt);

    this.barrel.position.z = this._barrelZ - this.recoil * 0.22;

    this.flash.material.opacity = this._flashT;
    this.flash.scale.setScalar(0.5 + this._flashT * 0.9);
    this.light.intensity = this._flashT * 12;
  }
}

// ────────────────────────────────────────────────
// A) โหลดจาก turret.glb
// ────────────────────────────────────────────────
export async function createTurret(url = './turret.glb', color = 0x59c0ff) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  const parts = {
    head:   root.getObjectByName('Head'),
    barrel: root.getObjectByName('Barrel'),
    muzzle: root.getObjectByName('Muzzle'),
  };
  for (const [k, v] of Object.entries(parts)) {
    if (!v) throw new Error(`turret.glb: ไม่เจอ node "${k}" — โมเดลถูก merge มาหรือเปล่า?`);
  }
  return new TurretRig(root, parts, color);
}

// ────────────────────────────────────────────────
// B) สร้างด้วยโค้ด — ไม่ต้องมีไฟล์เลย
//    ใช้ตอนขั้น 1–2 เพื่อไม่ให้เรื่อง asset บล็อกงาน
// ────────────────────────────────────────────────
export function buildTurretProcedural(color = 0x59c0ff) {
  const body   = new THREE.MeshStandardMaterial({ name: 'Body',   color: 0x1a1c22, roughness: 0.85 });
  const accent = new THREE.MeshStandardMaterial({ name: 'Accent', color, emissive: color,
                                                  emissiveIntensity: 0.6, roughness: 0.4 });

  const root = new THREE.Group();  root.name = 'TurretRoot';

  const base = new THREE.Group();  base.name = 'Base';
  base.add(mesh(new THREE.CylinderGeometry(0.86, 1.0, 0.26, 8), body, 0, 0.13, 0));
  base.add(mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.14, 12), accent, 0, 0.41, 0));
  root.add(base);

  const head = new THREE.Group(); head.name = 'Head'; head.position.y = 0.44;
  head.add(mesh(new THREE.BoxGeometry(0.86, 0.52, 0.92), body, 0, 0.26, -0.05));
  head.add(mesh(new THREE.BoxGeometry(0.06, 0.30, 0.60), accent,  0.46, 0.30, -0.05));
  head.add(mesh(new THREE.BoxGeometry(0.06, 0.30, 0.60), accent, -0.46, 0.30, -0.05));
  base.add(head);

  const barrel = new THREE.Group(); barrel.name = 'Barrel';
  barrel.position.set(0, 0.34, 0.30);
  const tube = mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.30, 10), body, 0, 0, 0.65);
  tube.rotation.x = Math.PI / 2;                        // ตั้งให้ชี้ +Z
  barrel.add(tube);
  barrel.add(mesh(new THREE.BoxGeometry(0.26, 0.26, 0.22), body, 0, 0, 1.36));
  const band = mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.10, 10), accent, 0, 0, 1.0);
  band.rotation.x = Math.PI / 2;
  barrel.add(band);
  head.add(barrel);

  const muzzle = new THREE.Object3D(); muzzle.name = 'Muzzle';
  muzzle.position.z = 1.18;
  barrel.add(muzzle);

  return new TurretRig(root, { head, barrel, muzzle }, null);
}

function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

// muzzle flash texture — วาดเองด้วย canvas ไม่ต้องหาไฟล์
function makeFlashTexture(size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,225,150,0.9)');
  grad.addColorStop(0.55, 'rgba(255,150,40,0.35)');
  grad.addColorStop(1.00, 'rgba(255,120,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);

  // แฉกแสง — ทำให้ไม่ดูเป็นวงกลมเปล่า
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,240,200,0.8)'; g.lineWidth = size * 0.05;
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI * 2 * i) / 5 + 0.3;
    g.beginPath(); g.moveTo(r, r);
    g.lineTo(r + Math.cos(a) * r * 0.95, r + Math.sin(a) * r * 0.95);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ── ใช้ยังไง ──────────────────────────────────
const turret = await createTurret('./turret.glb', 0xff4d6d);
// หรือ: const turret = buildTurretProcedural(0xff4d6d);
scene.add(turret.root);
turret.root.position.set(12, 0, -30);

// ทุก frame
turret.aim(playerYaw, playerPitch);   // radians
turret.update(dt);

// ตอนยิง
turret.fire();
const { pos, dir } = turret.getMuzzle();
spawnTracer(pos, dir);
──────────────────────────────────────────────── */
