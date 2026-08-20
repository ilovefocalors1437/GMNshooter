// mobile-main.js — เกมเต็มที่รันบนมือถือเด็ก (Phase C)
//
// ต่างจาก Phase B ตรงที่มือถือไม่ใช่ controller โง่แล้ว — มันเรนเดอร์เกมเองทั้งหมด
//
// กฎ co-op ที่ห้ามพลาด (spec §2 / §10):
//   1. ห้ามลบอุกกาบาตเองตอนยิงโดน — ต้องรอ event `destroyed` จาก server เท่านั้น
//   2. tracer ที่ยิงไปแล้วต้องวิ่งจนจบเสมอ ถึงเป้าจะถูกเพื่อนยิงไปก่อน (หายกลางอากาศ = ดูเหมือนบั๊ก)
//   3. เพื่อนยิงโดน = ฉลอง ไม่ใช่ลงโทษ → ระเบิดเป็นสีเพื่อน

import * as THREE from 'three';
import { CFG, DEG, clamp, damp } from './config.js';
import { anglesTo, dirFrom, angleDelta } from './camera-control.js';
import { TouchLook } from './touch-look.js';
import { MeteorField, getPosition } from './meteors.js';
import { buildCity, buildArcMarkers, buildSky } from './city.js';
import { Juice } from './juice.js';
import { createTurret, buildTurretProcedural } from './turret-rig.js';
import { Sfx } from './audio.js';
import { ContactLog } from './contact-log.js';
import { FloatText } from './float-text.js';

const $ = id => document.getElementById(id);

// ── โหมดจากพารามิเตอร์ใน URL ──────────────────────────────
// จอ admin ฝั่งซ้ายฝัง iframe หน้านี้ด้วย ?spectate=1 → ดูเกมสดโดยไม่กินสล็อต
const QS = new URLSearchParams(location.search);
const SPECTATE = QS.get('spectate') === '1';
// ?admin=1 = admin กดเริ่มรอบแล้วสับมาเล่นเต็มจอในห้องของตัวเอง (คะแนนลงบอร์ด ADMIN)
const ADMIN_MODE = QS.get('admin') === '1';
const URL_CODE = (QS.get('code') || '').trim().toUpperCase();
const panes = ['p-home', 'p-code', 'p-admin', 'p-team', 'p-lobby', 'p-count', 'p-sum'];
function pane(id) {
  panes.forEach(p => $(p).classList.toggle('on', p === id));
  $('hud').classList.toggle('on', id === null);
}

// ══ สถานะ ═════════════════════════════════════════════════
const S = {
  token: null, slot: 0, hex: '#59c0ff', rgb: [0.35, 0.75, 1],
  code: null, team: null,
  roundId: 0, startMs: 0, endMs: 0,
  schedule: [], spawned: new Set(), destroyed: new Set(),
  playing: false,
  score: 0, combo: 0, kills: 0,
  phase: 'normal', stormHits: 0, stormTotal: 0,
  stormStartSec: 50, stormPassRate: 0.6, stormMinScale: 0.6,
  offset: 0, bestRtt: Infinity,
  lastFireAt: -1e9,
  spectator: SPECTATE,
  // QTE ปิดท้ายรอบ
  qteOn: false, qteNeed: 0, qteHits: 0, qteEndMs: 0, qteMeteorId: 0,
};
const serverNow = () => performance.now() + S.offset;

// ══ Socket ════════════════════════════════════════════════
const sock = window.io({ transports: ['websocket', 'polling'] });

function syncClock() {
  let n = 0;
  const tick = () => {
    if (n++ >= CFG.net.syncPings) return;
    sock.emit('time_sync', { c: performance.now() });
    setTimeout(tick, CFG.net.syncIntervalMs);
  };
  tick();
}
sock.on('time_sync', d => {
  const rtt = performance.now() - d.c;
  if (rtt >= S.bestRtt) return;
  S.bestRtt = rtt;
  S.offset = d.s - d.c - rtt / 2;
});

