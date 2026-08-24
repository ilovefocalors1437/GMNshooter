// mobile-main.js — Thailand CE-7 Moonshot x GMNshooter (3D Space Flight, SFX & 3 Endings)
//
// 1. True 3D Flight Physics (Continuous Constant Speed, No Boost, WASD+Mouse on PC, 360° Joystick on Mobile)
// 2. WebAudio Sound Engine: Engine Hum Loop, Laser Blast, Hit Synth, Ship Explosion & Victory Fanfare
// 3. 3D Waypoint HUD Markers (Projected Square Markers [ ◻ ] with distance text km to Next Ring & Moon)
// 4. 3 Distinct Mission Endings:
//    - 💥 Cutscene 6.1 (HP <= 0): Spaceship Explodes, Red Screen, Disqualified
//    - ⚠️ Cutscene 6.2 (Timeout): Incomplete Trajectory, -30% Penalty
//    - 🚀 Cutscene 6.3 (Lunar Orbit): Orbit South Pole, Fanfare, +30% Bonus
// 5. 4-Act Cinematic Black Screen Opening with Thai Male Voice TTS

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
import { SpaceEnvironment } from './space-env.js';

const $ = id => document.getElementById(id);

// ── โหมดจากพารามิเตอร์ใน URL ──────────────────────────────
const QS = new URLSearchParams(location.search);
const SPECTATE = QS.get('spectate') === '1';
const ADMIN_MODE = QS.get('admin') === '1';
const URL_CODE = (QS.get('code') || '').trim().toUpperCase();
const panes = ['p-home', 'p-code', 'p-admin', 'p-name', 'p-lobby', 'p-story', 'p-sum'];
function pane(id) {
  panes.forEach(p => $(p).classList.toggle('on', p === id));
  $('hud').classList.toggle('on', id === null);
}

// ══ ระบบเสียงบรรยายภาษาไทย (Thai Male TTS) ═════════════════
function playThaiMaleTTS(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'th-TH';
    u.rate = 1.04;
    u.pitch = 0.82;

    const voices = window.speechSynthesis.getVoices();
    const thVoice = voices.find(v => (v.lang === 'th-TH' || v.lang === 'th' || v.lang.startsWith('th')) &&
      (v.name.toLowerCase().includes('male') || v.name.includes('ชาย') || v.name.includes('Niwat') || v.name.includes('Pattara') || v.name.includes('Krittipat') || v.name.includes('Wichai')));

    if (thVoice) {
      u.voice = thVoice;
    } else {
      const anyTh = voices.find(v => v.lang === 'th-TH' || v.lang === 'th' || v.lang.startsWith('th'));
      if (anyTh) u.voice = anyTh;
    }

    u.onstart = () => {
      const st = $('tts-status');
      if (st) st.textContent = 'วิทยุศูนย์บัญชาการ: กำลังถ่ายทอดคำสั่ง...';
    };
    u.onend = () => {
      const st = $('tts-status');
      if (st) st.textContent = 'วิทยุศูนย์บัญชาการ: พร้อมปฏิบัติการ';
    };

    window.speechSynthesis.speak(u);
  } catch (e) {
    console.warn('[tts] speak error:', e);
  }
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}

// ══ 4-Act Cinematic Story Timeline Lore ════════════════════
const STORY_ACTS = [
  {
    act: 1,
    badge: "🇹🇭 NARIT SPACE OPERATION CENTER // จุดเริ่มต้นประวัติศาสตร์",
    title: "โครงการ <span class='hl'>THAILAND MOONSHOT</span>",
    body: `พ.ศ. 2569 — ก้าวสำคัญทางประวัติศาสตร์ของวงการดาราศาสตร์และอวกาศไทย<br><br>
           <b>สถาบันวิจัยดาราศาสตร์แห่งชาติ (NARIT)</b> ร่วมกับนักวิทยาศาสตร์ไทย<br>
           ได้พัฒนาอุปกรณ์สัญชาติไทย <span class='hl-gold'>“CE-7 MATCH”</span> สำเร็จ<br>
           เพื่อออกเดินทางสู่ขั้วใต้ของดวงจันทร์ ไปพร้อมกับภารกิจระดับโลก <b>Chang'e-7</b>`,
    speech: "ศูนย์บัญชาการปฏิบัติการอวกาศ NARIT... นี่คือก้าวสำคัญทางประวัติศาสตร์ของประเทศไทย อุปกรณ์สำรวจดวงจันทร์ CE-7 MATCH พร้อมแล้วสำหรับการเดินทางสู่ขั้วใต้ของดวงจันทร์",
  },
  {
    act: 2,
    badge: "⚠️ TRAJECTORY WARNING // ระดับความสูง 80 - 100 KM",
    title: "วิกฤต <span class='hl-red'>พายุสะเก็ดดาวความเร็วสูง</span>",
    body: `จรวดขนส่งยักษ์ <b>Long March 5</b> กำลังนำส่งยานและอุปกรณ์ไทยข้ามผ่านชั้นบรรยากาศโลก<br><br>
           แต่ในระดับความสูง <b>80–100 กิโลเมตร</b> ระบบเรดาร์ตรวจพบกลุ่มสะเก็ดดาวจริงจากเครือข่าย <span class='hl'>Global Meteor Network (GMN)</span><br>
           พุ่งเข้าปะทะแนววิถีบินด้วยความเร็วสูงถึง <span class='hl-red'>72 กิโลเมตรต่อวินาที!</span>`,
    speech: "จรวด Long March 5 กำลังไต่ระดับความสูง... ตรวจพบกลุ่มฝนดาวตกความเร็วสูง กำลังพุ่งตัดแนววิถีบินของยาน หากเกราะพลังงานถูกทำลาย ภารกิจสู่ดวงจันทร์จะล้มเหลวทันที!",
  },
  {
    act: 3,
    badge: "🤝 OPERATION PROTOCOL // การประสานงาน 2 หน่วย",
    title: "รวมพลัง <span class='hl'>ภาคพื้นดิน & ผู้ควบคุมยาน</span>",
    body: `<div class='story-duo'>
             <div class='s-duo-card'>
               <div class='s-duo-icon'>📡</div>
               <b>GROUND CREW (ภาคพื้น)</b>
               <p>ใช้ข้อมูลกล้อง GMN ทั่วโลก เล็งยิงสแกนทำลายสะเก็ดดาวเปิดทางบิน</p>
             </div>
             <div class='s-duo-card'>
               <div class='s-duo-icon'>🚀</div>
               <b>FLIGHT OPS (คนคุมยาน)</b>
               <p>บังคับเลี้ยวทิศทางยาน บินลอดวงแหวนนำร่องสู่ดวงจันทร์ และเปิดเกราะสะท้อน</p>
             </div>
           </div>`,
    speech: "ขอให้ทีมภาคพื้นดิน ประจำสถานีเลเซอร์ ยิงสกัดกั้นสะเก็ดดาวทันที! และผู้ควบคุมยาน บังคับทิศทางยานตามเส้นทางนำร่องสู่ดวงจันทร์ให้ปลอดภัย!",
  },
  {
    act: 4,
    badge: "🚀 MISSION INITIATION // สัญญาณปล่อยตัว",
    title: "ทุกหน่วยประจำตำแหน่ง <span class='hl-gold'>เริ่มภารกิจ!</span>",
    body: `ชะตากรรมของอุปกรณ์ไทย <b>CE-7 MATCH</b> และการเดินทางสู่ดวงจันทร์...<br>
           ขึ้นอยู่กับความร่วมมือของพวกเราทุกคน!<br><br>
           <div class='launch-cd'>3 ... 2 ... 1 ... <b>LAUNCH!</b></div>`,
    speech: "ทุกหน่วยเข้าประจำตำแหน่ง... เริ่มต้นภารกิจ ณ บัดนี้!",
  }
];

