// space-env.js — Thailand CE-7 Moonshot 3D Space Environment & Rocket Flight Navigation Engine
//
// 1. ดวงจันทร์ 3D (The Moon Sphere) & วงแหวนนำร่องสู่ดวงจันทร์ (Lunar Nav Waypoint Rings)
// 2. ยาน Long March 5 & CE-7 Payload: ระบบควบคุมการบินจริง (Manual Steering, Pitch/Yaw/Roll Bank, Thruster Boost)
// 3. Chase/Cockpit Camera สำหรับผู้ควบคุมยาน (Flight Ops Pilot) & Observatory Camera สำหรับ Ground Crew
// 4. ระบบนำทาง Real-time: คำนวณระยะทางถึงดวงจันทร์ (Distance to Moon KM) และความเร็วการบิน (Flight Velocity KM/S)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CFG, DEG, clamp } from './config.js';

export class SpaceEnvironment {
  constructor(scene) {
    this.scene = scene;
    this.loader = new GLTFLoader();

    // ── กลุ่มวัตถุ ──
    this.moonGroup = new THREE.Group();
    this.rocketGroup = new THREE.Group();
    this.probeGroup = new THREE.Group();
    this.dishesGroup = new THREE.Group();
    this.navRingsGroup = new THREE.Group();

    this.scene.add(this.moonGroup);
    this.scene.add(this.rocketGroup);
    this.scene.add(this.probeGroup);
    this.scene.add(this.dishesGroup);
    this.scene.add(this.navRingsGroup);

    // ── สถานะการบิน & นำร่องสู่ดวงจันทร์ ──
    this.moonTargetPos = new THREE.Vector3(-140, 250, -420);
    this.rocketAltKm = 24.0;
    this.distToMoonKm = 384400.0;
    this.flightSpeedKmS = 11.2;
    this.isBoosting = false;

    // การควบคุมทิศทางยาน (Pilot Steering)
    this.steerX = 0; // เลี้ยวซ้าย/ขวา (-1..1)
    this.steerY = 0; // เชิดหัว/กดหัว (-1..1)
    this.rollBank = 0;
    this.pitchBank = 0;
    this.yawBank = 0;
    this.steerOffset = new THREE.Vector3(0, 0, 0);
    this.baseRocketPos = new THREE.Vector3(70, 4, -260);

    // วงแหวนนำร่อง (Nav Waypoint Rings)
    this.navRings = [];
    this.passedRings = new Set();
    this.dishes = [];

    // กล้อง Chase Cam ของคนขับยาน
    this.chaseCamPos = new THREE.Vector3(0, 5, 15);
    this.chaseCamTarget = new THREE.Vector3(0, 0, 0);

    this._init();
  }

  async _init() {
    this._buildMoonFallback();
    this._buildRocketFallback();
    this._buildDishes();
    this._buildNavRings();

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
    this.moonMesh.position.copy(this.moonTargetPos);
    this.moonGroup.add(this.moonMesh);
  }