sock.on('connect', () => {
  syncClock();
  if (S.spectator) { sock.emit('spectate', { code: URL_CODE }); return; }
  // มาจากจอ admin พร้อมรหัสห้องแล้ว → เข้าเลยไม่ต้องพิมพ์
  if (URL_CODE) {
    sock.emit('join_room_code', { code: URL_CODE,
      token: sessionStorage.getItem('spaceht_token') });
    return;
  }
  const t = sessionStorage.getItem('spaceht_token');
  const c = sessionStorage.getItem('spaceht_code');
  if (t && c) sock.emit('join_room_code', { code: c, token: t });   // หลุดแล้วกลับมา
});

// ดูอย่างเดียว — ข้ามหน้ากรอกรหัส/ตั้งชื่อทีมไปที่ฉากเลย
sock.on('spectating', d => {
  S.code = d.code; S.team = d.team;
  $('lobby-code').textContent = d.code;
  $('teamname').textContent = d.team || 'รอผู้เล่น';
  pane(null);
  document.body.classList.add('spectator');
});

sock.on('join_failed', d => {
  $('code-err').textContent = d.msg || 'เข้าห้องไม่ได้';
  pane('p-code');
});

sock.on('joined', d => {
  S.token = d.token; S.slot = d.slot; S.hex = d.hex; S.rgb = d.rgb;
  S.code = d.code; S.team = d.team;
  sessionStorage.setItem('spaceht_token', d.token);
  sessionStorage.setItem('spaceht_code', d.code);
  document.documentElement.style.setProperty('--me', d.hex);
  $('lobby-code').textContent = d.code;
  pane(d.needTeamName ? 'p-team' : 'p-lobby');
  armNoSleep();
  // admin เพิ่งลงมาถึงห้องของตัวเอง → สั่งเริ่มได้แล้ว (ต้อง join ก่อนถึงจะมีผู้เล่นในห้อง)
  if (ADMIN_MODE) sock.emit('admin_room_start', { pw: sessionStorage.getItem('ht_pw') || '' });
});

sock.on('team_rejected', d => { $('team-err').textContent = d.msg; });
sock.on('error_msg', d => {
  const h = $('lobby-hint');
  if (h) h.textContent = d.msg || '';
});
sock.on('team_set', d => { S.team = d.team; $('lobby-team').textContent = d.team; pane('p-lobby'); });

sock.on('room', st => {
  // ห้องรีเซ็ตหลังจบรอบ (ทีมถูกล้าง) → คนแรกที่เหลืออยู่ตั้งชื่อใหม่
  if (!st.team && S.team && !S.spectator && st.state === 'lobby') {
    S.team = null;
    $('lobby-team').textContent = '—';
    if (!S.playing) pane('p-team');
  }
  // ใครก็ได้ที่กด "ยืนยัน" ก่อนเป็นคนตั้งชื่อทีม — คนที่เหลือเด้งตามเข้า lobby ทันที
  if (st.team && !S.team && !S.playing && $('p-team').classList.contains('on')) {
    pane('p-lobby');
  }
  S.team = st.team || S.team;
  $('lobby-team').textContent = st.team || '—';
  $('teamname').textContent = st.team || '';
  const r = $('roster');
  r.innerHTML = st.players.map(p =>
    `<div class="dot${p.connected ? ' on' : ''}" style="background:${p.hex}"></div>`).join('');
  const cnt = $('lobby-count');
  if (cnt) cnt.textContent = `${st.playerCount} คน`;
});

sock.on('round_start', d => {
  S.stormStartSec = d.stormStartSec; S.stormPassRate = d.stormPassRate;
  S.stormMinScale = d.stormMinScale; S.phase = 'normal';
  S.stormHits = 0; S.stormTotal = 0;
  document.body.classList.remove('storm');
  $('stormbar').style.display = 'none';
  contactLog.setStormMode(false);
  S.qteOn = false; S.qteHits = 0; S.qteNeed = 0; S.qteMeteorId = 0;
  document.body.classList.remove('qte');
  $('qtebar').style.display = 'none';
  S.roundId = d.roundId; S.startMs = d.startMs; S.endMs = d.endMs;
  S.schedule = d.schedule;
  S.spawned = new Set();
  S.destroyed = new Set(d.destroyed || []);
  S.score = 0; S.combo = 0; S.kills = 0;
  field.reset ? null : null;
  field.active.slice().forEach(m => field.kill(m));
  tracers.reset();
  juice.reset();
  S.playing = true;
  pane('p-count');
  sfx.resume();
});

