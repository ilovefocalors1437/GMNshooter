// main.js — bootstrap + game loop
//
// เวลาในเกมมี 2 นาฬิกา อย่าสับสน:
//   realDt   = เวลาจริง — ใช้กับแฟลช/vignette ที่ต้องกระพริบ *ระหว่าง* hitstop
//   dt       = เวลาในเกม — เป็น 0 ตอน hitstop ทุกอย่างหยุดสนิท
//   gameTime = สะสมจาก dt — อุกกาบาตทุกดวงคำนวณตำแหน่งจากตัวนี้ (ไม่ใช่ performance.now)
//
// ทำไมต้องแยก: hitstop ที่ freeze แค่ "การวาด" จะรู้สึกเหมือนเกมค้าง
// แต่ freeze "เวลา" ทั้งก้อนแล้วยังมีแฟลชวาบ จะรู้สึกเหมือนโดนเต็มๆ

import * as THREE from 'three';
import { CFG, DEG, clamp } from './config.js';
import { CameraControl, dirFrom } from './camera-control.js';
import { createTurret, buildTurretProcedural } from './turret-rig.js';
import { MeteorField } from './meteors.js';
import { buildCity, buildArcMarkers, buildSky } from './city.js';
import { Juice } from './juice.js';
import { Viewmodel } from './viewmodel.js';
import { Compass } from './compass.js';
import { Hud } from './hud.js';
import { Sfx } from './audio.js';
import { GmnFeed } from './gmn.js';
import { ContactLog } from './contact-log.js';
import { FloatText } from './float-text.js';

// ══ scene ═══════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.perf.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  CFG.camera.fov, window.innerWidth / window.innerHeight, CFG.camera.near, CFG.camera.far);
camera.rotation.order = 'YXZ';
camera.position.set(CFG.camera.eye.x, CFG.camera.eye.y, CFG.camera.eye.z);

scene.add(buildSky());
scene.add(buildCity());          // ← Phase C สลับตรงนี้เป็น OSM กรุงเทพ ไม่ต้องแตะที่อื่น
scene.add(buildArcMarkers());

scene.add(new THREE.HemisphereLight(0x35509a, 0x05070d, 1.1));
const moon = new THREE.DirectionalLight(0xa8c4ff, 1.6);
moon.position.set(-40, 60, 30);
scene.add(moon);

// ══ ระบบต่างๆ ═══════════════════════════════════════════════
const control = new CameraControl(camera, renderer.domElement);
const field = new MeteorField(scene, camera);
const juice = new Juice(scene, camera);
const viewmodel = new Viewmodel();
const compass = new Compass(document.getElementById('compass'));
const hud = new Hud();
const sfx = new Sfx();

// ป้อมปืน — +Z ของโมเดลคือปากกระบอก ส่วนกล้อง yaw=0 มองไป -Z
// เลยต้องหมุน root 180° ให้ 2 ระบบตรงกัน แล้วส่ง yaw/pitch ชุดเดียวกันได้เลย
let rig = buildTurretProcedural(0x59c0ff);
rig.root.rotation.y = Math.PI;
scene.add(rig.root);

createTurret(CFG.assets.turret, 0x59c0ff).then(r => {
  scene.remove(rig.root);
  rig = r;
  rig.root.rotation.y = Math.PI;
  scene.add(rig.root);
}).catch(e => console.warn('[main] ใช้ป้อม procedural แทน:', e.message));

field.load();

// ── GMN: อุกกาบาตจริง ─────────────────────────────────────
// ถ้าไม่มี data/meteors.db เกมยังเล่นได้ปกติ แค่กลับไปสุ่มเอง (ไม่มี contact log)
const contactLog = new ContactLog(document.getElementById('contactlist'));
const floatText = new FloatText(camera);
const gmn = new GmnFeed();
field.feed = gmn;

gmn.init().then(okGmn => {
  const s = gmn.stats || {};
  const txt = okGmn
    ? `${s.count.toLocaleString('en-US')} events · ${(s.from || '').slice(0, 10)} → ${(s.to || '').slice(0, 10)}`
    : 'ยังไม่มีฐานข้อมูล — รัน tools/bake_gmn.py (เกมจะสุ่มเองไปก่อน)';
  const a = document.getElementById('gmnstat');
  const b = document.getElementById('gmnstat2');
  if (a) a.textContent = okGmn ? txt : 'random mode';
  if (b) b.textContent = txt;
});

