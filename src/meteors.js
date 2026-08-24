// meteors.js — spawn + path + pool
//
// *** กฎข้อสำคัญที่สุดของไฟล์นี้ ***
// เส้นทางเป็น "ฟังก์ชันของเวลา" ล้วนๆ — ห้ามเก็บ position แล้ว += ทุก frame
//
//     getPosition(meteor, now) → Vector3
//
// เขียนแบบนี้ตั้งแต่แรกเพราะ Phase B server จะส่งแค่ spawn event (ตัวเลขใน m.wire)
// แล้ว client ทุกเครื่องคำนวณตำแหน่งเองได้ตรงกันเป๊ะ ไม่ต้อง sync ตำแหน่งทุก frame
// และเพราะยิงต้อง "นำเป้า" — ต้องรู้ว่าอีก 150ms ดวงนี้จะอยู่ตรงไหน ก่อนกระสุนจะไปถึง
//
// เส้นทาง = บอลลิสติก  p(t) = start + vel·t + ½·g·t²   (g มีแต่แกน Y)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CFG, DEG, clamp } from './config.js';
import { makeGlowTexture } from './juice.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

const rand = (a, b) => a + Math.random() * (b - a);

// จุดบนพื้นที่มุม yaw ระยะ d — ใช้ระบบเดียวกับ camera-control (yaw 0 = -Z)
function atYaw(yaw, dist, y, out = new THREE.Vector3()) {
  return out.set(-Math.sin(yaw) * dist, y, -Math.cos(yaw) * dist);
}

// ────────────────────────────────────────────────────────────
// ตำแหน่ง ณ เวลา now (ms) — pure function
// ────────────────────────────────────────────────────────────
export function getPosition(m, now, out = new THREE.Vector3()) {
  const t = (now - m.t0) * 0.001;
  return out.set(
    m.start.x + m.vel.x * t,
    m.start.y + m.vel.y * t + 0.5 * m.g * t * t,
    m.start.z + m.vel.z * t,
  );
}

/** ความเร็ว ณ เวลา now — ใช้หันหางกับคำนวณ lead */
export function getVelocity(m, now, out = new THREE.Vector3()) {
  const t = (now - m.t0) * 0.001;
  return out.set(m.vel.x, m.vel.y + m.g * t, m.vel.z);
}

// ────────────────────────────────────────────────────────────
// spawn params → เส้นทาง (deterministic ทั้งหมด)
// wire = สิ่งที่ Phase B จะส่งข้ามเน็ต ไม่มีอะไรนอกจากนี้
// ────────────────────────────────────────────────────────────
export function materialize(m, wire) {
  Object.assign(m, wire);
  const M = CFG.meteor;

  // Phase A ส่ง alt0 (ความสูงเป็นเมตร) ส่วน server Phase B ส่ง pitch0 (มุมเงย)
  // รับได้ทั้งคู่ เพราะสองโหมดต้องใช้ meteors.js ตัวเดียวกัน
  const alt0 = (wire.alt0 !== undefined && wire.alt0 !== null)
    ? wire.alt0
    : wire.dist0 * Math.tan(wire.pitch0 || 0);
  m.alt0 = alt0;

  m.start = atYaw(wire.yaw0, wire.dist0, alt0, m.start || new THREE.Vector3());

  // *** ปลายทางคือ "จุดดับกลางอากาศ" ไม่ใช่พื้น ***
  // ht_end จริงจาก GMN (กม.) → ความสูงในเกม
  const B = M.burnout;
  const htKm = (wire.gmn && wire.gmn.htEnd != null) ? wire.gmn.htEnd : B.defaultKm;
  const ht01 = clamp((htKm - B.htMinKm) / (B.htMaxKm - B.htMinKm), 0, 1);
  m.burnY = B.yMin + (B.yMax - B.yMin) * ht01;
  m.htEndKm = htKm;

  const end = atYaw(wire.yawImpact, wire.distImpact, m.burnY, _p);

  m.g = M.gravity;
  const T = wire.flightSec;
  m.vel = (m.vel || new THREE.Vector3()).set(
    (end.x - m.start.x) / T,
    (end.y - m.start.y) / T - 0.5 * m.g * T,
    (end.z - m.start.z) / T,
  );

  m.tBurn = wire.t0 + T * 1000;      // เวลาที่ไหม้หมด
  m.tFadeEnd = m.tBurn + B.fadeMs;
  m.burning = false;
  m.fadeK = 1;
  m.tHittable = wire.t0 + M.telegraphMs;
  m.radius = wire.size;
  m.speed = m.vel.length();

  // แกนหมุน: ฝั่ง GMN/server ส่งมาเป็น array (ส่งข้าม JSON ได้) ฝั่ง local เป็น Vector3 อยู่แล้ว
  if (!m.spinAxis || !m.spinAxis.isVector3) {
    const s = wire.spin || [0.3, 0.8, 0.5, 1.0];
    m.spinAxis = new THREE.Vector3(s[0] || 0.3, s[1] || 0.8, s[2] || 0.5).normalize();
    m.spinRate = s[3] !== undefined ? s[3] : 1.0;
  }
  return m;
}

