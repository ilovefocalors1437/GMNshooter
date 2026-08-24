// space-env.js — Thailand CE-7 Moonshot 3D Space Environment & Rocket Controller
//
// จัดการวัตถุ 3D อวกาศในฉาก Three.js:
//   1. ดวงจันทร์ 3D (The Moon Sphere) — จุดหมายหลักบนฟ้า
//   2. จรวด Long March 5 Y14 — พุ่งทะยานจากแท่นปล่อยขึ้นสู่ชั้นบรรยากาศ
//   3. อุปกรณ์ CE-7 MATCH / ยานสำรวจดวงจันทร์ — โคจรรอบดวงจันทร์
//   4. จานเรดาร์ภาคพื้นดิน (Ground Tracking Dishes) — หมุนสแกนท้องฟ้า

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CFG, DEG } from './config.js';

export class SpaceEnvironment {
  constructor(scene) {
    this.scene = scene;
    this.loader = new GLTFLoader();

    // ── กลุ่มวัตถุ ──
    this.moonGroup = new THREE.Group();
    this.rocketGroup = new THREE.Group();
    this.probeGroup = new THREE.Group();
    this.dishesGroup = new THREE.Group();

    this.scene.add(this.moonGroup);
    this.scene.add(this.rocketGroup);
    this.scene.add(this.probeGroup);
    this.scene.add(this.dishesGroup);

    // ตัวแปรสำหรับ Animation
    this.rocketState = 'pad'; // pad | launch | climbing | tli | orbit
    this.rocketAltKm = 24.0;
    this.rocketProgress = 0;
    this.dishes = [];

    this._init();
  }

  async _init() {
    this._buildMoonFallback();
    this._buildRocketFallback();
    this._buildDishes();

    // โหลดโมเดล 3D GLB
    this._loadMoonGLB();
    this._loadRocketGLB();
    this._loadProbeGLB();
    this._loadDishGLB();
  }