let currentStoryAct = 0;
let storyTimer = null;

function renderStoryAct(idx, playVoice = true) {
  currentStoryAct = clamp(idx, 0, STORY_ACTS.length - 1);
  const act = STORY_ACTS[currentStoryAct];
  $('story-badge').innerHTML = act.badge;
  $('story-title').innerHTML = act.title;
  $('story-body').innerHTML = act.body;

  const dots = $('story-dots')?.children || [];
  for (let i = 0; i < dots.length; i++) {
    dots[i].classList.toggle('on', i === currentStoryAct);
  }

  $('story-prev').style.visibility = currentStoryAct > 0 ? 'visible' : 'hidden';
  $('story-next').textContent = currentStoryAct === STORY_ACTS.length - 1 ? 'พร้อมลุย 🚀' : 'ถัดไป ➡️';

  sfx.radioBeep();
  if (playVoice) {
    playThaiMaleTTS(act.speech);
  }
}

function startCinematicStory() {
  currentStoryAct = 0;
  pane('p-story');
  renderStoryAct(0, true);

  if (storyTimer) clearInterval(storyTimer);
  storyTimer = setInterval(() => {
    if (!S.playing || !$('p-story').classList.contains('on')) {
      clearInterval(storyTimer);
      return;
    }
    if (currentStoryAct < STORY_ACTS.length - 1) {
      renderStoryAct(currentStoryAct + 1, true);
    } else {
      clearInterval(storyTimer);
    }
  }, 3800);
}

// ══ สถานะ ═════════════════════════════════════════════════
const S = {
  token: null, slot: 0, hex: '#59c0ff', rgb: [0.35, 0.75, 1],
  code: null, name: null,
  role: 'ground', // 'ground' | 'spaceship'
  roundId: 0, startMs: 0, endMs: 0,
  schedule: [], spawned: new Set(), destroyed: new Set(), missed: new Set(),
  playing: false,
  score: 0, combo: 0, kills: 0,
  phase: 'normal', stormHits: 0, stormTotal: 0,
  stormStartSec: 40, stormPassRate: 0.55, stormMinScale: 0.6,
  offset: 0, bestRtt: Infinity,
  lastFireAt: -1e9,
  lastShieldPulseAt: -1e9,
  lastNavEmit: 0,
  lastAimEmit: 0,
  spectator: SPECTATE,
  shipHp: 200, shipMaxHp: 200,
  qteOn: false, qteNeed: 0, qteHits: 0, qteEndMs: 0, qteMeteorId: 0,

  // 3D Flight Control Inputs
  pitchInput: 0,
  yawInput: 0,
  hasReachedMoon: false,
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
  if (URL_CODE) {
    sock.emit('join_room_code', { code: URL_CODE,
      token: sessionStorage.getItem('spaceht_token'),
      pw: ADMIN_MODE ? (sessionStorage.getItem('ht_pw') || '') : undefined });
    return;
  }
  const t = sessionStorage.getItem('spaceht_token');
  const c = sessionStorage.getItem('spaceht_code');
  if (t && c) sock.emit('join_room_code', { code: c, token: t });
});

sock.on('spectating', d => {
  S.code = d.code;
  $('lobby-code').textContent = d.code;
  $('teamname').textContent = 'กำลังดู · ' + d.code;
  pane(null);
  document.body.classList.add('spectator');
});

sock.on('join_failed', d => {
  $('code-err').textContent = d.msg || 'เข้าห้องไม่ได้';
  pane('p-code');
});

sock.on('joined', d => {
  S.token = d.token; S.slot = d.slot; S.hex = d.hex; S.rgb = d.rgb;
  S.code = d.code; S.name = d.needName ? null : d.name; S.isAdmin = !!d.isAdmin;
  S.role = d.role || 'ground';
  sessionStorage.setItem('spaceht_token', d.token);
  sessionStorage.setItem('spaceht_code', d.code);
  document.documentElement.style.setProperty('--me', d.hex);
  $('lobby-code').textContent = d.code;
  $('lobby-name').textContent = S.name || '—';
  updateRoleUi();
  pane(d.needName ? 'p-name' : 'p-lobby');
  armNoSleep();
  if (ADMIN_MODE) sock.emit('admin_room_start', { pw: sessionStorage.getItem('ht_pw') || '' });
});