sock.on('tick', d => {
  S.score = d.score; S.kills = d.kills; S.combo = d.combo;
  if (d.qteNeed !== undefined) { S.qteHits = d.qteHits; S.qteNeed = d.qteNeed; }
  if (d.phase && d.phase !== S.phase) setPhase(d.phase);
  if (d.stormTotal !== undefined) { S.stormHits = d.stormHits; S.stormTotal = d.stormTotal; }
  paintHud(d.timeLeftMs);
});

// นัดที่ยังไม่ครบ — ทุกเครื่องหดก้อนพร้อมกัน (server เป็นคนนับ ไม่ใช่ client)
sock.on('damaged', d => {
  const m = field.byId(d.meteorId);
  if (!m) return;
  const k = 1 - (d.done / d.need) * (1 - S.stormMinScale);
  m.dmgScale = Math.max(S.stormMinScale, k);
  juice.explode(m.position, 0.35, true, hexToRgb(d.hex));
  sfx.shoot();
});

// ══ QTE ปิดท้ายรอบ ═════════════════════════════════════════
// หมดเวลาแล้วยังไม่จบ — ลูกไฟ GMN ดวงที่สว่างที่สุดโผล่กลางซุ้ม ทั้งทีมรัวยิงพร้อมกัน
// มันก็ยัง "ไหม้หมดกลางอากาศ" เหมือนทุกดวง แค่ให้เวลาเท่ากับหน้าต่าง QTE พอดี
sock.on('qte_start', d => {
  S.qteOn = true;
  S.qteNeed = d.need; S.qteHits = d.hits || 0;
  S.qteEndMs = d.endMs;
  S.phase = 'qte';
  document.body.classList.remove('storm');
  $('stormbar').style.display = 'none';
  contactLog.setStormMode(true);          // เอาพื้นที่จอให้ตัวนับ เหมือนช่วงพายุ
  document.body.classList.add('qte');
  $('qtebar').style.display = 'block';
  paintQte();
  if (d.meteor) {
    S.qteMeteorId = d.meteor.id;
    field.spawnFromWire({ ...d.meteor, t0: d.startMs });
  }
  juice.shake(1.2);
  sfx.resume();
  $('qtebanner').classList.add('on');
  setTimeout(() => $('qtebanner').classList.remove('on'), 1600);
});

sock.on('qte_progress', d => {
  S.qteHits = d.hits; S.qteNeed = d.need;
  paintQte();
  const m = field.byId(S.qteMeteorId);
  if (m) juice.explode(m.position, 0.28, true, hexToRgb(d.hex));
});

function paintQte() {
  if (!S.qteNeed) return;
  const done = S.qteHits >= S.qteNeed;
  $('qtecount').textContent = `${S.qteHits} / ${S.qteNeed}`;
  $('qtecount').classList.toggle('ok', done);
  const pct = Math.min(100, S.qteHits / S.qteNeed * 100);
  $('qtefill').style.width = pct + '%';
  $('qtefill').classList.toggle('ok', done);
}

function setPhase(ph) {
  S.phase = ph;
  const storm = ph === 'storm';
  document.body.classList.toggle('storm', storm);
  contactLog.setStormMode(storm);      // §F2 พายุซ่อนการ์ด เอาพื้นที่ให้ตัวนับ
  $('stormbar').style.display = storm ? 'block' : 'none';
  if (storm) {
    juice.shake(1.0);
    $('stormbanner').classList.add('on');
    setTimeout(() => $('stormbanner').classList.remove('on'), 2200);
  }
}

// server ตัดสินแล้วว่าใครยิงโดน — ทุกเครื่องเอาออกพร้อมกันตรงนี้ที่เดียว
sock.on('destroyed', d => {
  S.destroyed.add(d.meteorId);
  S.score = d.teamScore; S.combo = d.combo; S.kills = d.kills;
  if (d.stormTotal !== undefined) { S.stormHits = d.stormHits; S.stormTotal = d.stormTotal; }
  const m = field.byId(d.meteorId);
  if (m) {
    const rgb = hexToRgb(d.hex);
    juice.explode(m.position, clamp(m.size / CFG.meteor.sizeMin, 0.8, 2.0), true, rgb);
    if (S.phase !== 'storm' && m.gmn) floatText.add(m.position, m.gmn.duration);
    contactLog.add(m, 'hit');
    field.kill(m);
    sfx.hit(d.combo);
    if (d.slot === S.slot) juice.shake(CFG.juice.shakeHit);
  }
});