// ══ กระสุน — pool, ห้าม hitscan ════════════════════════════
// "แท่งเรืองแสงอ้วน วิ่งช้าพอเห็น ~150ms ถึงเป้า" (spec §4)
// เวลาเดินทางคงที่ไม่ว่าเป้าไกลแค่ไหน → เด็กเรียนรู้จังหวะได้ครั้งเดียวใช้ได้ตลอด
class Tracers {
  constructor(scene) {
    const B = CFG.bullet;
    const geo = new THREE.CylinderGeometry(B.radius, B.radius * 0.45, 1, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: B.color, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.95, side: THREE.DoubleSide,
    });
    this.items = [];
    for (let i = 0; i < B.poolSize; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.items.push({
        mesh, active: false, t: 0, dur: 1, dist: 0,
        start: new THREE.Vector3(), dir: new THREE.Vector3(),
        quat: new THREE.Quaternion(), target: null, targetId: 0,
      });
    }
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
  }

  spawn(from, to, durMs, target) {
    const it = this.items.find(i => !i.active) || this.items[0];
    it.start.copy(from);
    it.dir.copy(to).sub(from);
    it.dist = it.dir.length();
    if (it.dist < 0.001) return null;
    it.dir.divideScalar(it.dist);
    it.quat.setFromUnitVectors(this._up, it.dir);
    it.mesh.quaternion.copy(it.quat);
    it.t = 0; it.dur = durMs; it.active = true; it.mesh.visible = true;
    it.target = target;
    it.targetId = target ? target.id : 0;
    return it;
  }

  update(dt, onArrive) {
    const B = CFG.bullet;
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt * 1000;
      const u = Math.min(1, it.t / it.dur);
      const travelled = it.dist * u;

      // ยาวออกจากปากกระบอกทีละนิด ไม่ให้แท่งโผล่ยื่นหลังปืนตอนเพิ่งยิง
      const len = Math.min(B.length, travelled);
      this._tmp.copy(it.start).addScaledVector(it.dir, travelled - len * 0.5);
      it.mesh.position.copy(this._tmp);
      it.mesh.scale.set(1, Math.max(0.001, len), 1);
      it.mesh.material.opacity = 0.95;

      if (u >= 1) {
        it.active = false;
        it.mesh.visible = false;
        this._tmp.copy(it.start).addScaledVector(it.dir, it.dist);
        onArrive(it, this._tmp);
        it.target = null;
      }
    }
  }

  reset() {
    for (const it of this.items) { it.active = false; it.mesh.visible = false; it.target = null; }
  }
}
const tracers = new Tracers(scene);

// ══ game state ═════════════════════════════════════════════
const state = {
  running: false,
  score: 0, combo: 0,
  shots: 0, hits: 0,
  lastHitAt: -1e9, lastFireAt: -1e9,
};

let gameTime = 0;
let lastFrame = performance.now();
let mouseDown = false;

const _muzzlePos = new THREE.Vector3();
const _muzzleDir = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _rawEnd = new THREE.Vector3();
const impacts = [];

// ══ ยิง ═════════════════════════════════════════════════════
function fire() {
  if (!state.running) return;
  if (gameTime - state.lastFireAt < CFG.bullet.fireCooldownMs) return;
  state.lastFireAt = gameTime;
  state.shots++;

  rig.fire();
  viewmodel.fire();
  sfx.shoot();
  juice.shake(CFG.juice.shakeFire);

  rig.getMuzzle(_muzzlePos, _muzzleDir);

  const target = control.pickTarget(field.active);
  if (target) {
    // นำเป้า: ตำแหน่งที่มันจะอยู่ตอนกระสุนถึง ไม่ใช่ตำแหน่งตอนนี้
    // ทำได้เพราะเส้นทางเป็นฟังก์ชันของเวลา — นี่คือเหตุผลหนึ่งที่ meteors.js ต้องเขียนแบบนั้น
    field.predict(target, gameTime, CFG.bullet.travelMs, _end);

    // แล้วผสมกับ "ทิศที่ผู้เล่นเล็งจริงๆ" ตามความแม่น
    // เล็งกลางเป้า → ใช้จุดนำเป้าเกือบเต็ม (โดน)
    // เล็งค่อนไปขอบกรวย → ใช้ทิศดิบเป็นหลัก กระสุนจะพุ่งเฉียดไปจริงๆ (พลาด)
    // ห้ามให้ "อยู่ในกรวย = โดน" เด็ดขาด ไม่งั้นไม่ต้องใช้ฝีมือเลย
    const reach = _muzzlePos.distanceTo(_end);
    dirFrom(control.yaw, control.pitch, _aimDir);
    _rawEnd.copy(_muzzlePos).addScaledVector(_aimDir, reach);
    const help = CFG.assist.correction * Math.pow(1 - control.pickError01, CFG.assist.falloff);
    _end.lerpVectors(_rawEnd, _end, help);

    tracers.spawn(_muzzlePos, _end, CFG.bullet.travelMs, target);
  } else {
    // พลาด — กระสุนวิ่งผ่านไปให้เห็นเต็มๆ ว่าเล็งต่ำ/สูงไปเท่าไร
    dirFrom(control.yaw, control.pitch, _aimDir);
    _end.copy(_muzzlePos).addScaledVector(_aimDir, CFG.bullet.missSpeed * CFG.bullet.missMs * 0.001);
    tracers.spawn(_muzzlePos, _end, CFG.bullet.missMs, null);
  }
}