sock.on('name_rejected', d => { $('name-err').textContent = d.msg; });
sock.on('error_msg', d => {
  const h = $('lobby-hint');
  if (h) h.textContent = d.msg || '';
});
sock.on('name_set', d => { S.name = d.name; $('lobby-name').textContent = d.name; pane('p-lobby'); });

// ══ จัดการป้อมปืนเพื่อนร่วมทีม (Multi-Turret Sync) ═════════
const otherTurrets = new Map();

function syncTeammateTurrets(players = []) {
  for (const p of players) {
    if (p.slot === S.slot || !p.connected || p.role === 'spaceship') {
      if (otherTurrets.has(p.slot)) {
        const old = otherTurrets.get(p.slot);
        scene.remove(old.root);
        otherTurrets.delete(p.slot);
      }
      continue;
    }
    if (!otherTurrets.has(p.slot)) {
      const hex = p.hex || '#59c0ff';
      const colorNum = new THREE.Color(hex).getHex();
      const rigObj = buildTurretProcedural(colorNum);
      rigObj.root.rotation.y = Math.PI;
      rigObj.root.position.set((p.slot - 3) * 3.8, 0, -1.2);
      scene.add(rigObj.root);
      otherTurrets.set(p.slot, rigObj);

      createTurret(CFG.assets.turret, colorNum).then(loadedRig => {
        scene.remove(rigObj.root);
        loadedRig.root.rotation.y = Math.PI;
        loadedRig.root.position.set((p.slot - 3) * 3.8, 0, -1.2);
        scene.add(loadedRig.root);
        otherTurrets.set(p.slot, loadedRig);
      }).catch(() => {});
    }
  }
}

function updateRoleUi() {
  const isShip = S.role === 'spaceship';
  $('role-ground')?.classList.toggle('on', !isShip);
  $('role-spaceship')?.classList.toggle('on', isShip);
  document.body.classList.toggle('is-pilot', isShip);

  const pulseBtn = $('pulse-shield-btn');
  if (pulseBtn) pulseBtn.style.display = isShip ? 'flex' : 'none';

  if (rig && rig.root) rig.root.visible = !isShip;
}

sock.on('room', st => {
  const me = (st.players || []).find(p => p.slot === S.slot);
  if (me && !S.spectator) {
    S.role = me.role || 'ground';
    updateRoleUi();
    if (!me.named && S.name && st.state === 'lobby' && !S.playing) {
      S.name = null;
      $('lobby-name').textContent = '—';
      pane('p-name');
    } else if (me.named) {
      S.name = me.name;
      $('lobby-name').textContent = me.name;
      if (!S.playing && $('p-name').classList.contains('on')) pane('p-lobby');
    }
  }
  $('teamname').textContent = (S.role === 'spaceship' ? '🚀 [FLIGHT OPS] ' : '📡 [GROUND] ') + (S.name || '');
  const r = $('roster');
  r.innerHTML = (st.players || []).map(p => {
    const roleIcon = p.role === 'spaceship' ? '🚀' : '📡';
    const roleText = p.role === 'spaceship' ? 'PILOT' : 'GROUND';
    return `<div class="roster-item">` +
      `<div class="dot${p.connected ? ' on' : ''}" style="background:${p.hex}"></div>` +
      `<span class="roster-name">${escapeHtml(p.name || '?')}</span>` +
      `<span class="roster-role ${p.role === 'spaceship' ? 'pilot' : ''}">${roleIcon} ${roleText}</span>` +
      `</div>`;
  }).join('');
  
  const cnt = $('lobby-count');
  if (cnt) cnt.textContent = `${st.playerCount} คน`;

  syncTeammateTurrets(st.players || []);
});

sock.on('player_aim', d => {
  const r = otherTurrets.get(d.slot);
  if (r) r.aim(d.yaw, d.pitch);
});

sock.on('player_fire', d => {
  const r = otherTurrets.get(d.slot);
  if (r) {
    r.aim(d.yaw, d.pitch);
    r.fire();
  }
  if (d.from && d.to) {
    const fromV = new THREE.Vector3(...d.from);
    const toV = new THREE.Vector3(...d.to);
    tracers.spawn(fromV, toV, CFG.bullet.travelMs, d.targetId, d.hex);
  }
});

sock.on('ship_nav', d => {
  if (S.role !== 'spaceship') {
    spaceEnv.applyRemoteNavState(d);
  }
});

// ยานบินผ่าน Waypoint Ring
sock.on('nav_ring_passed', d => {
  if (d.score !== undefined) S.score = d.score;
  if (d.shipHp !== undefined) { S.shipHp = d.shipHp; S.shipMaxHp = d.shipMaxHp; paintShipHp(); }
  sfx.navRing();
  juice.shake(0.6);
  floatText.add(new THREE.Vector3(0, 3.0, -8), `+${d.bonus || 400} LUNAR WAYPOINT BONUS! 🚀`);
});

// ยานเข้าสู่วงโคจรดวงจันทร์สำเร็จ (Victory Trigger)
sock.on('lunar_orbit_reached', d => {
  S.hasReachedMoon = true;
  spaceEnv.hasReachedMoon = true;
  sfx.victoryFanfare();
  showEndingBanner('🚀 ภารกิจสำเร็จ!', 'ยานเข้าสู่วงโคจรขั้วใต้ของดวงจันทร์สำเร็จ (+30% TEAM BONUS)', '#ffe066');
});

// Energy Pulse ฟื้นฟูเกราะ
sock.on('shield_pulse', d => {
  S.shipHp = d.shipHp;
  S.shipMaxHp = d.shipMaxHp;
  paintShipHp();
  juice.shake(0.8);
  sfx.resume();
  floatText.add(new THREE.Vector3(0, 2.0, -4), `+${d.heal} HP SHIELD PULSE! 🛡️ (${escapeHtml(d.name)})`);
  document.body.classList.add('heal-flash');
  setTimeout(() => document.body.classList.remove('heal-flash'), 300);
});