sock.on('round_end', d => {
  S.playing = false;
  S.qteOn = false;
  document.body.classList.remove('storm');
  document.body.classList.remove('qte');
  $('qtebar').style.display = 'none';

  $('sum-team').textContent = d.team || '—';
  $('sum-score').textContent = d.score.toLocaleString('en-US');
  $('sum-kills').innerHTML = `สอยได้ <b>${d.kills}</b> ดวง · คอมโบสูงสุด <b>\u00d7${d.bestCombo}</b>`;

  // "ยิงอะไรไป กล้องชาติไหนบันทึกไว้ อย่างละกี่ดวง" — มาจากดวงที่สอยได้จริงในรอบนี้
  const rows = contactLog.catches();
  $('sum-list').innerHTML = rows.length
    ? rows.map(r =>
        `<div class="s-row">` +
        `<div class="nm">${escapeHtml(r.shower)}` +
        `${r.cam ? `<div class="cam">กล้องที่บันทึกไว้: ${escapeHtml(r.cam)}</div>` : ''}</div>` +
        `<div class="n">${r.n}<i>ดวง</i></div></div>`).join('')
    : '<div class="s-empty">รอบนี้ยังไม่ได้สักดวง ลองใหม่อีกรอบ</div>';

  $('sum-nums').innerHTML =
    `<div class="sc"><span>อุกกาบาตในฐานข้อมูล</span><b data-to="${d.gmnTotal || 0}">0</b></div>` +
    `<div class="sc"><span>กล้องบนหลังคาทั่วโลก</span><b data-to="${d.gmnCameras}" data-pre="~">0</b></div>`;
  countUp($('sum-nums'));

  pane('p-sum');
  if (ADMIN_MODE) {
    $('again').style.display = 'none';
    $('to-admin').style.display = 'block';
  }
  if (S.spectator) setTimeout(() => { pane(null); }, 14000);
});

// ══ UI ════════════════════════════════════════════════════
$('code-go').onclick = () => {
  const c = $('code').value.trim().toUpperCase();
  $('code-err').textContent = '';
  sock.emit('join_room_code', { code: c, token: sessionStorage.getItem('spaceht_token') });
};
if (URL_CODE && $('code')) $('code').value = URL_CODE;
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('code-go').click(); });

// หน้าแรกแยก 2 ทาง — เด็กกรอกรหัสห้อง / ผู้ดูแลกรอกรหัสผ่าน
$('go-player').onclick = () => { $('code-err').textContent = ''; pane('p-code'); $('code').focus(); };
$('go-admin').onclick  = () => { $('apw-err').textContent = '';  pane('p-admin'); };
$('code-back').onclick = () => pane('p-home');
$('apw-back').onclick  = () => pane('p-home');
$('to-admin').onclick  = () => { location.href = '/admin'; };

$('apw-go').onclick = () => sock.emit('admin_login', { pw: $('apw').value });
$('apw').addEventListener('keydown', e => { if (e.key === 'Enter') $('apw-go').click(); });
sock.on('admin_login', d => {
  if (d.ok) {
    sessionStorage.setItem('ht_pw', $('apw').value);   // /admin หยิบไปใช้ต่อ ไม่ต้องกรอกซ้ำ
    location.href = '/admin';
  } else {
    $('apw-err').textContent = 'รหัสผ่านไม่ถูก';
  }
});

$('team-go').onclick = () => {
  $('team-err').textContent = '';
  sock.emit('set_team', { name: $('team').value });
};

// ผู้เล่นไม่มีปุ่มเริ่ม — admin เป็นคนกด คนอื่นจะได้ทยอยเข้าจนครบก่อน
$('again').onclick = () => pane('p-lobby');

// ══ กันจอดับ ══════════════════════════════════════════════
let noSleep = null, armed = false;
try { noSleep = new window.NoSleep(); } catch (e) {}
function armNoSleep() {
  if (armed || !noSleep) return;
  armed = true;
  // enable() คืน Promise — try/catch ธรรมดาจับ rejection ไม่ได้ ต้อง .catch()
  // ไม่งั้นเวลาเด็กสลับแอปแล้วกลับมา จะมีแถบแดง "WakeLock: page is not visible"
  // ขึ้นทั้งที่เกมไม่ได้พังอะไรเลย
  try {
    const p = noSleep.enable();
    if (p && p.catch) p.catch(() => { armed = false; });   // ปล่อยให้ลองใหม่ตอนแตะครั้งหน้า
  } catch (e) { armed = false; }
}
document.addEventListener('touchend', armNoSleep);
document.addEventListener('click', armNoSleep);

