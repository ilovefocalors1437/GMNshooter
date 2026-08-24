// space-env.js — Thailand CE-7 Moonshot True 3D Space Flight Simulation Engine
//
// 1. Full 3D Flight Physics (6-DOF Flight Simulator with Pitch, Yaw, Roll, Forward Thrust & Boost)
// 2. Real 3D Orientation (Quaternion based rotation, inertial velocity, dynamic banking)
// 3. Dynamic Lunar Trajectory & Waypoint Rings in 3D Space
// 4. Spring-Arm 3D Chase Camera with Dynamic FOV on Boost
// 5. Multiplayer Realtime Quaternion & Velocity Synchronization

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

    // ── จุดหมายปลายทาง: ดวงจันทร์ ──
    this.moonTargetPos = new THREE.Vector3(-140, 250, -420);
    this.rocketAltKm = 24.0;
    this.distToMoonKm = 384400.0;
    this.flightSpeedKmS = 11.2;
    this.isBoosting = false;

    // ── 3D Flight Dynamics & Physics ──
    this.flightPos = new THREE.Vector3(70, 15, -260);
    this.flightQuat = new THREE.Quaternion();
    this.flightEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.velocity = new THREE.Vector3(0, 0, 0);

    // อัตราการหมุน (Angular Rates)
    this.pitchRate = 0; // เชิด/กด (-1..1)
    this.yawRate = 0;   // หันซ้าย/ขวา (-1..1)
    this.rollAngle = 0; // เอียงปีกตามการเลี้ยว

    this.pitchAngle = 0.35; // เริ่มต้นเชิดหัว 20 องศาขึ้นฟ้า
    this.yawAngle = -2.7;   // หันมุ่งหน้าไปทางทิศดวงจันทร์

    // วงแหวนนำร่อง (Nav Waypoint Rings)
    this.navRings = [];
    this.passedRings = new Set();
    this.dishes = [];

    // กล้อง Chase Cam 3D แบบ Spring-Arm
    this.camPos = new THREE.Vector3(70, 22, -230);
    this.camLookTarget = new THREE.Vector3(70, 15, -260);
    this.baseFov = CFG.camera.fov;

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
    const geo = new THREE.SphereGeometry(22, 32, 32);
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
      m.scale.setScalar(26);
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
    this.rocketVisual = new THREE.Group();
    this.rocket.add(this.rocketVisual);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.2, roughness: 0.5 });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 16, 12), bodyMat);
    core.position.y = 8;
    this.rocketVisual.add(core);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4.5, 12), bodyMat);
    nose.position.y = 18.2;
    this.rocketVisual.add(nose);

    // เปลวไฟไอพ่นด้านท้าย
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
    this.rocketVisual.add(this.rocketFlame);

    this.rocketLight = new THREE.PointLight(0xff7722, 4, 120, 2);
    this.rocketLight.position.y = -2;
    this.rocketVisual.add(this.rocketLight);

    // จัดให้หัวจรวดหันไปข้างหน้า (Forward = -Z)
    this.rocketVisual.rotation.x = Math.PI / 2;

    this.rocket.position.copy(this.flightPos);
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

      while (this.rocketVisual.children.length > 0) {
        this.rocketVisual.remove(this.rocketVisual.children[0]);
      }

      this.rocketVisual.add(m);
      if (flame) this.rocketVisual.add(flame);
      if (light) this.rocketVisual.add(light);
      this.rocketVisual.rotation.x = Math.PI / 2;
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
    const ringGeo = new THREE.TorusGeometry(12.0, 0.6, 8, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x59c0ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });

    const start = new THREE.Vector3(60, 45, -270);
    const end = this.moonTargetPos.clone().add(new THREE.Vector3(15, -10, 30));

    for (let i = 0; i < ringCount; i++) {
      const u = (i + 1) / (ringCount + 1);
      const pos = new THREE.Vector3().lerpVectors(start, end, u);
      pos.x += Math.sin(u * Math.PI * 2) * 20;
      pos.y += Math.sin(u * Math.PI) * 25;

      const ringMesh = new THREE.Mesh(ringGeo, ringMat.clone());
      ringMesh.position.copy(pos);
      ringMesh.lookAt(end);
      
      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(2.0),
        new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true })
      );
      marker.position.y = 13.0;
      ringMesh.add(marker);

      this.navRingsGroup.add(ringMesh);
      this.navRings.push({
        id: i + 1,
        mesh: ringMesh,
        marker: marker,
        pos: pos,
        radius: 14.0,
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
      r.mesh.material.opacity = 0.85;
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

  // ══ 6. การควบคุมการบินแบบ 3D แท้ (Pitch, Yaw, Roll, Boost) ══
  setSteerInput(pitchIn, yawIn, boost = false) {
    // pitchIn: +1 = กดหัวลง / -1 = เชิดหัวขึ้น (หรือกลับกันตามความถนัด)
    // yawIn: -1 = เลี้ยวซ้าย / +1 = เลี้ยวขวา
    this.pitchRate = clamp(pitchIn, -1, 1);
    this.yawRate = clamp(yawIn, -1, 1);
    this.isBoosting = !!boost;
  }

  // ══ 7. Full 3D Flight Physics Simulation Loop ══════════════
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
        r.mesh.scale.multiplyScalar(1 - dt * 2.2);
        r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - dt * 2.5);
        if (r.mesh.material.opacity <= 0.05) r.mesh.visible = false;
      }
    }

    if (this.rocket) {
      const t = Math.max(0, elapsedSec);

      if (isPilot) {
        // ── 3D FLIGHT SIMULATOR CONTROLS (สำหรับคนขับยาน) ──
        // 1. หมุนองศา Pitch และ Yaw ตาม Input
        const turnSpeed = 1.35; // เรเดียนต่อวินาที
        this.yawAngle -= this.yawRate * turnSpeed * dt;
        
        // เชิดหัว/กดหัว (จำกัดไม่ให้ปักหัวลงดินเกิน -30 องศา และไม่เชิดเกิน 80 องศา)
        this.pitchAngle += this.pitchRate * (turnSpeed * 0.9) * dt;
        this.pitchAngle = clamp(this.pitchAngle, -0.45, 1.35);

        // คำนวณการเอียงปีกยาน (Bank Roll) เมื่อเลี้ยว
        const targetRoll = -this.yawRate * 0.55;
        this.rollAngle = THREE.MathUtils.damp(this.rollAngle, targetRoll, 5.0, dt);

        // ประกอบเป็น Quaternion 3D
        this.flightEuler.set(this.pitchAngle, this.yawAngle, this.rollAngle, 'YXZ');
        this.rocket.quaternion.setFromEuler(this.flightEuler);

        // 2. เคลื่อนที่ไปข้างหน้าตามทิศหัวยาน 3D (Forward Vector)
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rocket.quaternion);

        // คำนวณความเร็ว
        const baseSpeed = 22.0; // หน่วยใน Three.js ต่อวินาที
        const currentSpeed = this.isBoosting ? baseSpeed * 2.0 : baseSpeed;
        this.flightSpeedKmS = this.isBoosting ? 18.5 : 11.2;

        // เคลื่อนที่ตำแหน่ง 3D
        this.flightPos.addScaledVector(forward, currentSpeed * dt);

        // กันไม่ให้ดำดินต่ำกว่า Y = 3.0
        if (this.flightPos.y < 3.0) {
          this.flightPos.y = 3.0;
          if (this.pitchAngle < 0) this.pitchAngle = 0.1;
        }

        this.rocket.position.copy(this.flightPos);
        this.rocketAltKm = Math.max(24.0, 24.0 + (this.flightPos.y - 15.0) * 0.85);

        const distToMoon = this.flightPos.distanceTo(this.moonTargetPos);
        this.distToMoonKm = Math.max(3800.0, (distToMoon / 500.0) * 384400.0);

        // ขยายเปลวไฟไอพ่นเมื่อกดเร่งเครื่อง
        if (this.rocketFlame) {
          const boostScale = this.isBoosting ? 2.4 : 1.0;
          const s = (1.0 + Math.sin(t * 35) * 0.18) * boostScale;
          this.rocketFlame.scale.set(s, s * 1.6, s);
        }
        if (this.rocketLight) {
          this.rocketLight.intensity = this.isBoosting ? 8.0 : 4.0;
        }
      } else {
        // ── สำหรับ Ground Crew (มองเห็นยานเคลื่อนที่อัตโนมัติหรือตามที่ซิงก์มา) ──
        if (phase === 'countdown' || t <= 0) {
          this.rocket.position.set(70, 4, -260);
          this.rocket.rotation.set(0, 0, 0);
          this.rocketAltKm = 24.0;
        } else if (phase === 'normal' || (t > 0 && t <= 40)) {
          const u = Math.min(1.0, t / 40.0);
          const y = 4 + u * 150;
          const x = 70 - u * 35;
          const z = -260 - u * 60;
          this.rocket.position.set(x, y, z);
          this.rocket.rotation.z = -u * 0.25;
          this.rocketAltKm = 24.0 + u * 61.0;
        } else if (phase === 'storm' || (t > 40 && t <= 60)) {
          const u = Math.min(1.0, (t - 40) / 20.0);
          const y = 154 + u * 160;
          const x = 35 - u * 60;
          const z = -320 - u * 60;
          this.rocket.position.set(x, y, z);
          this.rocket.rotation.z = -0.25 - u * 0.22;
          this.rocketAltKm = 85.0 + u * 55.0;
        } else if (phase === 'qte') {
          const startPos = new THREE.Vector3(-25, 314, -380);
          const u = Math.min(1.0, qteProgressRate);
          this.rocket.position.lerpVectors(startPos, this.moonTargetPos, u * 0.85);
          this.rocket.lookAt(this.moonTargetPos);
          this.rocketAltKm = 140.0 + u * 384260.0;
          this.distToMoonKm = Math.max(120.0, 384400.0 * (1.0 - u));
        }
      }
    }
  }

  // ══ 8. Spring-Arm 3D Chase Camera สำหรับคนขับยาน ═════════════
  updateFlightCamera(camera, dt) {
    if (!this.rocket) return;

    // คำนวณทิศ Forward และ Up จาก Quaternion จริงของตัวยาน
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rocket.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rocket.quaternion);

    // ตำแหน่งกล้องอยู่ด้านหลังและเยื้องบนของยาน
    const targetCamPos = this.rocket.position.clone()
      .sub(forward.clone().multiplyScalar(28.0))
      .add(up.clone().multiplyScalar(8.0));

    // เลื่อนกล้องตามด้วย Smooth Spring Dampening
    this.camPos.lerp(targetCamPos, dt * 7.5);
    camera.position.copy(this.camPos);

    // จุดมองอยู่ด้านหน้าของยาน
    const targetLook = this.rocket.position.clone().add(forward.clone().multiplyScalar(45.0));
    this.camLookTarget.lerp(targetLook, dt * 8.5);
    camera.lookAt(this.camLookTarget);

    // ปรับ Dynamic FOV เมื่อเร่งเครื่อง (Speed Warp Effect)
    const targetFov = this.isBoosting ? this.baseFov + 12 : this.baseFov;
    camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 4, dt);
    camera.updateProjectionMatrix();
  }

  // ══ 9. Sync State ผ่าน Socket ═══════════════════════════════
  getNavState() {
    if (!this.rocket) return null;
    return {
      x: +this.rocket.position.x.toFixed(2),
      y: +this.rocket.position.y.toFixed(2),
      z: +this.rocket.position.z.toFixed(2),
      qx: +this.rocket.quaternion.x.toFixed(3),
      qy: +this.rocket.quaternion.y.toFixed(3),
      qz: +this.rocket.quaternion.z.toFixed(3),
      qw: +this.rocket.quaternion.w.toFixed(3),
      distKm: +this.distToMoonKm.toFixed(0),
      speed: +this.flightSpeedKmS.toFixed(1),
      boost: this.isBoosting,
    };
  }

  applyRemoteNavState(d) {
    if (!this.rocket || !d) return;
    this.rocket.position.set(d.x, d.y, d.z);
    if (d.qx !== undefined) {
      this.rocket.quaternion.set(d.qx, d.qy, d.qz, d.qw);
    }
    if (d.distKm !== undefined) this.distToMoonKm = d.distKm;
    if (d.speed !== undefined) this.flightSpeedKmS = d.speed;
    this.isBoosting = !!d.boost;
    if (this.rocketFlame) {
      const boostScale = this.isBoosting ? 2.4 : 1.0;
      this.rocketFlame.scale.set(boostScale, boostScale * 1.6, boostScale);
    }
  }
}