// ยานโดนดาเมจ
sock.on('ship_damage', d => {
  S.shipHp = d.shipHp;
  S.shipMaxHp = d.shipMaxHp;
  paintShipHp();
  juice.shake(1.1);

  if (S.shipHp <= 0) {
    // Cutscene 6.1: ยานถูกทำลาย
    spaceEnv.triggerShipExplosion();
    sfx.shipExplosion();
    showEndingBanner('💥 ภารกิจล้มเหลว!', 'ยาน Long March 5 ถูกสะเก็ดดาวทำลายกลางอากาศ (DISQUALIFIED)', '#ff4d6d');
  } else {
    sfx.hit(1);
    const hitPos = new THREE.Vector3(0, 1.4, -4);
    floatText.add(hitPos, `-${d.dmg} เกราะยาน! (${d.speed} km/s)`);
    document.body.classList.add('hit-flash');
    setTimeout(() => document.body.classList.remove('hit-flash'), 180);
  }
});

function showEndingBanner(title, sub, color) {
  const overlay = $('ending-cutscene-overlay');
  const tEl = $('ending-title');
  const sEl = $('ending-sub');
  if (overlay && tEl && sEl) {
    tEl.textContent = title;
    tEl.style.color = color;
    sEl.textContent = sub;
    overlay.classList.add('on');
    setTimeout(() => overlay.classList.remove('on'), 3500);
  }
}

// ══ เริ่มรอบ: แสดง 4-Act Cinematic Story + เสียงพากย์ TTS ══════
sock.on('round_start', d => {
  S.stormStartSec = d.stormStartSec; S.stormPassRate = d.stormPassRate;
  S.stormMinScale = d.stormMinScale; S.phase = 'normal';
  S.stormHits = 0; S.stormTotal = 0;
  S.shipHp = d.shipHp || 200; S.shipMaxHp = d.shipMaxHp || 200;
  S.hasReachedMoon = false;
  document.body.classList.remove('storm');
  $('stormbar').style.display = 'none';
  contactLog.setStormMode(false);
  S.qteOn = false; S.qteHits = 0; S.qteNeed = 0; S.qteMeteorId = 0;
  document.body.classList.remove('qte');
  $('qtebar').style.display = 'none';
  $('ending-cutscene-overlay')?.classList.remove('on');
  S.roundId = d.roundId; S.startMs = d.startMs; S.endMs = d.endMs;
  S.schedule = d.schedule;
  S.spawned = new Set();
  S.destroyed = new Set(d.destroyed || []);
  S.missed = new Set();
  S.score = 0; S.combo = 0; S.kills = 0;
  field.active.slice().forEach(m => field.kill(m));
  tracers.reset();
  juice.reset();
  spaceEnv.resetNavRings();
  S.playing = true;

  sfx.resume();
  startCinematicStory();

  paintShipHp();
  updateRoleUi();
  syncTeammateTurrets(d.players || []);
});

sock.on('tick', d => {
  if (d.teamScore !== undefined) S.score = d.teamScore;
  else if (d.score !== undefined) S.score = d.score;
  if (d.teamCombo !== undefined) S.combo = d.teamCombo;
  else if (d.combo !== undefined) S.combo = d.combo;
  if (d.shipHp !== undefined) {
    S.shipHp = d.shipHp;
    S.shipMaxHp = d.shipMaxHp;
    paintShipHp();
    if (S.shipHp <= 0 && !spaceEnv.isDestroyed) {
      spaceEnv.triggerShipExplosion();
      sfx.shipExplosion();
    }
  }
  S.kills = d.kills;
  if (d.qteNeed !== undefined) { S.qteHits = d.qteHits; S.qteNeed = d.qteNeed; }
  if (d.phase && d.phase !== S.phase) setPhase(d.phase);
  if (d.stormTotal !== undefined) { S.stormHits = d.stormHits; S.stormTotal = d.stormTotal; }
  paintHud(d.timeLeftMs);
});

// นัดที่ยังไม่ครบ
sock.on('damaged', d => {
  const m = field.byId(d.meteorId);
  if (!m) return;
  const k = 1 - (d.done / d.need) * (1 - S.stormMinScale);
  m.dmgScale = Math.max(S.stormMinScale, k);
  juice.explode(m.position, 0.35, true, hexToRgb(d.hex));
  sfx.shoot();
});