// ══ ฉาก ═══════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.perf.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
$('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(buildSky());
scene.add(buildCity());
scene.add(buildArcMarkers());
scene.add(new THREE.HemisphereLight(0x35509a, 0x05070d, 1.1));
const moon = new THREE.DirectionalLight(0xa8c4ff, 1.6);
moon.position.set(-40, 60, 30);
scene.add(moon);

const camera = new THREE.PerspectiveCamera(
  CFG.camera.fov, window.innerWidth / window.innerHeight, CFG.camera.near, CFG.camera.far);
camera.rotation.order = 'YXZ';

const juice = new Juice(scene, camera);
const field = new MeteorField(scene, camera);
field.networked = true;                 // ห้ามเกิดเอง — เดินตามตารางที่ server ส่งมา
field.load();
const sfx = new Sfx();
const contactLog = new ContactLog(document.getElementById('cardlist'));
const floatText = new FloatText(camera);

let rig = buildTurretProcedural(0x59c0ff);
rig.root.rotation.y = Math.PI;
scene.add(rig.root);
createTurret(CFG.assets.turret, 0x59c0ff).then(r => {
  scene.remove(rig.root);
  rig = r; rig.root.rotation.y = Math.PI; scene.add(rig.root);
}).catch(() => {});

const look = new TouchLook($('scene'));

// ══ กระสุน ════════════════════════════════════════════════
class Tracers {
  constructor(scene) {
    const B = CFG.bullet;
    const geo = new THREE.CylinderGeometry(B.radius, B.radius * 0.45, 1, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: B.color, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: .95, side: THREE.DoubleSide });
    this.items = [];
    for (let i = 0; i < B.poolSize; i++) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 4;
      scene.add(mesh);
      this.items.push({ mesh, active: false, t: 0, dur: 1, dist: 0,
        start: new THREE.Vector3(), dir: new THREE.Vector3(), targetId: 0 });
    }
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();
  }
  spawn(from, to, durMs, targetId) {
    const it = this.items.find(i => !i.active) || this.items[0];
    it.start.copy(from); it.dir.copy(to).sub(from);
    it.dist = it.dir.length();
    if (it.dist < 0.001) return null;
    it.dir.divideScalar(it.dist);
    it.mesh.quaternion.setFromUnitVectors(this._up, it.dir);
    it.t = 0; it.dur = durMs; it.active = true; it.mesh.visible = true;
    it.targetId = targetId || 0;
    return it;
  }
  update(dt, onArrive) {
    const B = CFG.bullet;
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt * 1000;
      const u = Math.min(1, it.t / it.dur);
      const travelled = it.dist * u;
      const len = Math.min(B.length, travelled);
      this._tmp.copy(it.start).addScaledVector(it.dir, travelled - len * .5);
      it.mesh.position.copy(this._tmp);
      it.mesh.scale.set(1, Math.max(.001, len), 1);
      // เป้าถูกเพื่อนยิงไปแล้ว → จางลงแทนที่จะหายวับ (spec §2)
      it.mesh.material.opacity = it.targetId && S.destroyed.has(it.targetId)
        ? .95 * (1 - u) : .95;
      if (u >= 1) {
        it.active = false; it.mesh.visible = false;
        this._tmp.copy(it.start).addScaledVector(it.dir, it.dist);
        onArrive(it, this._tmp);
      }
    }
  }
  reset() { for (const it of this.items) { it.active = false; it.mesh.visible = false; } }
}
const tracers = new Tracers(scene);