function onTracerArrive(it, pos) {
  const J = CFG.juice;

  // เป้าอาจโดนดวงอื่นยิงไปแล้ว หรือตกใส่เมืองไปก่อน — เช็ค id เพราะ pool ใช้ซ้ำ
  const m = it.target;
  if (!m || !m.alive || m.id !== it.targetId) return;

  // วัดระยะจริงตอนกระสุนถึงที่หมาย — ไม่ใช่ "ล็อกได้ = โดน"
  // นัดที่เล็งห่างกลางเป้าจะถูกช่วยแก้ทิศน้อย แล้วมาตกนอกรัศมีนี้เอง
  if (m.position.distanceTo(pos) > m.radius * CFG.meteor.hitRadiusBonus) return;

  state.hits++;
  if (gameTime - state.lastHitAt > CFG.score.comboWindowMs) state.combo = 0;
  state.combo = Math.min(CFG.score.comboMax, state.combo + 1);
  state.lastHitAt = gameTime;
  state.score += CFG.score.perHit * state.combo;

  // ระเบิด: particle + flash + light + scale punch พร้อมกันหมด — ต้องมาพร้อมกันถึงจะสะใจ
  juice.freeze(J.hitstopMs);
  juice.shake(J.shakeHit);
  juice.flash(J.flashHitMs, J.flashHitAlpha);
  juice.explode(m.position, clamp(m.size / CFG.meteor.sizeMin, 0.8, 2.0), true);
  sfx.hit(state.combo);

  contactLog.add(m, 'hit', CFG.score.perHit * state.combo);
  // §5.1 เด็กเพิ่งใช้เวลาเท่านี้ยิงมัน — บอกไปเลยว่าของจริงมันมีอยู่เท่าไร
  if (m.gmn) floatText.add(m.position, m.gmn.duration);
  field.kill(m);
}

function onBurnout(m) {
  // *** ห้ามหัก HP ที่นี่ *** (ดู CLAUDE.md)
  // ของจริงไม่มีดวงไหนถึงพื้น — GMN 472,388 ดวง ต่ำสุดจบที่ 32 กม.
  // ยิงไม่ทัน = จางหายกลางอากาศ + combo ขาด เท่านั้น ไม่มีอะไรเสียหาย
  state.combo = 0;
  sfx.burnout();
  contactLog.add(m, 'burned');
}

// ══ start / restart ════════════════════════════════════════
function startGame() {
  state.running = true;
  state.score = 0; state.combo = 0;
  state.shots = 0; state.hits = 0;
  state.lastHitAt = -1e9; state.lastFireAt = -1e9;

  field.reset(gameTime);
  tracers.reset();
  juice.reset();
  contactLog.clear();
  control.enabled = true;

  hud.hideStart();
  hud.hideGameOver();
  hud.setScore(0);
  hud.setCombo(0);
}

function endGame() {
  state.running = false;
  control.enabled = false;
  sfx.gameOver();
  hud.showGameOver(state.score, state.hits, state.shots ? state.hits / state.shots : 0);
  if (document.exitPointerLock) document.exitPointerLock();
}

// ══ input ══════════════════════════════════════════════════
document.getElementById('start').addEventListener('click', () => {
  sfx.resume();                 // ต้องอยู่ใน user gesture ไม่งั้น AudioContext โดนบล็อก
  control.requestLock();
  startGame();
});

// จอจบเกม: คลิกที่ไหนก็เริ่มใหม่ (ที่งานจริงเด็กจะไม่มีคีย์บอร์ด)
document.getElementById('gameover').addEventListener('click', () => {
  sfx.resume();
  startGame();
  control.requestLock();
});