// ══ QTE ปิดท้ายรอบ ═════════════════════════════════════════
sock.on('qte_start', d => {
  S.qteOn = true;
  S.qteNeed = d.need; S.qteHits = d.hits || 0;
  S.qteEndMs = d.endMs;
  S.phase = 'qte';
  document.body.classList.remove('storm');
  $('stormbar').style.display = 'none';
  contactLog.setStormMode(true);
  document.body.classList.add('qte');
  $('qtebar').style.display = 'block';
  paintQte();
  if (d.meteor) {
    S.qteMeteorId = d.meteor.id;
    field.spawnFromWire({ ...d.meteor, t0: d.startMs });
  }
  juice.shake(1.3);
  sfx.resume();
  $('qtebanner').classList.add('on');
  setTimeout(() => $('qtebanner').classList.remove('on'), 1800);
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
  contactLog.setStormMode(storm);
  $('stormbar').style.display = storm ? 'block' : 'none';
  if (storm) {
    juice.shake(1.0);
    $('stormbanner').classList.add('on');
    setTimeout(() => $('stormbanner').classList.remove('on'), 2200);
  }
}

// อุกกาบาตถูกยิงแตก
sock.on('destroyed', d => {
  S.destroyed.add(d.meteorId);
  if (d.teamScore !== undefined) S.score = d.teamScore;
  else if (d.score !== undefined) S.score = d.score;
  if (d.teamCombo !== undefined) S.combo = d.teamCombo;
  else if (d.combo !== undefined) S.combo = d.combo;
  if (d.shipHp !== undefined) { S.shipHp = d.shipHp; paintShipHp(); }
  if (d.stormTotal !== undefined) { S.stormHits = d.stormHits; S.stormTotal = d.stormTotal; }
  const m = field.byId(d.meteorId);
  if (m) {
    const rgb = hexToRgb(d.hex);
    juice.explode(m.position, clamp(m.size / CFG.meteor.sizeMin, 0.8, 2.0), true, rgb);
    if (S.phase !== 'storm' && m.gmn) floatText.add(m.position, m.gmn.duration);
    contactLog.add(m, 'hit');
    field.kill(m);
    sfx.hit(S.combo);
    juice.shake(CFG.juice.shakeHit);
  }
});

// ══ จบรอบ: แสดงฉากจบ 3 แบบ & E-Certificate ══════════════════
sock.on('round_end', d => {
  S.playing = false;
  S.qteOn = false;
  sfx.stopEngine();
  document.body.classList.remove('storm');
  document.body.classList.remove('qte');
  $('qtebar').style.display = 'none';

  const endType = d.endingType || (d.shipHp <= 0 ? 'destroyed' : (d.arrivedAtMoon ? 'victory' : 'timeout'));
  $('sum-team').textContent = d.teamName || S.code || 'ทีมผู้พิทักษ์';
  $('sum-score').textContent = (d.teamScore || S.score || 0).toLocaleString('en-US');

  let rank = d.missionRank || 'A';
  let badgeTitle = 'ภารกิจคุ้มกันยานยอดเยี่ยม';
  let badgeBorder = '#8fffa8';
  let badgeSub = 'THAILAND CE-7 MOONSHOT · CREW CERTIFICATE';

  if (endType === 'destroyed') {
    rank = 'F';
    badgeTitle = '💥 DEFEAT · ยานถูกทำลายกลางอากาศ (DISQUALIFIED)';
    badgeBorder = '#ff4d6d';
    badgeSub = 'คะแนนไม่ถูกบันทึกลง Leaderboard';
  } else if (endType === 'victory') {
    rank = 'S';
    badgeTitle = '🏆 VICTORY · ยานเข้าสู่วงโคจรขั้วใต้ดวงจันทร์ (+30% BONUS)';
    badgeBorder = '#ffe066';
    badgeSub = 'ภารกิจประวัติศาสตร์สำเร็จสมบูรณ์แบบ';
  } else if (endType === 'timeout') {
    badgeTitle = '⚠️ INCOMPLETE · ยานไม่ถึงวงโคจรดวงจันทร์ (-30% PENALTY)';
    badgeBorder = '#59c0ff';
    badgeSub = 'ภารกิจขาดระยะทางเข้าสู่วงโคจร';
  }

  $('sum-kills').innerHTML =
    `<div class="cert-badge" style="border-color:${badgeBorder}; color:${badgeBorder}">` +
    `<span class="cert-rank">${rank}</span>` +
    `<div class="cert-title">${badgeTitle}</div>` +
    `<div class="cert-sub">${badgeSub}</div>` +
    `</div>` +
    `<div style="margin-top:1.2vh;font-size:calc(3.4*var(--u));">` +
    `ทีมสอยได้ทั้งหมด <b>${d.teamKills || d.kills || 0}</b> ดวง · เกราะยาน <b>${d.shipHp || 0}/200 HP</b>` +
    (d.teamRank ? ` · อันดับบอร์ด <b>#${d.teamRank}</b>` : '') +
    `</div>`;

  const sb = $('sum-board');
  if (sb) {
    sb.innerHTML = (d.results || []).map((r, n) => {
      const isPilot = r.role === 'spaceship';
      return `<div class="s-row">` +
        `<div class="nm">${n + 1}. ${escapeHtml(r.name || '?')} ` +
        `<span class="tag ${isPilot ? 'pilot-tag' : ''}">${isPilot ? '🚀 PILOT' : '📡 GROUND'}</span></div>` +
        `<div class="ct">${r.kills || 0} ดวง (Combo ×${r.bestCombo || 1})</div></div>`;
    }).join('');
  }

  const rows = contactLog.catches();
  $('sum-list').innerHTML = rows.length
    ? rows.map(r =>
        `<div class="s-row">` +
        `<div class="nm">${escapeHtml(r.shower)}` +
        `${r.cam ? `<div class="cam">กล้องที่บันทึกไว้: ${escapeHtml(r.cam)}</div>` : ''}</div>` +
        `<div class="n">${r.n}<i>ดวง</i></div></div>`).join('')
    : '<div class="s-empty">รอบนี้ยังไม่ได้สักดวง ลองใหม่อีกรอบ</div>';

  $('sum-nums').innerHTML =
    `<div class="sc"><span>สถานะอุปกรณ์ไทย CE-7 MATCH</span><b style="color:${d.shipHp > 0 ? '#8fffa8' : '#ff4d6d'}">${d.ce7Status || 'ONLINE'} 🇹🇭</b></div>` +
    `<div class="sc"><span>อุกกาบาตจริงในฐานข้อมูล</span><b data-to="${d.gmnTotal || 0}">0</b></div>` +
    `<div class="sc"><span>กล้องเครือข่าย GMN ทั่วโลก</span><b data-to="${d.gmnCameras}" data-pre="~">0</b></div>`;
  countUp($('sum-nums'));

  pane('p-sum');
  if (ADMIN_MODE) {
    $('again').style.display = 'none';
    $('to-admin').style.display = 'block';
  }
  if (S.spectator) setTimeout(() => { pane(null); }, 14000);
});

// ══ UI Events ═════════════════════════════════════════════
$('code-go').onclick = () => {
  const c = $('code').value.trim().toUpperCase();
  $('code-err').textContent = '';
  sock.emit('join_room_code', { code: c, token: sessionStorage.getItem('spaceht_token') });
};
if (URL_CODE && $('code')) $('code').value = URL_CODE;
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('code-go').click(); });

$('go-player').onclick = () => { $('code-err').textContent = ''; pane('p-code'); $('code').focus(); };
$('go-admin').onclick  = () => { $('apw-err').textContent = '';  pane('p-admin'); };
$('code-back').onclick = () => pane('p-home');
$('apw-back').onclick  = () => pane('p-home');
$('to-admin').onclick  = () => { location.href = '/admin'; };