// ══ เล็ง + ยิง ════════════════════════════════════════════
const _a = {};
function pickTarget() {
  const cone = CFG.assist.lockOnDeg * DEG;
  let best = null, bestScore = Infinity;
  for (const m of field.active) {
    if (!m.hittable || S.destroyed.has(m.id)) continue;
    const a = anglesTo(camera.position, m.position, _a);
    const ang = Math.hypot(angleDelta(a.yaw, look.yaw), a.pitch - look.pitch);
    const ar = m.radius ? Math.atan(m.radius / Math.max(1, a.dist)) : 0;
    const limit = Math.max(cone, ar);
    if (ang > limit) continue;
    const sc = ang / limit;
    if (sc < bestScore) { bestScore = sc; best = m; }
  }
  return { target: best, err: best ? bestScore : 1 };
}

const _mp = new THREE.Vector3(), _md = new THREE.Vector3();
const _aim = new THREE.Vector3(), _end = new THREE.Vector3(), _raw = new THREE.Vector3();

function fire() {
  if (S.spectator) return;
  if (!S.playing) return;
  const t = serverNow();
  if (t - S.lastFireAt < CFG.bullet.fireCooldownMs) return;
  S.lastFireAt = t;

  rig.fire(); sfx.shoot(); juice.shake(CFG.juice.shakeFire);
  if (S.qteOn) { sock.emit('qte_tap', {}); } else { sock.emit('shot', {}); }

  rig.getMuzzle(_mp, _md);
  const { target, err } = pickTarget();

  if (target) {
    field.predict(target, t, CFG.bullet.travelMs, _end);
    const reach = _mp.distanceTo(_end);
    dirFrom(look.yaw, look.pitch, _aim);
    _raw.copy(_mp).addScaledVector(_aim, reach);
    const help = CFG.assist.correction * Math.pow(1 - err, CFG.assist.falloff);
    _end.lerpVectors(_raw, _end, help);
    tracers.spawn(_mp, _end, CFG.bullet.travelMs, target.id);
  } else {
    dirFrom(look.yaw, look.pitch, _aim);
    _end.copy(_mp).addScaledVector(_aim, CFG.bullet.missSpeed * CFG.bullet.missMs * .001);
    tracers.spawn(_mp, _end, CFG.bullet.missMs, 0);
  }
}

function onArrive(it, pos) {
  if (!it.targetId || !S.playing || S.qteOn) return;
  if (S.destroyed.has(it.targetId)) return;      // เพื่อนยิงไปก่อนแล้ว
  const m = field.byId(it.targetId);
  if (!m) return;
  if (m.position.distanceTo(pos) > m.radius * CFG.meteor.hitRadiusBonus) return;
  // เราคิดว่าโดน — แต่ไม่ลบเอง ส่งให้ server ตัดสินแล้วรอ event destroyed
  sock.emit('kill', { meteorId: it.targetId });
}

// ปุ่มยิง — กดค้างยิงรัว และลากนิ้วอีกข้างเล็งไปพร้อมกันได้
const fb = $('fire');
let holding = false;
function holdLoop() {
  if (!holding) return;
  fire();
  // ตอน QTE ต้อง "รัว" จริงๆ — กดค้างแล้วยิงเองไม่นับ ไม่งั้นวางนิ้วทิ้งไว้ก็ผ่าน
  if (S.qteOn) return;
  setTimeout(holdLoop, CFG.touch.fireRepeatMs);
}
fb.addEventListener('touchstart', e => {
  holding = true; fb.classList.add('down'); holdLoop();
  e.preventDefault(); e.stopPropagation();
}, { passive: false });
['touchend', 'touchcancel'].forEach(ev => fb.addEventListener(ev, e => {
  holding = false; fb.classList.remove('down'); e.preventDefault(); e.stopPropagation();
}, { passive: false }));
fb.addEventListener('mousedown', () => { holding = true; fb.classList.add('down'); holdLoop(); });
window.addEventListener('mouseup', () => { holding = false; fb.classList.remove('down'); });

