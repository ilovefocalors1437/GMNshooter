// space-env.js — Thailand CE-7 Moonshot True 3D Flight & Atmosphere Simulation Engine
//
// 1. Distant Moon ((-280, 520, -1100) — Flight Duration to Moon South Pole)
// 2. 18 Scattered 3D Waypoint Rings (Non-linear, challenging 3D spatial layout)
// 3. Atmospheric Cloud Layers (Dense clouds at 0-40km -> Clear deep space at >80km)
// 4. Full 3D Flight Physics (Pitch, Yaw, Roll, Afterburners Thruster Boost 5s/7s CD)
// 5. 3 Distinct Endings Animations:
//    - 💥 Ship Explosion (Debris burst & fiery shockwave on HP <= 0)
//    - 🚀 Lunar South Pole Orbit (Smooth orbital insertion with CE-7 MATCH)
//    - ⚠️ Timeout / Incomplete Flight

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
    this.cloudsGroup = new THREE.Group();
    this.explosionGroup = new THREE.Group();

    this.scene.add(this.moonGroup);
    this.scene.add(this.rocketGroup);
    this.scene.add(this.probeGroup);
    this.scene.add(this.dishesGroup);
    this.scene.add(this.navRingsGroup);
    this.scene.add(this.cloudsGroup);
    this.scene.add(this.explosionGroup);

    // ── จุดหมายปลายทาง: ดวงจันทร์ระยะไกล ──
    this.moonTargetPos = new THREE.Vector3(-280, 520, -1100);
    this.rocketAltKm = 24.0;
    this.distToMoonKm = 384400.0;
    this.flightSpeedKmS = 11.2;
    this.isBoosting = false;

    // ── 3D Flight Dynamics & Physics ──
    this.startPos = new THREE.Vector3(70, 15, -260);
    this.flightPos = this.startPos.clone();
    this.flightQuat = new THREE.Quaternion();
    this.flightEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    // อัตราการหมุน
    this.pitchRate = 0;
    this.yawRate = 0;
    this.rollAngle = 0;

    this.pitchAngle = 0.42; // เชิดหัวขึ้นฟ้า
    this.yawAngle = -2.62;  // มุ่งหน้าไปทางทิศดวงจันทร์

    // วงแหวนนำร่อง (18 Scattered Waypoint Rings)
    this.navRings = [];
    this.passedRings = new Set();
    this.dishes = [];

    // สถานะฉากจบ
    this.isDestroyed = false;
    this.hasReachedMoon = false;
    this.orbitAngle = 0;

    // กล้อง Chase Cam 3D
    this.camPos = new THREE.Vector3(70, 22, -230);
    this.camLookTarget = new THREE.Vector3(70, 15, -260);
    this.baseFov = CFG.camera.fov;

    this._init();
  }

  async _init() {
    this._buildMoon();
    this._buildAtmosphericClouds();
    this._buildRocketFallback();
    this._buildDishes();
    this._buildScatteredNavRings();

    this._loadMoonGLB();
    this._loadRocketGLB();
    this._loadProbeGLB();
    this._loadDishGLB();
  }

  // ══ 1. ดวงจันทร์ 3D ═════════════════════════════════════════
  _buildMoon() {
    const geo = new THREE.SphereGeometry(38, 36, 36);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe6f0ff,
      emissive: 0x6a8ecc,
      emissiveIntensity: 0.48,
      roughness: 0.85,
    });
    this.moonMesh = new THREE.Mesh(geo, mat);
    this.moonMesh.position.copy(this.moonTargetPos);
    this.moonGroup.add(this.moonMesh);
  }

  async _loadMoonGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.moon);
      const m = gltf.scene;
      m.scale.setScalar(42);
      m.position.copy(this.moonTargetPos);
      this.moonGroup.remove(this.moonMesh);
      this.moonMesh = m;
      this.moonGroup.add(this.moonMesh);
    } catch (e) {
      console.warn('[space-env] ใช้ Moon procedural แทน:', e.message);
    }
  }

  // ══ 2. ชั้นบรรยากาศ & ก้อนเมฆตามความสูง (0-40km) ════════════
  _buildAtmosphericClouds() {
    const cloudGeo = new THREE.DodecahedronGeometry(8, 1);
    const cloudMat = new THREE.MeshBasicMaterial({
      color: 0x9bc2e6,
      transparent: true,
      opacity: 0.45,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });

    this.cloudParticles = [];
    const count = 35;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(cloudGeo, cloudMat.clone());
      const x = (Math.random() - 0.5) * 350;
      const y = 8 + Math.random() * 55;
      const z = -100 - Math.random() * 400;
      mesh.position.set(x, y, z);
      mesh.scale.set(
        1.5 + Math.random() * 2.5,
        0.8 + Math.random() * 1.2,
        1.5 + Math.random() * 2.5
      );
      this.cloudsGroup.add(mesh);
      this.cloudParticles.push(mesh);
    }
  }

  // ══ 3. จรวด Long March 5 Y14 ════════════════════════════════
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

    this.rocketVisual.rotation.x = Math.PI / 2;
    this.rocket.position.copy(this.flightPos);
    this.rocketGroup.add(this.rocket);
  }

  async _loadRocketGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.rocket);
      const m = gltf.scene;
      m.scale.setScalar(1.6);

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

  // ══ 4. ยานสำรวจดวงจันทร์ CE-7 MATCH ════════════════════════
  async _loadProbeGLB() {
    try {
      const gltf = await this.loader.loadAsync(CFG.assets.probe);
      this.probe = gltf.scene;
      this.probe.scale.setScalar(3.2);
      this.probe.position.copy(this.moonTargetPos).add(new THREE.Vector3(0, 15, 0));
      this.probeGroup.add(this.probe);
      this.probe.visible = false;
    } catch (e) {
      console.warn('[space-env] โหลด CE-7 Probe ไม่สำเร็จ:', e.message);
    }
  }

  // ══ 5. จานเรดาร์ภาคพื้นดิน ═════════════════════════════════
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
    } catch (e) {}
  }

  // ══ 6. 18 Scattered Waypoint Rings กระจัดกระจายใน 3 มิติ ══════
  _buildScatteredNavRings() {
    const ringCount = 18;
    const ringGeo = new THREE.TorusGeometry(14.0, 0.7, 8, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x59c0ff,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
    });

    const start = this.startPos.clone().add(new THREE.Vector3(-10, 25, -30));
    const end = this.moonTargetPos.clone().add(new THREE.Vector3(10, -20, 40));

    const offsets = [
      { x: -18, y: 12 }, { x: 22, y: -8 }, { x: -28, y: 18 }, { x: 30, y: 10 },
      { x: -14, y: -15 }, { x: 35, y: 22 }, { x: -32, y: -8 }, { x: 18, y: 28 },
      { x: -22, y: 14 }, { x: 26, y: -18 }, { x: -36, y: 20 }, { x: 24, y: 12 },
      { x: -16, y: -10 }, { x: 30, y: 24 }, { x: -25, y: 15 }, { x: 20, y: -12 },
      { x: -10, y: 18 }, { x: 12, y: -8 }
    ];

    for (let i = 0; i < ringCount; i++) {
      const u = (i + 1) / (ringCount + 1);
      const pos = new THREE.Vector3().lerpVectors(start, end, u);
      const off = offsets[i % offsets.length];
      pos.x += off.x;
      pos.y += off.y;

      const ringMesh = new THREE.Mesh(ringGeo, ringMat.clone());
      ringMesh.position.copy(pos);
      ringMesh.lookAt(end);

      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(2.4),
        new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true })
      );
      marker.position.y = 15.0;
      ringMesh.add(marker);

      this.navRingsGroup.add(ringMesh);
      this.navRings.push({
        id: i + 1,
        mesh: ringMesh,
        marker: marker,
        pos: pos,
        radius: 16.0,
        active: true,
      });
    }
  }

  resetNavRings() {
    this.passedRings.clear();
    this.isDestroyed = false;
    this.hasReachedMoon = false;
    this.isBoosting = false;
    this.flightPos.copy(this.startPos);
    this.pitchAngle = 0.42;
    this.yawAngle = -2.62;
    this.rollAngle = 0;
    this.orbitAngle = 0;

    if (this.rocket) {
      this.rocket.visible = true;
    }
    while (this.explosionGroup.children.length > 0) {
      this.explosionGroup.remove(this.explosionGroup.children[0]);
    }

    for (const r of this.navRings) {
      r.active = true;
      r.mesh.visible = true;
      r.mesh.material.color.setHex(0x59c0ff);
      r.mesh.material.opacity = 0.88;
      r.mesh.scale.set(1, 1, 1);
    }
  }

  checkNavRingPassed(onPassed) {
    if (!this.rocket || this.isDestroyed) return;
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

  getNextActiveRing() {
    for (const r of this.navRings) {
      if (r.active && !this.passedRings.has(r.id)) {
        return r;
      }
    }
    return null;
  }

  // ══ 7. การควบคุมการบิน 3D (Pitch, Yaw, Boost) ═══════════════
  setSteerInput(pitchIn, yawIn, boost = false) {
    this.pitchRate = clamp(pitchIn, -1, 1);
    this.yawRate = clamp(yawIn, -1, 1);
    this.isBoosting = !!boost;
  }

  // ══ 8. ระเบิดยานกลางอากาศ (Cutscene 6.1) ════════════════════
  triggerShipExplosion() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (this.rocket) this.rocket.visible = false;

    const pCount = 45;
    const pGeo = new THREE.DodecahedronGeometry(1.8);
    for (let i = 0; i < pCount; i++) {
      const pMat = new THREE.MeshBasicMaterial({
        color: Math.random() > 0.4 ? 0xff4d6d : 0xffb37a,
        transparent: true,
        opacity: 1.0,
      });
      const m = new THREE.Mesh(pGeo, pMat);
      m.position.copy(this.flightPos);
      m.userData = {
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 45,
          (Math.random() - 0.5) * 45,
          (Math.random() - 0.5) * 45
        ),
        rotVel: (Math.random() - 0.5) * 6,
      };
      this.explosionGroup.add(m);
    }
  }

  // ══ 9. Simulation Update Loop ═══════════════════════════════
  update(dt, elapsedSec, phase, qteProgressRate = 0, isPilot = false) {
    if (this.moonMesh) {
      this.moonMesh.rotation.y += dt * 0.03;
    }

    for (let i = 0; i < this.dishes.length; i++) {
      const d = this.dishes[i];
      d.rotation.y = Math.sin(elapsedSec * (0.2 + i * 0.08)) * 0.45;
    }

    for (const r of this.navRings) {
      if (r.active) {
        r.mesh.rotation.z += dt * 0.7;
        if (r.marker) r.marker.rotation.y += dt * 1.6;
      } else {
        r.mesh.scale.multiplyScalar(1 - dt * 2.2);
        r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - dt * 2.5);
        if (r.mesh.material.opacity <= 0.05) r.mesh.visible = false;
      }
    }

    if (this.isDestroyed) {
      for (const p of this.explosionGroup.children) {
        p.position.addScaledVector(p.userData.vel, dt);
        p.rotation.x += p.userData.rotVel * dt;
        p.material.opacity = Math.max(0, p.material.opacity - dt * 0.7);
      }
      return;
    }

    const curY = this.flightPos.y;
    const cloudOpacity = clamp(1.0 - (curY - 15) / 60, 0.0, 0.45);
    for (const c of this.cloudParticles) {
      c.material.opacity = cloudOpacity;
      c.visible = cloudOpacity > 0.02;
    }

    if (this.rocket) {
      const t = Math.max(0, elapsedSec);

      if (this.hasReachedMoon) {
        this.orbitAngle += dt * 0.65;
        const orbitR = 48.0;
        const ox = this.moonTargetPos.x + Math.cos(this.orbitAngle) * orbitR;
        const oz = this.moonTargetPos.z + Math.sin(this.orbitAngle) * orbitR;
        const oy = this.moonTargetPos.y + Math.sin(this.orbitAngle * 2) * 8.0 - 6.0;

        this.flightPos.set(ox, oy, oz);
        this.rocket.position.copy(this.flightPos);
        this.rocket.lookAt(
          this.moonTargetPos.x + Math.cos(this.orbitAngle + 0.1) * orbitR,
          oy,
          this.moonTargetPos.z + Math.sin(this.orbitAngle + 0.1) * orbitR
        );
        this.distToMoonKm = 3800.0;
        if (this.probe) this.probe.visible = true;
        return;
      }

      if (isPilot) {
        // ── 3D FLIGHT SIMULATOR CONTROLS (สำหรับคนขับยาน) ──
        const turnSpeed = 1.25;
        this.yawAngle -= this.yawRate * turnSpeed * dt;
        this.pitchAngle += this.pitchRate * (turnSpeed * 0.85) * dt;
        this.pitchAngle = clamp(this.pitchAngle, -0.40, 1.35);

        const targetRoll = -this.yawRate * 0.55;
        this.rollAngle = THREE.MathUtils.damp(this.rollAngle, targetRoll, 5.0, dt);

        this.flightEuler.set(this.pitchAngle, this.yawAngle, this.rollAngle, 'YXZ');
        this.rocket.quaternion.setFromEuler(this.flightEuler);

        // เคลื่อนที่ไปข้างหน้า (Normal vs Boost Speed)
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rocket.quaternion);
        const baseSpeed = 17.8;
        const flightSpeed = this.isBoosting ? baseSpeed * 1.9 : baseSpeed;
        this.flightSpeedKmS = this.isBoosting ? 21.5 : 11.2;

        this.flightPos.addScaledVector(forward, flightSpeed * dt);

        if (this.flightPos.y < 3.0) {
          this.flightPos.y = 3.0;
          if (this.pitchAngle < 0) this.pitchAngle = 0.1;
        }

        this.rocket.position.copy(this.flightPos);
        this.rocketAltKm = Math.max(24.0, 24.0 + (this.flightPos.y - 15.0) * 0.85);

        const distToMoon = this.flightPos.distanceTo(this.moonTargetPos);
        this.distToMoonKm = Math.max(3800.0, (distToMoon / 1100.0) * 384400.0);

        if (distToMoon <= 55.0) {
          this.hasReachedMoon = true;
        }

        if (this.rocketFlame) {
          const boostScale = this.isBoosting ? 2.4 : 1.0;
          const s = (1.0 + Math.sin(t * 35) * 0.18) * boostScale;
          this.rocketFlame.scale.set(s, s * 1.6, s);
        }
        if (this.rocketLight) {
          this.rocketLight.intensity = this.isBoosting ? 8.0 : 4.0;
        }
      } else {
        // ── สำหรับ Ground Crew (มองเห็นยานไต่ระดับสู่อวกาศ) ──
        if (phase === 'countdown' || t <= 0) {
          this.rocket.position.copy(this.startPos);
          this.rocket.rotation.set(0, 0, 0);
          this.rocketAltKm = 24.0;
        } else if (phase === 'normal' || (t > 0 && t <= 40)) {
          const u = Math.min(1.0, t / 40.0);
          this.rocket.position.lerpVectors(this.startPos, new THREE.Vector3(-120, 260, -650), u);
          this.rocket.rotation.z = -u * 0.25;
          this.rocketAltKm = 24.0 + u * 61.0;
        } else if (phase === 'storm' || (t > 40 && t <= 60)) {
          const u = Math.min(1.0, (t - 40) / 20.0);
          this.rocket.position.lerpVectors(new THREE.Vector3(-120, 260, -650), this.moonTargetPos, u * 0.7);
          this.rocket.rotation.z = -0.25 - u * 0.22;
          this.rocketAltKm = 85.0 + u * 55.0;
        } else if (phase === 'qte') {
          const u = Math.min(1.0, qteProgressRate);
          this.rocket.position.lerpVectors(new THREE.Vector3(-200, 420, -900), this.moonTargetPos, u);
          this.rocket.lookAt(this.moonTargetPos);
          this.distToMoonKm = Math.max(3800.0, 384400.0 * (1.0 - u));
        }
      }
    }
  }

  // ══ 10. กล้อง 3D Chase Camera ════════════════════════════════
  updateFlightCamera(camera, dt) {
    if (!this.rocket) return;

    if (this.hasReachedMoon) {
      const camTarget = this.moonTargetPos.clone().add(new THREE.Vector3(0, 35, 110));
      camera.position.lerp(camTarget, dt * 2.5);
      camera.lookAt(this.moonTargetPos);
      return;
    }

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rocket.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rocket.quaternion);

    const distBack = this.isBoosting ? 36.0 : 30.0;
    const distUp = this.isBoosting ? 9.5 : 8.5;

    const targetCamPos = this.rocket.position.clone()
      .sub(forward.clone().multiplyScalar(distBack))
      .add(up.clone().multiplyScalar(distUp));

    this.camPos.lerp(targetCamPos, dt * 7.0);
    camera.position.copy(this.camPos);

    const targetLook = this.rocket.position.clone().add(forward.clone().multiplyScalar(50.0));
    this.camLookTarget.lerp(targetLook, dt * 8.0);
    camera.lookAt(this.camLookTarget);

    const targetFov = this.isBoosting ? this.baseFov + 12 : this.baseFov;
    camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 4, dt);
    camera.updateProjectionMatrix();
  }

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
      reachedMoon: this.hasReachedMoon,
      destroyed: this.isDestroyed,
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
    if (d.reachedMoon) this.hasReachedMoon = true;
    if (d.destroyed) this.triggerShipExplosion();
  }
}