$('apw-go').onclick = () => sock.emit('admin_login', { pw: $('apw').value });
$('apw').addEventListener('keydown', e => { if (e.key === 'Enter') $('apw-go').click(); });
sock.on('admin_login', d => {
  if (d.ok) {
    sessionStorage.setItem('ht_pw', $('apw').value);
    location.href = '/admin';
  } else {
    $('apw-err').textContent = 'รหัสผ่านไม่ถูก';
  }
});

$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('name-go').click(); });
$('name-go').onclick = () => {
  $('name-err').textContent = '';
  sock.emit('set_name', { name: $('name').value });
};

$('role-ground').onclick = () => { sock.emit('select_role', { role: 'ground' }); };
$('role-spaceship').onclick = () => { sock.emit('select_role', { role: 'spaceship' }); };

$('story-prev').onclick = () => {
  if (currentStoryAct > 0) renderStoryAct(currentStoryAct - 1, true);
};
$('story-next').onclick = () => {
  if (currentStoryAct < STORY_ACTS.length - 1) {
    renderStoryAct(currentStoryAct + 1, true);
  } else {
    $('skip-story').click();
  }
};
$('skip-story').onclick = () => {
  if (storyTimer) clearInterval(storyTimer);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  pane(null);
};

// สกิล Pulse Shield ของคนคุมยาน
$('pulse-shield-btn').onclick = () => {
  const now = performance.now();
  if (now - S.lastShieldPulseAt < 8000) {
    floatText.add(new THREE.Vector3(0, 1.0, -3), 'SHIELD COOLDOWN...');
    return;
  }
  S.lastShieldPulseAt = now;
  sock.emit('pulse_shield', {});
};

// ══ Virtual 3D Flight Stick สำหรับคนคุมยาน ════════════════════
const stickZone = $('flight-stick-zone');
const stickThumb = $('flight-stick-thumb');
let stickActive = false, stickCenter = { x: 0, y: 0 };

if (stickZone && stickThumb) {
  function handleStick(clientX, clientY) {
    const dx = clientX - stickCenter.x;
    const dy = clientY - stickCenter.y;
    const maxR = 50.0;
    const len = Math.hypot(dx, dy);
    const clampedR = Math.min(maxR, len);
    const ang = Math.atan2(dy, dx);
    const nx = (Math.cos(ang) * clampedR) / maxR;
    const ny = (Math.sin(ang) * clampedR) / maxR;

    S.yawInput = nx;
    S.pitchInput = -ny; // ลากขึ้น = เชิดหัว / ลากลง = กดหัว

    stickThumb.style.transform = `translate(${nx * maxR}px, ${ny * maxR}px)`;
  }

  stickZone.addEventListener('touchstart', e => {
    stickActive = true;
    const rect = stickZone.getBoundingClientRect();
    stickCenter.x = rect.left + rect.width / 2;
    stickCenter.y = rect.top + rect.height / 2;
    handleStick(e.touches[0].clientX, e.touches[0].clientY);
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    if (!stickActive) return;
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i];
      if (Math.hypot(t.clientX - stickCenter.x, t.clientY - stickCenter.y) < 160) {
        handleStick(t.clientX, t.clientY);
        break;
      }
    }
  }, { passive: false });

  ['touchend', 'touchcancel'].forEach(ev => window.addEventListener(ev, () => {
    if (!stickActive) return;
    stickActive = false;
    S.yawInput = 0;
    S.pitchInput = 0;
    stickThumb.style.transform = 'translate(0px, 0px)';
  }));
}

// ══ PC / Desktop 3D Flight Controls (Keyboard WASD + Mouse) ════
const keys = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', e => {
  if (S.role !== 'spaceship') return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft') keys.a = true;
  if (k === 'd' || k === 'arrowright') keys.d = true;
  if (k === 'w' || k === 'arrowup') keys.w = true;
  if (k === 's' || k === 'arrowdown') keys.s = true;
});
window.addEventListener('keyup', e => {
  if (S.role !== 'spaceship') return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft') keys.a = false;
  if (k === 'd' || k === 'arrowright') keys.d = false;
  if (k === 'w' || k === 'arrowup') keys.w = false;
  if (k === 's' || k === 'arrowdown') keys.s = false;
});

let mouseYaw = 0, mousePitch = 0;
window.addEventListener('mousemove', e => {
  if (S.role !== 'spaceship' || !S.playing || !look.locked) return;
  mouseYaw = clamp(e.movementX * 0.08, -1.0, 1.0);
  mousePitch = clamp(-e.movementY * 0.08, -1.0, 1.0);
});

$('again').onclick = () => pane('p-lobby');

// ══ กันจอดับ ══════════════════════════════════════════════
let noSleep = null, armed = false;
try { noSleep = new window.NoSleep(); } catch (e) {}
function armNoSleep() {
  if (armed || !noSleep) return;
  armed = true;
  try {
    const p = noSleep.enable();
    if (p && p.catch) p.catch(() => { armed = false; });
  } catch (e) { armed = false; }
}
document.addEventListener('touchend', armNoSleep);
document.addEventListener('click', armNoSleep);