// ══ คุณภาพอัตโนมัติ (§8) ══════════════════════════════════
let probeFrames = 0, probeStart = 0, qualityLocked = false;
function probeQuality(now) {
  if (qualityLocked) return;
  if (!probeStart) { probeStart = now; return; }
  probeFrames++;
  const el = (now - probeStart) / 1000;
  if (el < CFG.quality.probeSec) return;
  const fps = probeFrames / el;
  qualityLocked = true;
  if (fps < CFG.quality.lowFps) {
    // เครื่องไม่ไหว — ลดของหนักก่อนที่เด็กจะรู้สึกว่ามันกระตุก
    renderer.setPixelRatio(CFG.quality.lowPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    CFG.explosion.particles = Math.round(CFG.explosion.particles * CFG.quality.lowParticleScale);
    if (CFG.quality.lowDisableLights) {
      juice.lights.forEach(l => { l.light.visible = false; });
      if (rig && rig.light) rig.light.visible = false;
    }
    S.lowQuality = true;
  }
  S.measuredFps = Math.round(fps);
}

// ══ HUD ═══════════════════════════════════════════════════
function paintHud(leftMs) {
  if (S.phase === 'storm' && S.stormTotal) {
    const need = Math.ceil(S.stormTotal * S.stormPassRate);
    $('stormcount').textContent = `${S.stormHits} / ${S.stormTotal}`;
    $('stormneed').textContent = `ต้องได้ ${need} ถึงจะผ่าน`;
    const pct = Math.min(100, S.stormHits / S.stormTotal * 100);
    $('stormfill').style.width = pct + '%';
    $('stormline').style.left = (S.stormPassRate * 100) + '%';
    $('stormcount').classList.toggle('ok', S.stormHits >= need);
  }
  $('teamscore').textContent = S.score.toLocaleString('en-US');
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  const cl = $('clock');
  cl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  cl.classList.toggle('low', s <= 20);
  const c = $('combo');
  c.textContent = `COMBO ×${S.combo}`;
  c.classList.toggle('on', S.combo >= 2);
}

// ══ loop ══════════════════════════════════════════════════
let last = performance.now();
function frame(nowReal) {
  requestAnimationFrame(frame);
  const dt = Math.min((nowReal - last) * .001, CFG.perf.maxDt);
  last = nowReal;
  probeQuality(nowReal);

  const t = serverNow();

  // countdown → เริ่มเล่น
  if (S.playing && t < S.startMs) {
    $('countdown').textContent = Math.max(1, Math.ceil((S.startMs - t) / 1000));
  } else if (S.playing && $('p-count').classList.contains('on')) {
    pane(null);
  }

  // เดินตารางอุกกาบาตที่ server ส่งมา — ทุกเครื่องได้ชุดเดียวกันเป๊ะ
  if (S.playing && t >= S.startMs) {
    for (const w of S.schedule) {
      if (S.spawned.has(w.id)) continue;
      const abs = S.startMs + w.t0;
      if (t < abs) break;                       // schedule เรียงตามเวลาแล้ว
      S.spawned.add(w.id);
      if (S.destroyed.has(w.id)) continue;      // ถูกยิงไปตอนเรายังไม่เข้า
      field.spawnFromWire({ ...w, t0: abs });
    }
  }

  look.update(dt);
  camera.position.set(
    Math.sin(look.yaw) * CFG.camera.eye.z, CFG.camera.eye.y,
    Math.cos(look.yaw) * CFG.camera.eye.z);
  const sh = juice.shakeOffset;
  camera.rotation.set(look.pitch + sh.pitch, look.yaw + sh.yaw, sh.roll, 'YXZ');

  rig.aim(look.yaw, look.pitch);
  rig.update(dt);

  field.update(t);
  tracers.update(dt, onArrive);
  juice.update(dt, dt);
  contactLog.update(dt);
  floatText.update(dt);

  if (S.qteOn) {
    const left = Math.max(0, (S.qteEndMs - t) / 1000);
    $('qtetime').textContent = left.toFixed(1);
  }

  const { target } = S.playing ? pickTarget() : { target: null };
  $('cross').classList.toggle('lock', !!target);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/** นับเลขขึ้น — 472,388 ที่ค่อยๆ ไต่ขึ้นให้ความรู้สึกถึงสเกลมากกว่าโชว์ทันที */
function countUp(root, ms = 1400) {
  for (const el of root.querySelectorAll('b[data-to]')) {
    const to = +el.dataset.to, pre = el.dataset.pre || '';
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);        // ช้าลงตอนท้าย
      el.textContent = pre + Math.round(to * e).toLocaleString('en-US');
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }
}

function hexToRgb(h) {
  const n = parseInt((h || '#59c0ff').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

pane(ADMIN_MODE || URL_CODE || SPECTATE ? 'p-lobby' : 'p-home');
requestAnimationFrame(frame);
window.__c = { S, field, look, juice, sock, tracers, camera, serverNow };