  // ══ 1. ดวงจันทร์ 3D ═════════════════════════════════════════
  _buildMoonFallback() {
    const geo = new THREE.SphereGeometry(18, 24, 24);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xdfecff,
      emissive: 0x5a7ebb,
      emissiveIntensity: 0.45,
      roughness: 0.8,
    });
    this.moonMesh = new THREE.Mesh(geo, mat);
    this.moonMesh.position.set(-140, 250, -420);
    this.moonGroup.add(this.moonMesh);
  }

  async _loadMoonGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.moon);
      const m = gltf.scene;
      m.scale.setScalar(24);
      m.position.copy(this.moonMesh.position);
      this.moonGroup.remove(this.moonMesh);
      this.moonMesh = m;
      this.moonGroup.add(this.moonMesh);
    } catch (e) {
      console.warn('[space-env] ใช้ Moon procedural แทน:', e.message);
    }
  }

  // ══ 2. จรวด Long March 5 Y14 ════════════════════════════════
  _buildRocketFallback() {
    this.rocket = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.2, roughness: 0.5 });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 16, 12), bodyMat);
    core.position.y = 8;
    this.rocket.add(core);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4.5, 12), bodyMat);
    nose.position.y = 18.2;
    this.rocket.add(nose);

    // เปลวไฟไอพ่น
    const flameGeo = new THREE.ConeGeometry(1.4, 8, 8);
    flameGeo.rotateX(Math.PI);
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    });
    this.rocketFlame = new THREE.Mesh(flameGeo, flameMat);
    this.rocketFlame.position.y = -4;
    this.rocket.add(this.rocketFlame);

    this.rocketLight = new THREE.PointLight(0xff7722, 4, 120, 2);
    this.rocketLight.position.y = -2;
    this.rocket.add(this.rocketLight);

    this.rocket.position.set(70, 4, -260);
    this.rocketGroup.add(this.rocket);
  }

  async _loadRocketGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.rocket);
      const m = gltf.scene;
      m.scale.setScalar(1.6);
      m.position.y = 0;
      
      const flame = this.rocketFlame;
      const light = this.rocketLight;
      this.rocketGroup.remove(this.rocket);

      this.rocket = new THREE.Group();
      this.rocket.add(m);
      if (flame) this.rocket.add(flame);
      if (light) this.rocket.add(light);
      this.rocket.position.set(70, 4, -260);
      this.rocketGroup.add(this.rocket);
    } catch (e) {
      console.warn('[space-env] ใช้ Rocket procedural แทน:', e.message);
    }
  }

  // ══ 3. ยานสำรวจดวงจันทร์ CE-7 MATCH ════════════════════════
  async _loadProbeGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.probe);
      this.probe = gltf.scene;
      this.probe.scale.setScalar(3.2);
      this.probe.position.set(-110, 255, -390);
      this.probeGroup.add(this.probe);
      this.probe.visible = false;
    } catch (e) {
      console.warn('[space-env] โหลด CE-7 Probe ไม่สำเร็จ:', e.message);
    }
  }

  // ══ 4. จานเรดาร์ภาคพื้นดิน ═════════════════════════════════
  _buildDishes() {
    const positions = [
      { x: -36, y: 0.2, z: -24, rot: 0.3 },
      { x: 36,  y: 0.2, z: -24, rot: -0.3 },
      { x: 0,   y: 0.2, z: -40, rot: 0 },
    ];
    for (const p of positions) {
      const dGroup = new THREE.Group();
      dGroup.position.set(p.x, p.y, p.z);
      dGroup.rotation.y = p.rot;

      const baseMat = new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.8 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 1.2, 8), baseMat);
      base.position.y = 0.6;
      dGroup.add(base);

      const dishHead = new THREE.Group();
      dishHead.name = 'DishHead';
      dishHead.position.y = 1.6;

      const dishGeo = new THREE.CylinderGeometry(2.4, 0.4, 0.9, 12, 1, true);
      dishGeo.rotateX(Math.PI / 3);
      const dishMat = new THREE.MeshStandardMaterial({ color: 0x444b58, metalness: 0.3, roughness: 0.4 });
      const dish = new THREE.Mesh(dishGeo, dishMat);
      dishHead.add(dish);

      const sensor = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x59c0ff })
      );
      sensor.position.set(0, 0.8, -0.6);
      dishHead.add(sensor);

      dGroup.add(dishHead);
      this.dishesGroup.add(dGroup);
      this.dishes.push(dishHead);
    }
  }

  async _loadDishGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.dish);
      const proto = gltf.scene;
      proto.scale.setScalar(1.2);

      while (this.dishesGroup.children.length > 0) {
        this.dishesGroup.remove(this.dishesGroup.children[0]);
      }
      this.dishes = [];

      const positions = [
        { x: -36, y: 0.2, z: -24, rot: 0.3 },
        { x: 36,  y: 0.2, z: -24, rot: -0.3 },
        { x: 0,   y: 0.2, z: -40, rot: 0 },
      ];

      for (const p of positions) {
        const clone = proto.clone(true);
        clone.position.set(p.x, p.y, p.z);
        clone.rotation.y = p.rot;
        this.dishesGroup.add(clone);
        this.dishes.push(clone);
      }
    } catch (e) {
      console.warn('[space-env] ใช้ Tracking Dish procedural แทน:', e.message);
    }
  }

  // ══ Animation Loop ══════════════════════════════════════════
  update(dt, elapsedSec, phase, qteProgressRate = 0) {
    if (this.moonMesh) {
      this.moonMesh.rotation.y += dt * 0.04;
    }

    for (let i = 0; i < this.dishes.length; i++) {
      const d = this.dishes[i];
      const speed = 0.25 + i * 0.08;
      d.rotation.y = Math.sin(elapsedSec * speed) * 0.45;
    }

    if (this.rocket) {
      const t = Math.max(0, elapsedSec);

      if (phase === 'countdown' || t <= 0) {
        this.rocket.position.set(70, 4, -260);
        this.rocket.rotation.set(0, 0, 0);
        if (this.rocketFlame) this.rocketFlame.scale.set(0.6, 0.6, 0.6);
        this.rocketAltKm = 24.0;
      } else if (phase === 'normal' || (t > 0 && t <= 40)) {
        const u = Math.min(1.0, t / 40.0);
        const y = 4 + u * 150;
        const x = 70 - u * 35;
        const z = -260 - u * 60;
        this.rocket.position.set(x, y, z);
        this.rocket.rotation.z = -u * 0.25;
        this.rocketAltKm = 24.0 + u * 61.0;

        if (this.rocketFlame) {
          const s = 1.0 + Math.sin(t * 30) * 0.15;
          this.rocketFlame.scale.set(s, s * 1.3, s);
        }
      } else if (phase === 'storm' || (t > 40 && t <= 60)) {
        const u = Math.min(1.0, (t - 40) / 20.0);
        const y = 154 + u * 160;
        const x = 35 - u * 60;
        const z = -320 - u * 60;
        this.rocket.position.set(x, y, z);
        this.rocket.rotation.z = -0.25 - u * 0.22;
        this.rocketAltKm = 85.0 + u * 55.0;

        if (this.rocketFlame) {
          const s = 1.4 + Math.sin(t * 40) * 0.25;
          this.rocketFlame.scale.set(s, s * 1.6, s);
        }
      } else if (phase === 'qte') {
        const moonPos = new THREE.Vector3(-140, 250, -420);
        const startPos = new THREE.Vector3(-25, 314, -380);
        const u = Math.min(1.0, qteProgressRate);

        this.rocket.position.lerpVectors(startPos, moonPos, u * 0.85);
        this.rocket.lookAt(moonPos);
        this.rocketAltKm = 140.0 + u * 384260.0;

        if (this.rocketFlame) {
          const s = 2.2 + Math.sin(t * 60) * 0.4;
          this.rocketFlame.scale.set(s, s * 2.2, s);
        }

        if (this.probe && u > 0.3) {
          this.probe.visible = true;
          this.probe.rotation.y += dt * 0.8;
        }
      } else if (phase === 'ended') {
        if (this.probe) {
          this.probe.visible = true;
          this.probe.rotation.y += dt * 0.5;
          this.probe.position.x = -140 + Math.cos(elapsedSec * 0.6) * 35;
          this.probe.position.z = -420 + Math.sin(elapsedSec * 0.6) * 35;
        }
        if (this.rocketFlame) this.rocketFlame.scale.set(0, 0, 0);
        this.rocketAltKm = 384400.0;
      }
    }
  }
}
