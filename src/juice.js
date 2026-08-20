// juice.js — hitstop / screenshake / particle / flash
//
// spec §9: "ถ้ายิงแล้วไม่สะใจตอนมีอุกกาบาตดวงเดียว ใส่ข้อมูล NASA อีกพันดวงก็ไม่ช่วย"
//
// Hitstop ทำงานยังไง: freeze ทั้งฉากด้วยการส่ง dt = 0 ให้ระบบอื่นทุกตัว
// เวลาในเกม (gameTime) ก็หยุดตาม → อุกกาบาตหยุดกลางอากาศจริงๆ ไม่ใช่แค่หยุดวาด
// ส่วนแฟลชขาวยังเดินด้วย realDt เพราะต้องกระพริบ *ระหว่าง* freeze ถึงจะรู้สึก
//
// ทุกอย่างในนี้ pool หมด — ไม่มี new Mesh / new Vector3 ใน hot path

import * as THREE from 'three';
import { CFG, clamp } from './config.js';

const _v = new THREE.Vector3();
const ZERO_SHAKE = Object.freeze({ trauma: 0, yaw: 0, pitch: 0, roll: 0 });

function _overlay(id, css) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText =
      `position:fixed;inset:0;z-index:6;pointer-events:none;opacity:0;${css}`;
    document.body.appendChild(el);
  }
  return el;
}

export class Juice {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    this.hitstopMs = 0;
    this.trauma = 0;
    this.shakeOffset = { yaw: 0, pitch: 0, roll: 0 };
    this._t = 0;

    // Phase B: สั่นเฉพาะ viewport ของคนที่ยิงโดน ไม่ใช่ทั้งจอ (spec §6)
    // ถ้าสั่นทั้งจอ คนที่ไม่ได้ยิงจะโดนกระชากกล้องมั่วไปด้วย เล็งไม่ได้เลย
    // slot 0 = โหมดคนเดียวของ Phase A (main.js ยังใช้ this.shakeOffset ตรงๆ ได้เหมือนเดิม)
    this._slotShake = new Map();

    // สร้างเองถ้าหน้านั้นไม่มี — juice ต้องใช้ได้ทุกหน้าโดยไม่ผูกกับ HTML ใดหน้าหนึ่ง
    // (play.html ของ Phase C ไม่มี 2 อันนี้ แล้วมันไปเรียก .style ของ null ทุกเฟรม)
    this.flashEl = _overlay('flash', 'background:#fff;mix-blend-mode:screen');
    this.damageEl = _overlay('damage',
      'background:radial-gradient(ellipse at center,transparent 42%,rgba(255,40,70,.85) 100%)');
    this._flash = 0; this._flashDur = 1; this._flashPeak = 1;
    this._dmg = 0;