document.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  if (!state.running) return;
  mouseDown = true;
  fire();
});
document.addEventListener('mouseup', () => { mouseDown = false; });
document.addEventListener('dblclick', () => control.recenter());

document.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); control.recenter(); }
  if (e.code === 'KeyR') { sfx.resume(); startGame(); control.requestLock(); }
});

// คลิกกลับเข้าจอหลังหลุด pointer lock
renderer.domElement.addEventListener('click', () => {
  if (state.running && !control.locked && CFG.camera.usePointerLock) control.requestLock();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewmodel.resize(window.innerWidth, window.innerHeight);
  compass.resize();
});

// ══ loop ═══════════════════════════════════════════════════
let prevYaw = 0;

// FOV แนวนอนจริง — camera.fov คือแนวตั้ง เอามาคูณ aspect ตรงๆ ไม่ได้
const hFovDeg = () =>
  2 * Math.atan(Math.tan(camera.fov * DEG / 2) * camera.aspect) / DEG;

function loop(nowReal) {
  requestAnimationFrame(loop);
  const realDt = Math.min((nowReal - lastFrame) * 0.001, CFG.perf.maxDt);
  lastFrame = nowReal;
  frame(realDt);
}

// แยกเนื้อ frame ออกจาก rAF — เดินเกมทีละ frame จาก console ได้เวลา debug
// (__spaceht.step(1/60) แล้วดูว่าเฟรมนั้นเกิดอะไรขึ้น)
function frame(realDt) {
  const dt = juice.beginFrame(realDt);     // 0 = กำลัง hitstop
  gameTime += dt * 1000;

  if (state.running && mouseDown) fire();  // กดค้าง = ยิงรัว ตาม cooldown

  // ── โลก ──
  if (state.running) {
    field.update(gameTime, impacts);
    for (const m of impacts) onBurnout(m);

    // เสียงหวีดตอน telegraph — pan ตาม yaw ให้หันไปถูกทาง
    for (const m of field.active) {
      if (!m.announced) {
        m.announced = true;
        sfx.whistle(m.yaw0, CFG.meteor.telegraphMs * 0.001);
      }
    }
  }

  // ── เล็ง ──
  control.update(dt, field.active);

  // กล้องโคจรรอบป้อม ไม่ใช่หมุนอยู่กับที่
  // ถ้าหมุนอยู่กับที่ พอหันไป 40° ป้อมจะไปกองอยู่ริมจอ ทั้งที่ผู้เล่นกำลังเล็งด้วยป้อมนั้น
  // ท่านี้ = คนยืนหลังปืน แล้วเดินตามปืนไปตอนมันหันซ้าย-ขวา → ลำกล้องอยู่ใต้ crosshair เสมอ
  camera.position.set(
    Math.sin(control.yaw) * CFG.camera.eye.z,
    CFG.camera.eye.y,
    Math.cos(control.yaw) * CFG.camera.eye.z,
  );
  control.applyTo(camera, juice.shakeOffset);

  const yawVel = dt > 0 ? (control.yaw - prevYaw) / dt : 0;
  prevYaw = control.yaw;

  rig.aim(control.yaw, control.pitch);
  rig.update(dt);

  tracers.update(dt, onTracerArrive);
  juice.update(dt, realDt);
  contactLog.update(realDt);       // คุมเวลาค้างขั้นต่ำของการ์ด
  floatText.update(realDt);        // ใช้ realDt — ตัวเลขต้องลอยต่อแม้ตอน hitstop
  viewmodel.update(dt, yawVel);

  // ── HUD ──
  hud.setScore(state.score);
  hud.setCombo(state.combo);
  hud.setLock(!!control.assistTarget);
  compass.draw(gameTime, control.yaw, field.active, camera.position, hFovDeg());

  // ── วาด ──
  renderer.render(scene, camera);
  viewmodel.render(renderer);
}

viewmodel.resize(window.innerWidth, window.innerHeight);
requestAnimationFrame(loop);

// เผื่ออยากจูนสดจาก console: __spaceht.cfg.juice.hitstopMs = 120
window.__spaceht = {
  CFG, cfg: CFG, state, field, control, juice, tracers, scene, camera, renderer, rig: () => rig,
  get gameTime() { return gameTime; },
  fire,                       // ยิงจาก console ได้ ใช้ตอน debug
  step: frame,                // เดินเกมทีละ frame
  startGame, endGame,
};