// ══ ฉาก Three.js ═════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.perf.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
$('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(buildSky());
scene.add(buildCity());
scene.add(buildArcMarkers());
scene.add(new THREE.HemisphereLight(0x35509a, 0x05070d, 1.2));
const moonLight = new THREE.DirectionalLight(0xa8c4ff, 1.8);
moonLight.position.set(-280, 520, -1100);
scene.add(moonLight);

const camera = new THREE.PerspectiveCamera(
  CFG.camera.fov, window.innerWidth / window.innerHeight, CFG.camera.near, CFG.camera.far);
camera.rotation.order = 'YXZ';

const juice = new Juice(scene, camera);
const field = new MeteorField(scene, camera);
field.networked = true;
field.load();
const sfx = new Sfx();
const contactLog = new ContactLog(document.getElementById('cardlist'));
const floatText = new FloatText(camera);
const spaceEnv = new SpaceEnvironment(scene);

let rig = buildTurretProcedural(0x59c0ff);
rig.root.rotation.y = Math.PI;
scene.add(rig.root);
createTurret(CFG.assets.turret, 0x59c0ff).then(r => {
  scene.remove(rig.root);
  rig = r; rig.root.rotation.y = Math.PI; scene.add(rig.root);
  if (S.role === 'spaceship') rig.root.visible = false;
}).catch(() => {});

const look = new TouchLook($('scene'));

const DESKTOP = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
if (DESKTOP) {
  document.body.classList.add('desktop', 'unlocked');
  look.onLockChange = (on) => document.body.classList.toggle('unlocked', !on);
}

function sizeCross() {
  const half = Math.tan(CFG.camera.fov * DEG / 2);
  const px = (Math.tan(CFG.assist.lockOnDeg * DEG) / half) * window.innerHeight;
  const el = $('cross');
  el.style.width = px + 'px';
  el.style.height = px + 'px';
}
sizeCross();

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
  spawn(from, to, durMs, targetId, customHex) {
    const it = this.items.find(i => !i.active) || this.items[0];
    it.start.copy(from); it.dir.copy(to).sub(from);
    it.dist = it.dir.length();
    if (it.dist < 0.001) return null;
    it.dir.divideScalar(it.dist);
    it.mesh.quaternion.setFromUnitVectors(this._up, it.dir);
    it.t = 0; it.dur = durMs; it.active = true; it.mesh.visible = true;
    it.targetId = targetId || 0;
    if (customHex) {
      it.mesh.material.color.set(customHex);
    } else {
      it.mesh.material.color.set(CFG.bullet.color);
    }
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
const _aim = new THREE.Vector3(), _end = new THREE.Vector3();

function fire() {
  if (S.spectator || !S.playing) return;
  const t = serverNow();
  if (t - S.lastFireAt < CFG.bullet.fireCooldownMs) return;
  S.lastFireAt = t;

  if (S.role === 'ground') {
    rig.fire();
    sfx.shoot();
  } else {
    sfx.laserBlast();
  }
  juice.shake(CFG.juice.shakeFire);
  if (S.qteOn) { sock.emit('qte_tap', {}); } else { sock.emit('shot', {}); }

  rig.getMuzzle(_mp, _md);
  const { target } = pickTarget();

  let spawnPos = _mp;
  if (S.role === 'spaceship' && spaceEnv && spaceEnv.rocket) {
    spawnPos = spaceEnv.rocket.position.clone();
  }

  if (target) {
    field.predict(target, t, CFG.bullet.travelMs, _end);
    const shot = tracers.spawn(spawnPos, _end, CFG.bullet.travelMs, target.id, S.hex);
    if (shot) shot.fireT = t;
    sock.emit('player_fire', { targetId: target.id, from: spawnPos.toArray(), to: _end.toArray(), yaw: look.yaw, pitch: look.pitch });
  } else {
    dirFrom(look.yaw, look.pitch, _aim);
    _end.copy(spawnPos).addScaledVector(_aim, CFG.bullet.missSpeed * CFG.bullet.missMs * .001);
    tracers.spawn(spawnPos, _end, CFG.bullet.missMs, 0, S.hex);
    sock.emit('player_fire', { targetId: 0, from: spawnPos.toArray(), to: _end.toArray(), yaw: look.yaw, pitch: look.pitch });
  }
}

function onArrive(it, pos) {
  if (!it.targetId || !S.playing || S.qteOn) return;
  if (S.destroyed.has(it.targetId)) return;
  if (!field.byId(it.targetId)) return;
  sock.emit('kill', { meteorId: it.targetId });
}

// ปุ่มยิง
const fb = $('fire');
let holding = false;
function holdLoop() {
  if (!holding) return;
  fire();
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
window.addEventListener('mouseup', () => { holding = false; });

window.addEventListener('mousedown', (e) => {
  if (!look.locked || e.button !== 0) return;
  holding = true; holdLoop();
});
window.addEventListener('mouseup', () => { holding = false; });

// ══ คุณภาพอัตโนมัติ ════════════════════════════════════════
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
    renderer.setPixelRatio(CFG.quality.lowPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    CFG.explosion.particles = Math.round(CFG.explosion.particles * CFG.quality.lowParticleScale);
    if (CFG.quality.lowDisableLights) {
      juice.lights.forEach(l => { l.light.visible = false; });
      if (rig && rig.light) rig.light.visible = false;
    }
  }
}

// ══ 3D Waypoint Projection Markers บน HUD ═════════════════
const _vProj = new THREE.Vector3();
function updateWaypointMarkers() {
  const layer = $('waypoint-markers-layer');
  if (!layer || S.role !== 'spaceship') return;

  const r = spaceEnv.getNextActiveRing();
  let html = '';

  // 1. Next Waypoint Ring Marker
  if (r) {
    _vProj.copy(r.pos).project(camera);
    if (_vProj.z < 1.0) { // อยู่ด้านหน้ากล้อง
      const x = (_vProj.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-(_vProj.y * 0.5) + 0.5) * window.innerHeight;
      const dist = Math.round(spaceEnv.flightPos.distanceTo(r.pos) * 12);
      html += `<div class="wp-marker" style="left:${x}px; top:${y}px;">` +
        `<div class="wp-box"></div>` +
        `<div class="wp-text">◻ RING #${r.id} · ${dist.toLocaleString()} km</div>` +
        `</div>`;
    }
  }

  // 2. Moon Marker
  _vProj.copy(spaceEnv.moonTargetPos).project(camera);
  if (_vProj.z < 1.0) {
    const x = (_vProj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-(_vProj.y * 0.5) + 0.5) * window.innerHeight;
    html += `<div class="wp-marker moon-target" style="left:${x}px; top:${y}px;">` +
      `<div class="wp-box"></div>` +
      `<div class="wp-text">🌕 MOON · ${Math.round(spaceEnv.distToMoonKm).toLocaleString()} km</div>` +
      `</div>`;
  }

  layer.innerHTML = html;
}

// ══ HUD Painting ══════════════════════════════════════════
function paintShipHp() {
  const hpEl = $('ship-hp-num');
  const barEl = $('ship-hp-fill');
  const altEl = $('ship-alt-num');
  if (!hpEl || !barEl) return;

  const pct = Math.max(0, Math.min(100, (S.shipHp / S.shipMaxHp) * 100));
  hpEl.textContent = `${S.shipHp} / ${S.shipMaxHp} HP`;
  barEl.style.width = pct + '%';

  const isEmergency = S.shipHp <= 0;
  barEl.classList.toggle('emergency', isEmergency);
  document.body.classList.toggle('emergency-mode', isEmergency);

  if (altEl && spaceEnv) {
    altEl.textContent = spaceEnv.rocketAltKm >= 1000
      ? `${(spaceEnv.rocketAltKm / 1000).toFixed(0)}k km (Moon Orbit)`
      : `${spaceEnv.rocketAltKm.toFixed(0)} km`;
  }

  if (S.role === 'spaceship' && spaceEnv) {
    const distEl = $('pnd-moon-dist');
    const spdEl = $('pnd-flight-speed');
    const ringsEl = $('pnd-rings-passed');
    if (distEl) distEl.textContent = `${Math.round(spaceEnv.distToMoonKm).toLocaleString('en-US')} KM`;
    if (spdEl) spdEl.textContent = `${spaceEnv.flightSpeedKmS.toFixed(1)} KM/S`;
    if (ringsEl) ringsEl.textContent = `${spaceEnv.passedRings.size} / ${spaceEnv.navRings.length} RINGS`;
  }
}

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
  c.textContent = `TEAM COMBO ×${S.combo}`;
  c.classList.toggle('on', S.combo >= 2);
  paintShipHp();
}

// ══ Loop ══════════════════════════════════════════════════
let last = performance.now();
const burnedOutBuffer = [];

function frame(nowReal) {
  requestAnimationFrame(frame);
  const dt = Math.min((nowReal - last) * .001, CFG.perf.maxDt);
  last = nowReal;
  probeQuality(nowReal);

  const t = serverNow();

  // Story Briefing / Countdown Transition
  if (S.playing && t < S.startMs) {
    const left = Math.max(1, Math.ceil((S.startMs - t) / 1000));
    $('countdown').textContent = left;
  } else if (S.playing && $('p-story').classList.contains('on')) {
    if (storyTimer) clearInterval(storyTimer);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    pane(null);
    if (S.role === 'spaceship') sfx.startEngine();
  }

  // เดินตารางอุกกาบาต
  if (S.playing && t >= S.startMs) {
    for (const w of S.schedule) {
      if (S.spawned.has(w.id)) continue;
      const abs = S.startMs + w.t0;
      if (t < abs) break;
      S.spawned.add(w.id);
      if (S.destroyed.has(w.id)) continue;
      field.spawnFromWire({ ...w, t0: abs });
    }
  }

  // ══ 3D Flight Physics Controls (สำหรับคนคุมยาน) ════════════
  if (S.role === 'spaceship') {
    let pIn = S.pitchInput;
    let yIn = S.yawInput;

    if (keys.w) pIn += 1.0;
    if (keys.s) pIn -= 1.0;
    if (keys.a) yIn -= 1.0;
    if (keys.d) yIn += 1.0;

    pIn += mousePitch;
    yIn += mouseYaw;
    mousePitch = 0;
    mouseYaw = 0;

    spaceEnv.setSteerInput(pIn, yIn);
    sfx.updateEngine(yIn);

    if (S.playing && !spaceEnv.isDestroyed) {
      spaceEnv.checkNavRingPassed(ring => {
        sock.emit('nav_waypoint', { ringId: ring.id });
      });

      if (spaceEnv.hasReachedMoon && !S.hasReachedMoon) {
        S.hasReachedMoon = true;
        sock.emit('lunar_orbit_reached', {});
      }
    }

    spaceEnv.updateFlightCamera(camera, dt);
    updateWaypointMarkers();

    if (S.playing && (nowReal - S.lastNavEmit > 50)) {
      S.lastNavEmit = nowReal;
      sock.emit('ship_nav', spaceEnv.getNavState());
    }
  } else {
    look.update(dt);
    camera.position.set(
      Math.sin(look.yaw) * CFG.camera.eye.z, CFG.camera.eye.y,
      Math.cos(look.yaw) * CFG.camera.eye.z);
    const sh = juice.shakeOffset;
    camera.rotation.set(look.pitch + sh.pitch, look.yaw + sh.yaw, sh.roll, 'YXZ');

    rig.aim(look.yaw, look.pitch);
    rig.update(dt);

    if (S.playing && (nowReal - S.lastAimEmit > 50)) {
      S.lastAimEmit = nowReal;
      sock.emit('player_aim', { yaw: look.yaw, pitch: look.pitch });
    }
  }

  otherTurrets.forEach(r => r.update(dt));

  field.update(t, burnedOutBuffer);
  for (const bm of burnedOutBuffer) {
    if (!S.destroyed.has(bm.id) && !S.missed.has(bm.id)) {
      S.missed.add(bm.id);
      sock.emit('miss', { meteorId: bm.id });
    }
  }

  tracers.update(dt, onArrive);
  juice.update(dt, dt);
  contactLog.update(dt);
  floatText.update(dt);

  const elapsedSec = (t - S.startMs) * 0.001;
  const qteRate = S.qteNeed ? Math.min(1.0, S.qteHits / S.qteNeed) : 0;
  spaceEnv.update(dt, elapsedSec, S.phase, qteRate, S.role === 'spaceship');

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
  sizeCross();
});

function countUp(root, ms = 1400) {
  for (const el of root.querySelectorAll('b[data-to]')) {
    const to = +el.dataset.to, pre = el.dataset.pre || '';
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
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
window.__c = { S, field, look, juice, sock, tracers, camera, serverNow, spaceEnv, sfx };