    this._initParticles();
    this._initFireballs();
    this._initLights();
  }

  // ══ hitstop ═══════════════════════════════════════════════
  /** เรียกต้น frame — คืน dt ที่ระบบอื่นควรใช้ (0 = กำลัง freeze) */
  beginFrame(realDt) {
    if (this.hitstopMs > 0) {
      this.hitstopMs -= realDt * 1000;
      return 0;
    }
    return realDt;
  }

  freeze(ms) { this.hitstopMs = Math.max(this.hitstopMs, ms); }

  // ══ screenshake ═══════════════════════════════════════════
  /** @param slot ไม่ใส่ = สั่นตัวกลาง (โหมดคนเดียว) / ใส่ = สั่นเฉพาะช่องนั้น */
  shake(amount, slot) {
    if (slot === undefined || slot === null) {
      this.trauma = Math.min(1, this.trauma + amount);
      return;
    }
    let e = this._slotShake.get(slot);
    if (!e) { e = { trauma: 0, yaw: 0, pitch: 0, roll: 0 }; this._slotShake.set(slot, e); }
    e.trauma = Math.min(1, e.trauma + amount);
  }

  /** offset ของช่องนั้น — ถ้าไม่เคยสั่นเลยคืนศูนย์ */
  shakeFor(slot) {
    return this._slotShake.get(slot) || ZERO_SHAKE;
  }

  // ══ flash เต็มจอ ══════════════════════════════════════════
  flash(ms, peak = 1) {
    this._flash = ms; this._flashDur = ms; this._flashPeak = peak;
  }

  damageVignette() { this._dmg = CFG.juice.damageVignetteMs; }

  // ══ ระเบิด — particle + flash + light + scale punch พร้อมกัน ══
  //
  // สเกลตามระยะ: ระเบิดที่ 400 ม. ถ้าใช้ขนาดเท่ากับที่ 100 ม. จะเหลือแค่ประกายจิ๋ว
  // ผูกขนาดกับระยะแทน → ระเบิดกินพื้นที่จอเท่าเดิมเสมอ ไม่ว่าเป้าจะไกลแค่ไหน
  // (ผิดฟิสิกส์ แต่นี่คือเกม เด็กต้องรู้สึกว่า "ระเบิด" เท่ากันทุกนัด)
  /**
   * @param rgb  Phase B: สีของคนที่ยิงโดน — เห็นได้ทุก viewport ว่าใครได้ไป (spec §6)
   */
  explode(pos, scale = 1, hot = true, rgb = null) {
    const E = CFG.explosion;
    // Phase B มีกล้อง 3 ตัว ไม่มีตัวไหนเป็น "ตัวจริง" — วัดจากศูนย์กลางซุ้มแทน
    // (ป้อมทั้ง 3 ห่างกันแค่ 11 ม. เทียบกับเป้าที่ 100-600 ม. ถือว่าเท่ากัน)
    const dist = this.camera ? pos.distanceTo(this.camera.position) : pos.length();
    const k = scale * clamp(dist / E.refDistance, E.distScaleMin, E.distScaleMax);
    this._spawnParticles(pos, Math.round(E.particles * scale), k, hot, rgb);
    this._spawnFireball(pos, k);
    this._spawnLight(pos, k, hot, rgb);
  }

  // ══ update ════════════════════════════════════════════════
  update(dt, realDt) {
    this._t += realDt;

    // trauma หายแบบเชิงเส้น แต่แรงสั่นเป็น trauma² → หางเบาลงเนียน
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - CFG.juice.shakeDecay * realDt);
      const J = CFG.juice;
      const a = J.shakeMaxAngle * this.trauma * this.trauma;
      const f = J.shakeFreq, t = this._t;
      this.shakeOffset.yaw = a * Math.sin(t * f * 1.00 + 1.3);
      this.shakeOffset.pitch = a * Math.sin(t * f * 1.31 + 4.7) * 0.85;
      this.shakeOffset.roll = a * Math.sin(t * f * 0.77 + 2.1) * 0.55;
    } else {
      this.shakeOffset.yaw = this.shakeOffset.pitch = this.shakeOffset.roll = 0;
    }

    // แฟลช/vignette เดินด้วย realDt — ต้องเห็นระหว่าง hitstop
    if (this._flash > 0) {
      this._flash -= realDt * 1000;
      const k = Math.max(0, this._flash / this._flashDur);
      this.flashEl.style.opacity = (k * k * this._flashPeak).toFixed(3);
    } else if (this.flashEl.style.opacity !== '0') {
      this.flashEl.style.opacity = '0';
    }

    if (this._dmg > 0) {
      this._dmg -= realDt * 1000;
      const k = Math.max(0, this._dmg / CFG.juice.damageVignetteMs);
      this.damageEl.style.opacity = (k * 0.9).toFixed(3);
    } else if (this.damageEl.style.opacity !== '0') {
      this.damageEl.style.opacity = '0';
    }

    this._updateParticles(dt);
    this._updateFireballs(dt);
    this._updateLights(dt);
  }

  reset() {
    this.hitstopMs = 0; this.trauma = 0;
    this._flash = 0; this._dmg = 0;
    this.pCount = 0;
    for (const f of this.fireballs) { f.life = 0; f.sprite.visible = false; }
    for (const l of this.lights) { l.life = 0; l.light.intensity = 0; }
  }

  // ══════════════════════════════════════════════════════════
  // particles — Points ก้อนเดียว pool คงที่ ไม่ alloc ระหว่างเล่น
  // ══════════════════════════════════════════════════════════
  _initParticles() {
    const N = CFG.explosion.particlePool;
    this.pN = N; this.pCount = 0;

    this.pPos = new Float32Array(N * 3);
    this.pCol = new Float32Array(N * 3);
    this.pSize = new Float32Array(N);
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    this.pMax = new Float32Array(N);
    this.pGrav = new Float32Array(N);       // ต่อเม็ด — ระเบิดไกลสเกลใหญ่ต้องใช้ g ใหญ่ตาม
    this.pBase = new Float32Array(N * 3);   // สีตั้งต้น ใช้คูณกับ life ตอน fade

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    g.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      vertexShader: `
        attribute float aSize;
        attribute vec3 aColor;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (260.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = 1.0 - smoothstep(0.12, 0.5, d);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(vColor * a, a);
        }`,
    });

    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
  }

  _spawnParticles(pos, count, scale, hot, rgb = null) {
    const E = CFG.explosion;
    for (let k = 0; k < count; k++) {
      const i = this.pCount < this.pN ? this.pCount++ : Math.floor(Math.random() * this.pN);

      // ทิศสุ่มบนทรงกลม
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const sp = (E.speedMin + Math.random() * (E.speedMax - E.speedMin)) * scale;

      this.pPos[i * 3] = pos.x; this.pPos[i * 3 + 1] = pos.y; this.pPos[i * 3 + 2] = pos.z;
      this.pVel[i * 3] = Math.cos(th) * r * sp;
      this.pVel[i * 3 + 1] = u * sp + sp * 0.25;
      this.pVel[i * 3 + 2] = Math.sin(th) * r * sp;

      const life = E.lifeMs * 0.001 * (0.55 + Math.random() * 0.65);
      this.pLife[i] = life; this.pMax[i] = life;
      this.pSize[i] = E.sizeStart * scale * (0.45 + Math.random() * 0.9);
      this.pGrav[i] = E.gravity * scale;

      // ร้อน = ขาว→ส้ม (ยิงโดน), เย็น = ฟ้า (เมืองโดน) จะได้แยกออกทันทีว่าเกิดอะไร
      const t = Math.random();
      if (hot) {
        this.pBase[i * 3] = 1.0; this.pBase[i * 3 + 1] = 0.55 + t * 0.45; this.pBase[i * 3 + 2] = 0.18 + t * 0.5;
      } else {
        this.pBase[i * 3] = 1.0; this.pBase[i * 3 + 1] = 0.25 + t * 0.2; this.pBase[i * 3 + 2] = 0.3 + t * 0.3;
      }
    }
  }

  _updateParticles(dt) {
    if (!this.pCount) return;
    const E = CFG.explosion;
    const drag = Math.exp(-E.drag * dt);

    for (let i = 0; i < this.pCount; i++) {
      if (this.pLife[i] <= 0) { this.pSize[i] = 0; continue; }
      this.pLife[i] -= dt;
      const k = Math.max(0, this.pLife[i] / this.pMax[i]);

      this.pVel[i * 3] *= drag;
      this.pVel[i * 3 + 1] = this.pVel[i * 3 + 1] * drag + this.pGrav[i] * dt;
      this.pVel[i * 3 + 2] *= drag;

      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;

      // additive: หรี่สี = จางหาย
      const f = k * k;
      this.pCol[i * 3] = this.pBase[i * 3] * f;
      this.pCol[i * 3 + 1] = this.pBase[i * 3 + 1] * f;
      this.pCol[i * 3 + 2] = this.pBase[i * 3 + 2] * f;
      this.pSize[i] = this.pSize[i] * (1 - dt * 0.55);
    }

    const g = this.points.geometry;
    g.setDrawRange(0, this.pCount);
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  // ══ ลูกไฟ: sprite additive + scale punch ══════════════════
  _initFireballs() {
    const tex = makeGlowTexture();
    this.fireballs = [];
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, depthTest: false,
      }));
      s.visible = false;
      s.renderOrder = 6;
      this.scene.add(s);
      this.fireballs.push({ sprite: s, life: 0, max: 1, scale: 1 });
    }
    this._fbNext = 0;
  }

  _spawnFireball(pos, scale) {
    const f = this.fireballs[this._fbNext++ % this.fireballs.length];
    f.sprite.position.copy(pos);
    f.sprite.visible = true;
    f.life = f.max = CFG.explosion.flashMs * 0.001;
    f.scale = CFG.explosion.flashScale * scale;
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
  }

  _updateFireballs(dt) {
    for (const f of this.fireballs) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / f.max);
      if (k <= 0) { f.sprite.visible = false; continue; }
      // punch: พุ่งขึ้นเร็วมากใน 15% แรก แล้วยุบ
      const grow = k > 0.85 ? (1 - k) / 0.15 : 1;
      f.sprite.scale.setScalar(f.scale * grow * (0.35 + k * 0.9));
      f.sprite.material.opacity = k;
    }
  }

  // ══ PointLight 2 frame — ถูกมาก ผลเยอะสุด (ฉากวาบตาม) ════
  _initLights() {
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffb066, 0, CFG.explosion.lightDistance, 2);
      this.scene.add(l);
      this.lights.push({ light: l, life: 0, max: 1, peak: 0 });
    }
    this._liNext = 0;
  }

  _spawnLight(pos, scale, hot) {
    const e = this.lights[this._liNext++ % this.lights.length];
    e.light.position.copy(pos);
    e.light.color.setHex(hot ? 0xffb066 : 0xff5070);
    e.peak = CFG.explosion.lightIntensity * scale;
    e.life = e.max = CFG.explosion.lightMs * 0.001;
  }

  _updateLights(dt) {
    for (const e of this.lights) {
      if (e.life <= 0) { if (e.light.intensity) e.light.intensity = 0; continue; }
      e.life -= dt;
      const k = Math.max(0, e.life / e.max);
      e.light.intensity = e.peak * k * k;
    }
  }
}

// texture ลูกไฟ — วาดเอง ไม่ต้องหาไฟล์ (meteors.js ยืมไปใช้ทำลูกเรืองแสงด้วย)
export function makeGlowTexture(size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,238,190,0.95)');
  grad.addColorStop(0.45, 'rgba(255,150,50,0.45)');
  grad.addColorStop(1.00, 'rgba(255,90,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