  async _loadMoonGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.moon);
      const m = gltf.scene;
      m.scale.setScalar(24);
      m.position.copy(this.moonTargetPos);
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

    this.rocket.position.copy(this.baseRocketPos);
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
      this.rocket.position.copy(this.baseRocketPos);
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

  // ══ 5. วงแหวนนำร่องสู่ดวงจันทร์ (Lunar Nav Waypoint Rings) ═════
  _buildNavRings() {
    const ringCount = 10;
    const ringGeo = new THREE.TorusGeometry(8.5, 0.4, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x59c0ff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });

    const start = new THREE.Vector3(60, 40, -270);
    const end = this.moonTargetPos.clone().add(new THREE.Vector3(15, -10, 30));

    for (let i = 0; i < ringCount; i++) {
      const u = (i + 1) / (ringCount + 1);
      const pos = new THREE.Vector3().lerpVectors(start, end, u);
      pos.x += Math.sin(u * Math.PI * 2) * 14;
      pos.y += Math.sin(u * Math.PI) * 18;

      const ringMesh = new THREE.Mesh(ringGeo, ringMat.clone());
      ringMesh.position.copy(pos);
      ringMesh.lookAt(end);
      
      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.6),
        new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true })
      );
      marker.position.y = 9.5;
      ringMesh.add(marker);

      this.navRingsGroup.add(ringMesh);
      this.navRings.push({
        id: i + 1,
        mesh: ringMesh,
        marker: marker,
        pos: pos,
        radius: 10.0,
        active: true,
      });
    }
  }

  resetNavRings() {
    this.passedRings.clear();
    for (const r of this.navRings) {
      r.active = true;
      r.mesh.visible = true;
      r.mesh.material.color.setHex(0x59c0ff);
      r.mesh.material.opacity = 0.8;
      r.mesh.scale.set(1, 1, 1);
    }
  }

  checkNavRingPassed(onPassed) {
    if (!this.rocket) return;
    const rPos = this.rocket.position;
    for (const r of this.navRings) {
      if (!r.active || this.passedRings.has(r.id)) continue;
      const d = rPos.distanceTo(r.pos);
      if (d <= r.radius) {
        r.active = false;
        this.passedRings.add(r.id);
        r.mesh.material.color.setHex(0x8fffa8);
        r.mesh.material.opacity = 1.0;
        if (onPassed) onPassed(r);
      }
    }
  }

  // ══ 6. การควบคุมการบิน (Pilot Steering Input) ══════════════
  setSteer(x, y, boost = false) {
    this.steerX = clamp(x, -1, 1);
    this.steerY = clamp(y, -1, 1);
    this.isBoosting = !!boost;
  }

  // ══ 7. Animation Loop & Flight Dynamics ════════════════════
  update(dt, elapsedSec, phase, qteProgressRate = 0, isPilot = false) {
    if (this.moonMesh) {
      this.moonMesh.rotation.y += dt * 0.04;
    }

    // หมุนจานเรดาร์ภาคพื้น
    for (let i = 0; i < this.dishes.length; i++) {
      const d = this.dishes[i];
      const speed = 0.25 + i * 0.08;
      d.rotation.y = Math.sin(elapsedSec * speed) * 0.45;
    }

    // แอนิเมชันวงแหวนนำร่อง
    for (const r of this.navRings) {
      if (r.active) {
        r.mesh.rotation.z += dt * 0.8;
        if (r.marker) r.marker.rotation.y += dt * 1.5;
      } else {
        r.mesh.scale.multiplyScalar(1 - dt * 1.8);
        r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - dt * 2.0);
        if (r.mesh.material.opacity <= 0.05) r.mesh.visible = false;
      }
    }

    if (this.rocket) {
      const t = Math.max(0, elapsedSec);

      // คำนวณ Steering Offsets
      const targetRoll = -this.steerX * 0.55;
      const targetPitch = -this.steerY * 0.45;
      const targetYaw = -this.steerX * 0.35;

      this.rollBank = THREE.MathUtils.damp(this.rollBank, targetRoll, 4, dt);
      this.pitchBank = THREE.MathUtils.damp(this.pitchBank, targetPitch, 4, dt);
      this.yawBank = THREE.MathUtils.damp(this.yawBank, targetYaw, 4, dt);

      // ขยับพิกัดตามการเลี้ยว
      const maxSteerDist = 28.0;
      this.steerOffset.x = THREE.MathUtils.damp(this.steerOffset.x, this.steerX * maxSteerDist, 3, dt);
      this.steerOffset.y = THREE.MathUtils.damp(this.steerOffset.y, this.steerY * maxSteerDist * 0.6, 3, dt);

      // คำนวณความเร็วและระยะทางสู่ดวงจันทร์
      this.flightSpeedKmS = this.isBoosting ? 18.5 : 11.2;
      const totalFlightSec = 80.0;
      const flightProgress = Math.min(1.0, t / totalFlightSec);
      this.distToMoonKm = Math.max(3800.0, 384400.0 * (1.0 - flightProgress * 0.99));

      if (phase === 'countdown' || t <= 0) {
        this.baseRocketPos.set(70, 4, -260);
        this.rocket.position.copy(this.baseRocketPos);
        this.rocket.rotation.set(0, 0, 0);
        if (this.rocketFlame) this.rocketFlame.scale.set(0.6, 0.6, 0.6);
        this.rocketAltKm = 24.0;
      } else if (phase === 'normal' || (t > 0 && t <= 40)) {
        const u = Math.min(1.0, t / 40.0);
        const y = 4 + u * 150;
        const x = 70 - u * 35;
        const z = -260 - u * 60;
        this.baseRocketPos.set(x, y, z);
        
        this.rocket.position.copy(this.baseRocketPos).add(this.steerOffset);
        this.rocket.rotation.set(this.pitchBank, this.yawBank, -u * 0.25 + this.rollBank);
        this.rocketAltKm = 24.0 + u * 61.0;

        if (this.rocketFlame) {
          const boostMult = this.isBoosting ? 1.8 : 1.0;
          const s = (1.0 + Math.sin(t * 30) * 0.15) * boostMult;
          this.rocketFlame.scale.set(s, s * 1.3, s);
        }
      } else if (phase === 'storm' || (t > 40 && t <= 60)) {
        const u = Math.min(1.0, (t - 40) / 20.0);
        const y = 154 + u * 160;
        const x = 35 - u * 60;
        const z = -320 - u * 60;
        this.baseRocketPos.set(x, y, z);

        this.rocket.position.copy(this.baseRocketPos).add(this.steerOffset);
        this.rocket.rotation.set(this.pitchBank, this.yawBank, -0.25 - u * 0.22 + this.rollBank);
        this.rocketAltKm = 85.0 + u * 55.0;

        if (this.rocketFlame) {
          const boostMult = this.isBoosting ? 2.0 : 1.2;
          const s = (1.4 + Math.sin(t * 40) * 0.25) * boostMult;
          this.rocketFlame.scale.set(s, s * 1.6, s);
        }
      } else if (phase === 'qte') {
        const startPos = new THREE.Vector3(-25, 314, -380);
        const u = Math.min(1.0, qteProgressRate);

        this.baseRocketPos.lerpVectors(startPos, this.moonTargetPos, u * 0.85);
        this.rocket.position.copy(this.baseRocketPos).add(this.steerOffset);
        this.rocket.lookAt(this.moonTargetPos);
        this.rocket.rotateZ(this.rollBank);
        this.rocketAltKm = 140.0 + u * 384260.0;
        this.distToMoonKm = Math.max(120.0, 384400.0 * (1.0 - u));

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
        this.distToMoonKm = 0;
      }
    }
  }

  // ══ 8. Chase Camera สำหรับคนขับยาน (Flight Ops View) ════════
  updateFlightCamera(camera, dt) {
    if (!this.rocket) return;
    
    // วางกล้องด้านหลังเยื้องบนของตัวยาน Long March 5
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rocket.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rocket.quaternion);

    const targetPos = this.rocket.position.clone()
      .sub(forward.clone().multiplyScalar(26))
      .add(up.clone().multiplyScalar(7.5));

    this.chaseCamPos.lerp(targetPos, dt * 6.5);
    camera.position.copy(this.chaseCamPos);

    const lookTarget = this.rocket.position.clone().add(forward.clone().multiplyScalar(50));
    this.chaseCamTarget.lerp(lookTarget, dt * 7.0);
    camera.lookAt(this.chaseCamTarget);
  }

  // ══ 9. Sync State ผ่าน Socket ═══════════════════════════════
  getNavState() {
    if (!this.rocket) return null;
    return {
      x: +this.rocket.position.x.toFixed(2),
      y: +this.rocket.position.y.toFixed(2),
      z: +this.rocket.position.z.toFixed(2),
      rotX: +this.rocket.rotation.x.toFixed(3),
      rotY: +this.rocket.rotation.y.toFixed(3),
      rotZ: +this.rocket.rotation.z.toFixed(3),
      distKm: +this.distToMoonKm.toFixed(0),
      speed: +this.flightSpeedKmS.toFixed(1),
      boost: this.isBoosting,
    };
  }

  applyRemoteNavState(d) {
    if (!this.rocket || !d) return;
    this.rocket.position.set(d.x, d.y, d.z);
    this.rocket.rotation.set(d.rotX, d.rotY, d.rotZ);
    if (d.distKm !== undefined) this.distToMoonKm = d.distKm;
    if (d.speed !== undefined) this.flightSpeedKmS = d.speed;
    this.isBoosting = !!d.boost;
  }
}
