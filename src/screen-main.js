// screen-main.js — bootstrap ของจอใหญ่ Phase B
//
// ตั้งใจแยกไฟล์จาก main.js ของ Phase A ไม่ใช่แก้ทับ:
//   - main.js  = โหมดคนเดียว เอาไว้จูน feel ต่อได้เรื่อยๆ ไม่ต้องเปิด server
//   - ไฟล์นี้  = โหมด 3 คน รับคำสั่งจาก server อย่างเดียว
// โมดูลที่เหลือ (city / meteors / juice / turret-rig / compass / config) ใช้ร่วมกันทั้งคู่
//
// สิ่งที่ไฟล์นี้ "ไม่ทำ" เพราะเป็นหน้าที่ server:
//   - ไม่สุ่มเกิดอุกกาบาตเอง        (รอ event spawn)
//   - ไม่ตัดสินว่าใครยิงโดน         (รอ event hit)
//   - ไม่ลบอุกกาบาตเองตอนยิงโดน     (รอ event hit เท่านั้น)

import * as THREE from 'three';
import { CFG, DEG, damp } from './config.js';
import { Net } from './net.js';
import { Viewports } from './viewports.js';
import { MeteorField } from './meteors.js';
import { buildCity, buildArcMarkers, buildSky } from './city.js';
import { Juice } from './juice.js';
import { createTurret, buildTurretProcedural } from './turret-rig.js';