// ────────────────────────────────────────────────────────────
export class MeteorField {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;      // ใช้หัน billboard ของลูกเรืองแสง (Phase B ใช้ faceCamera แทน)
    this.pool = [];
    this.active = [];
    this._nextId = 1;

    // Phase B: server เป็นคนสั่งเกิด ห้ามสุ่มเอง ไม่งั้นแต่ละจอเห็นฟ้าคนละผืน
    this.networked = false;

    // spawner (โหมดคนเดียวเท่านั้น)
    this.kills = 0;
    this.nextSpawnAt = 0;
    this.started = false;

    const N = CFG.meteor.poolSize;
    for (let i = 0; i < N; i++) {
      this.pool.push({
        id: 0, alive: false, slot: i,
        position: new THREE.Vector3(),
        start: null, vel: null,
        hittable: false, telegraph: true,
      });
    }
    this._buildMeshes(N);
  }

  // ── รูปทรง: หิน + ลูกเรืองแสง + หาง — 3 draw call ไม่ว่ากี่ดวง ──
  _buildMeshes(N) {
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);   // fallback ก่อนโหลด glb เสร็จ
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x6b5a4e, roughness: 1, metalness: 0,
      emissive: 0xff5a1e, emissiveIntensity: 0.35, flatShading: true,
    });
    this.rock = new THREE.InstancedMesh(rockGeo, rockMat, N);
    this.rock.frustumCulled = false;
    this.rock.count = 0;

    // ลูกเรืองแสง — หนา additive ไม่ใช่เส้นบางเหมือนของจริง (spec §5)
    //
    // ต้องเป็น billboard + texture ที่ไล่จางจากกลางออกขอบ
    // เคยใช้ SphereGeometry ทึบ ผลคือได้ "แผ่นกลมสีส้ม" ขอบคม ไม่ใช่แสงเรือง
    // (หันหน้าเข้ากล้องใน _writeInstances โดยก๊อป quaternion ของกล้องมาตรงๆ)
    const glowMat = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(), color: 0xffffff, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 1,
    });
    this.glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, N);
    this.glow.frustumCulled = false;
    this.glow.count = 0;
    this.glow.renderOrder = 3;

    // หาง = กรวย ฐานอยู่ที่หัว ปลายแหลมชี้ไปทางที่มันมา
    const coneGeo = new THREE.ConeGeometry(1, 1, 7, 1, true);
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.5, side: THREE.DoubleSide,
    });
    this.trail = new THREE.InstancedMesh(coneGeo, trailMat, N);
    this.trail.frustumCulled = false;
    this.trail.count = 0;
    this.trail.renderOrder = 2;

    for (let i = 0; i < N; i++) {
      this.glow.setColorAt(i, _col.set(0xffffff));
      this.trail.setColorAt(i, _col.set(0xffffff));
    }

    this.group = new THREE.Group();
    this.group.add(this.rock, this.trail, this.glow);
    this.scene.add(this.group);
  }

  /** โหลด asset จริงมาแทน icosahedron — ถ้าพังก็เล่นต่อได้ด้วย fallback */
  async load() {
    try {
      const gltf = await new GLTFLoader().loadAsync(CFG.assets.meteor);
      let geo = null;
      gltf.scene.traverse(o => { if (!geo && o.isMesh && o.geometry) geo = o.geometry; });
      if (!geo) return false;

      geo = geo.clone();
      geo.computeBoundingSphere();
      const r = geo.boundingSphere.radius || 1;
      const c = geo.boundingSphere.center;
      geo.translate(-c.x, -c.y, -c.z);
      geo.scale(1 / r, 1 / r, 1 / r);          // normalize เป็นรัศมี 1 → CFG.meteor.size คุมขนาดจริง
      geo.computeVertexNormals();

      this.rock.geometry.dispose();
      this.rock.geometry = geo;
      return true;
    } catch (e) {
      console.warn('[meteors] โหลด glb ไม่ได้ ใช้ fallback:', e.message);
      return false;
    }
  }

  // ── spawner ────────────────────────────────────────────────
  reset(now) {
    for (const m of this.active) m.alive = false;
    this.active.length = 0;
    this.kills = 0;
    this.nextSpawnAt = now + CFG.spawn.firstDelayMs;
    this.started = true;
  }

  /** ช่วงห่างการเกิด — ยิ่งยิงได้เยอะ ยิ่งถี่ */
  get intervalMs() {
    const S = CFG.spawn;
    return Math.max(S.intervalMinMs, S.intervalStartMs - this.kills * S.intervalDecayPerKill);
  }

  /** 0 = เพิ่งเริ่ม, 1 = ยากสุด */
  get difficulty() {
    return clamp(this.kills / 30, 0, 1);
  }

  _rollWire(now) {
    const M = CFG.meteor;
    const lim = (CFG.camera.yawLimitDeg - M.yawMarginDeg) * DEG;
    const yaw0 = rand(-lim, lim);
    const drift = rand(-M.yawDriftDeg, M.yawDriftDeg) * DEG;

    return {
      id: this._nextId++,
      t0: now,
      yaw0,
      dist0: M.spawnDist * rand(0.9, 1.1),
      alt0: rand(M.spawnAltMin, M.spawnAltMax),
      yawImpact: clamp(yaw0 + drift, -lim, lim),
      distImpact: rand(M.impactDistMin, M.impactDistMax),
      // ต้องเหลือเวลาให้ยิงหลังจบ telegraph อย่างน้อย 1.5 วิเสมอ ไม่งั้นโดนโกง
      flightSec: Math.max(
        M.telegraphMs * 0.001 + 1.5,
        rand(M.flightSecMax, M.flightSecMin) - this.difficulty * (M.flightSecMax - M.flightSecMin) * 0.5,
      ),
      size: rand(M.sizeMin, M.sizeMax),
      spinAxis: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(),
      spinRate: rand(-1, 1) * M.spinSpeed,
    };
  }

  spawn(now, wire = null) {
    if (this.active.length >= CFG.meteor.maxAlive) return null;
    const m = this.pool.find(p => !p.alive);
    if (!m) return null;

    if (!wire) {
      if (CFG.gmn.enabled) {
        // *** ห้ามสุ่มขึ้นมาเองเด็ดขาด ***
        // ถ้าคิวว่าง = ไม่เกิดดวงนี้ แล้วไปวนดึง GMN ใหม่ (ดู update())
        // เว้นช่วงเงียบไปบ้างยอมได้ แต่ห้ามมีอุกกาบาตปลอมปนเข้ามาแม้แต่ดวงเดียว
        // ไม่งั้น contact log จะโกหก และทั้งเกมเสียความน่าเชื่อถือ
        const ev = this.feed ? this.feed.take() : null;
        if (!ev) return null;
        wire = this.feed.toWire(ev, now, this._nextId++, Math.random);
      } else {
        wire = this._rollWire(now);      // โหมด offline dev เท่านั้น (gmn.enabled = false)
      }
    }
    materialize(m, wire);
    m.gmn = wire.gmn || null;
    m.alive = true;
    m.telegraph = true;
    m.hittable = false;
    m.announced = false;      // main จะเล่นเสียงหวีด telegraph ให้ครั้งเดียว
    getPosition(m, now, m.position);
    this.active.push(m);
    return m;
  }

  kill(m) {
    m.alive = false;
    const i = this.active.indexOf(m);
    if (i >= 0) this.active.splice(i, 1);
    this.kills++;
  }

  /**
   * เดินเวลา — ไม่มี integration ทั้งหมดคำนวณจาก now
   * @returns {Array} รายการดวงที่เพิ่งไหม้หมดกลางอากาศ (main เอาไปตัดคอมโบ)
   */
  /** Phase B: เกิดตามคำสั่ง server — id มาจาก server ห้ามสร้างเอง */
  spawnFromWire(wire) {
    const m = this.pool.find(p => !p.alive);
    if (!m) return null;
    materialize(m, wire);
    m.alive = true;
    m.telegraph = true;
    m.hittable = false;
    m.announced = false;
    m.dmgScale = 1;
    m.hp = wire.hp || 1;
    m.storm = !!wire.storm;
    if (!m.spinAxis || !m.spinAxis.isVector3) {
      const s = wire.spin || [0.3, 0.8, 0.5, 1.0];
      m.spinAxis = new THREE.Vector3(s[0], s[1], s[2]).normalize();
      m.spinRate = s[3];
    }
    getPosition(m, wire.t0, m.position);
    this.active.push(m);
    return m;
  }

  byId(id) {
    for (const m of this.active) if (m.id === id) return m;
    return null;
  }

  update(now, out = []) {
    out.length = 0;

    if (this.started && !this.networked && now >= this.nextSpawnAt) {
      const m = this.spawn(now);
      if (m) {
        this.dryMs = 0;
        if (this.kills >= CFG.spawn.doubleChanceAt && Math.random() < 0.28) this.spawn(now + 120);
        this.nextSpawnAt = now + this.intervalMs;
      } else {
        // ยังไม่มีข้อมูลจริงในคิว — รอแล้วลองใหม่ ไม่ใช่แต่งดวงปลอมมาแทน
        this.dryMs = (this.dryMs || 0) + CFG.gmn.retryMs;
        this.nextSpawnAt = now + CFG.gmn.retryMs;
        if (this.feed) this.feed.poke(this.dryMs);
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const m = this.active[i];

      // หยุดเดินทางตอนไหม้หมด — ค้างจุดนั้นแล้วจางหาย ไม่ร่วงต่อลงพื้น
      getPosition(m, Math.min(now, m.tBurn), m.position);
      m.telegraph = now < m.tHittable;
      m.hittable = !m.telegraph && now < m.tBurn;

      if (now >= m.tBurn) {
        if (!m.burning) { m.burning = true; out.push(m); }   // burnedOut ครั้งเดียว
        m.fadeK = clamp(1 - (now - m.tBurn) / CFG.meteor.burnout.fadeMs, 0, 1);
        if (now >= m.tFadeEnd) { m.alive = false; this.active.splice(i, 1); }
      }
    }

    this._writeInstances(now);
    return out;
  }

  // ── เขียน matrix ลง InstancedMesh (compact ทุก frame) ──────
  _writeInstances(now) {
    const M = CFG.meteor;
    const n = this.active.length;

    for (let i = 0; i < n; i++) {
      const m = this.active[i];
      const t = (now - m.t0) * 0.001;
      const tele = m.telegraph;

      // หิน — หมุนตามเวลา (deterministic เหมือนกัน)
      _q.setFromAxisAngle(m.spinAxis, m.spinRate * t);
      // ช่วงพายุ ก้อนหดตามนัดที่โดน แต่มี "พื้น" ไม่ให้เล็กเกินไป
      // ไม่งั้นนัดท้ายๆ จะยิงยากขึ้น = ลงโทษคนที่ยิงถูกมาแล้ว
      const dmg = m.dmgScale === undefined ? 1 : m.dmgScale;
      const rockScale = (tele ? m.size * 0.35 : m.size)
        * (m.fadeK === undefined ? 1 : m.fadeK) * dmg;
      _m.compose(m.position, _q, _s.setScalar(rockScale));
      this.rock.setMatrixAt(i, _m);

      // ลูกเรืองแสง — ตอน telegraph หรี่ลงและเล็กลง ให้รู้ว่า "ยังมาไม่ถึง"
      // ตอนไหม้หมดแล้ว fadeK จะไล่ลง 0 → หด+จางหายไปกลางอากาศ
      const fade = m.fadeK === undefined ? 1 : m.fadeK;
      const glowScale = m.size * M.glowScale * (tele ? 0.42 : 1) * fade * dmg;
      m._glowScale = glowScale;
      _m.compose(m.position, this.camera ? this.camera.quaternion : _q.identity(),
                 _s.setScalar(glowScale));
      this.glow.setMatrixAt(i, _m);
      this.glow.setColorAt(i, tele ? _col.setRGB(0.55, 0.16, 0.20) : _col.setRGB(1.0, 0.62, 0.26));

      // หาง — ชี้สวนทางความเร็ว ตอน telegraph ทำยาวและบาง = "เส้นเรืองบางๆ"
      getVelocity(m, now, _dir).normalize().multiplyScalar(-1);
      _q.setFromUnitVectors(_up, _dir);
      const len = m.size * M.trailLen * (tele ? 2.6 : 1) * fade;   // หางหดสั้นตอนไหม้หมด
      const wid = m.size * M.trailWidth * (tele ? 0.16 : 1) * fade;
      _p.copy(m.position).addScaledVector(_dir, len * 0.5);
      _m.compose(_p, _q, _s.set(wid, len, wid));
      this.trail.setMatrixAt(i, _m);
      this.trail.setColorAt(i, tele ? _col.setRGB(0.5, 0.14, 0.18) : _col.setRGB(0.95, 0.42, 0.12));
    }

    this.rock.count = this.glow.count = this.trail.count = n;
    this.rock.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
    this.trail.instanceMatrix.needsUpdate = true;
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;
    if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
  }

  /**
   * หันลูกเรืองแสงเข้าหากล้องตัวที่กำลังจะวาด — Phase B เรียกก่อนวาดทุก viewport
   *
   * ทำไมต้องมี: billboard ที่หันเข้ากล้องตัวเดียวจะเฉียงเมื่อมองจากกล้องอีกตัว
   * มี InstancedMesh ก้อนเดียวแต่กล้อง 3 ตัว เลยต้องเขียน matrix ใหม่ก่อนวาดแต่ละช่อง
   * (18 ดวง × 3 ช่อง = ถูกมาก ไม่ต้องไปเขียน shader billboard ให้ซับซ้อน)
   */
  faceCamera(camera) {
    const n = this.active.length;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const m = this.active[i];
      _m.compose(m.position, camera.quaternion, _s.setScalar(m._glowScale || m.size));
      this.glow.setMatrixAt(i, _m);
    }
    this.glow.instanceMatrix.needsUpdate = true;
  }

  /** ตำแหน่งที่ดวงนี้จะอยู่อีก ms ข้างหน้า — ใช้นำเป้าตอนยิง */
  predict(m, now, aheadMs, out = new THREE.Vector3()) {
    return getPosition(m, now + aheadMs, out);
  }
}