// ── ตำแหน่งป้อมของแต่ละคน ────────────────────────────────
// วางเรียงกันใกล้ๆ (ห่าง 11 ม.) เพราะอุกกาบาตอยู่ไกล 100-600 ม.
// ระยะแค่นี้ทำให้ "ซุ้ม 180°" ของทุกคนถือว่าเป็นผืนเดียวกันได้ marker บน compass
// ของเพื่อนเลยเทียบกันตรงๆ ได้ (spec §5) ถ้าวางห่างกันเป็นร้อยเมตรจะเทียบไม่ได้
const TURRET_X = { 1: -11, 2: 0, 3: 11 };

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.perf.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.autoClear = false;
document.getElementById('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(buildSky());
scene.add(buildCity());
scene.add(buildArcMarkers());
scene.add(new THREE.HemisphereLight(0x35509a, 0x05070d, 1.1));
const moon = new THREE.DirectionalLight(0xa8c4ff, 1.6);
moon.position.set(-40, 60, 30);
scene.add(moon);

const net = new Net();
const viewports = new Viewports(renderer);
const cameras = new Map();      // slot -> PerspectiveCamera
const rigs = new Map();         // slot -> TurretRig
const juice = new Juice(scene, null);
const field = new MeteorField(scene, null);
field.networked = true;         // ห้ามเกิดเอง รอ server สั่ง
field.load();

// ── สร้างป้อม + กล้องของ slot ─────────────────────────────
function ensureSlot(slot, hex) {
  if (cameras.has(slot)) return;

  const cam = new THREE.PerspectiveCamera(
    CFG.camera.fov, viewports.aspect(slot), CFG.camera.near, CFG.camera.far);
  cam.rotation.order = 'YXZ';
  cameras.set(slot, cam);

  const color = new THREE.Color(hex || '#59c0ff').getHex();
  const rig = buildTurretProcedural(color);
  rig.root.rotation.y = Math.PI;            // +Z ของโมเดล = ปากกระบอก, ฉากมองไป -Z
  rig.root.position.x = TURRET_X[slot] || 0;
  scene.add(rig.root);
  rigs.set(slot, rig);

  // เปลี่ยนเป็นโมเดลจริงเมื่อโหลดเสร็จ (createTurret เรียกซ้ำได้ เพราะต้องได้ material คนละชุด
  // ไม่งั้น setColor ของคนหนึ่งจะไปเปลี่ยนสีป้อมของทุกคน)
  createTurret(CFG.assets.turret, color).then(r => {
    scene.remove(rig.root);
    r.root.rotation.y = Math.PI;
    r.root.position.x = TURRET_X[slot] || 0;
    scene.add(r.root);
    rigs.set(slot, r);
  }).catch(() => { /* ใช้ procedural ต่อไป */ });
}

function syncSlots() {
  for (const s of net.slots) {
    if (s.taken) ensureSlot(s.slot, s.hex);
  }
  // ไม่ลบกล้อง/ป้อมของคนที่หลุด — เดี๋ยวเขากลับมา slot เดิม (token) จะได้ไม่กระตุก
}

// ── กล้องโคจรรอบป้อมตัวเอง (เหมือน Phase A) ───────────────
const _shake = { yaw: 0, pitch: 0, roll: 0 };

function driveCamera(slot, dt) {
  const cam = cameras.get(slot);
  const rig = rigs.get(slot);
  const a = net.aimOf(slot);
  if (!cam || !a) return;

  const bx = TURRET_X[slot] || 0;
  cam.position.set(
    bx + Math.sin(a.yaw) * CFG.camera.eye.z,
    CFG.camera.eye.y,
    Math.cos(a.yaw) * CFG.camera.eye.z,
  );
  const sh = juice.shakeFor ? juice.shakeFor(slot) : _shake;
  cam.rotation.set(a.pitch + sh.pitch, a.yaw + sh.yaw, sh.roll, 'YXZ');

  if (rig) { rig.aim(a.yaw, a.pitch); rig.update(dt); }
}

// ══ event จาก server ══════════════════════════════════════
net.on('hello', (d) => {
  window.__hello = d;
  syncSlots();
});
net.on('roster', () => { syncSlots(); refreshLobby(); });
net.on('state', () => { syncSlots(); });

net.on('spawn', (wire) => {
  // server บอกแค่ "เกิดเมื่อไร ไปทางไหน" — ตำแหน่งจอใหญ่คำนวณเอง
  field.spawnFromWire(wire);
});

net.on('hit', (d) => {
  const m = field.byId(d.meteorId);
  if (!m) return;
  const info = net.slotInfo(d.slot);
  const rgb = info ? info.rgb : [1, 0.6, 0.25];
  juice.explode(m.position, Math.min(2.0, m.size / CFG.meteor.sizeMin), true, rgb);
  field.kill(m);                       // ลบ "หลังจาก" server สั่งเท่านั้น
});

net.on('burnup', (d) => {
  const m = field.byId(d.meteorId);
  if (!m) return;
  juice.explode(m.position, 1.4, false);
  field.kill(m);
});

// ══ lobby ═════════════════════════════════════════════════
const lobbyEl = document.getElementById('lobby');
function refreshLobby() {
  const any = net.slots.some(s => s.taken && s.connected);
  lobbyEl.classList.toggle('hidden', any);
}

// ══ resize ════════════════════════════════════════════════
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  viewports.resize(w, h);
  for (const [slot, cam] of cameras) {
    cam.aspect = viewports.aspect(slot);
    cam.updateProjectionMatrix();
  }
  window.dispatchEvent(new CustomEvent('spaceht-layout', { detail: viewports }));
}
window.addEventListener('resize', onResize);

// ══ loop ══════════════════════════════════════════════════
let last = performance.now();

function frame(nowReal) {
  requestAnimationFrame(frame);
  const dt = Math.min((nowReal - last) * 0.001, CFG.perf.maxDt);
  last = nowReal;

  // เวลาของอุกกาบาตคือ "เวลาของ server" ไม่ใช่เวลาในเครื่องนี้
  // และห้าม freeze ตอน hitstop เหมือน Phase A — ฟ้าเป็นผืนเดียวกัน
  // ถ้าคนหนึ่งหยุดเวลา อีกสองคนจะเห็นอุกกาบาตกระตุกไปด้วย
  const t = net.serverNow();

  net.update(dt);
  field.update(t);
  juice.update(dt, dt);

  for (const slot of cameras.keys()) driveCamera(slot, dt);

  viewports.render(scene, cameras, (cam) => field.faceCamera(cam));
}

net.connect();
onResize();
requestAnimationFrame(frame);

window.__screen = { net, field, juice, scene, cameras, rigs, viewports, renderer, CFG };
