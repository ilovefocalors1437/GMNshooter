// city.js — skyline ระดับ A
//
// ไม่มี asset ไม่มี texture ไม่ต้องโหลดอะไร: ฟันปลาสุ่มความสูงรอบตัว 360°
// merge เป็น geometry ก้อนเดียว → 1 draw call
//
// *** interface ต้องเป็นแบบนี้ ***  เพื่อให้ Phase C สลับไปใช้ OSM กรุงเทพ
// ได้โดยไม่ต้องแตะไฟล์อื่นเลย — แค่เขียน buildCity() ใหม่ให้คืน Mesh ก้อนเดียวเหมือนกัน
//
//     export function buildCity(opts) → THREE.Mesh
//
// ระยะดูจริงคือ 3 เมตรจากโปรเจกเตอร์ — silhouette พอ อย่าทำตึก 3D ละเอียด

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CFG, DEG } from './config.js';

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * @param {object} opts  override CFG.city ได้ทีละตัว
 * @returns {THREE.Mesh} merged ก้อนเดียว วัสดุใช้ vertexColors เลยไล่เฉดได้โดยไม่เพิ่ม draw call
 */
export function buildCity(opts = {}) {
  const C = { ...CFG.city, ...opts };
  const parts = [];

  // ── พื้น: จานดำล้วน ให้ขอบฟ้าไม่โหว่ ──
  const ground = new THREE.CircleGeometry(C.groundRadius, 48);
  ground.rotateX(-Math.PI / 2);
  paint(ground, 0.0035, 0.0042, 0.0075);
  parts.push(ground);

  // ── ตึก: กล่องรอบวง สุ่มความสูง/ความกว้าง/ระยะ ──
  for (let i = 0; i < C.segments; i++) {
    const a = (i / C.segments) * Math.PI * 2 + rand(-0.006, 0.006);
    const r = C.radius + rand(-C.jitter, C.jitter);
    const h = rand(C.heightMin, C.heightMax);
    const w = rand(C.widthMin, C.widthMax);

    const g = new THREE.BoxGeometry(w, h, C.depth);
    // ยอดตึกสว่างกว่าโคนนิดนึง — ตัดกับท้องฟ้าให้เห็นเส้นขอบฟ้าชัดจากระยะ 3 เมตร
    paintGradient(g, h);
    g.rotateY(a);
    g.translate(-Math.sin(a) * r, h / 2, -Math.cos(a) * r);
    parts.push(g);

    // ตึกเตี้ยซ้อนหน้า ทำให้ขอบฟ้าไม่แบน
    if (Math.random() < 0.45) {
      const h2 = h * rand(0.25, 0.6);
      const g2 = new THREE.BoxGeometry(w * rand(0.5, 0.9), h2, C.depth * 0.6);
      paintGradient(g2, h2);
      g2.rotateY(a);
      g2.translate(-Math.sin(a) * (r - 16), h2 / 2, -Math.cos(a) * (r - 16));
      parts.push(g2);
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();

  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.name = 'City';
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * หมุดกลางซุ้ม — "วัตถุในฉาก ไม่ใช่ UI" (spec §8)
 * มนุษย์ต้องการจุดอ้างอิงในภาพ ไม่ใช่แค่บนแถบ compass
 * เสากลาง = yaw 0, เสาส้ม 2 ต้น = ขอบซุ้ม ±90° (เห็นปุ๊บรู้ว่าหันสุดแล้ว)
 */
export function buildArcMarkers() {
  const M = CFG.markers;
  const group = new THREE.Group();
  group.name = 'ArcMarkers';

  const glow = (color) => new THREE.MeshBasicMaterial({
    color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  const centreMat = glow(M.color);
  const edgeMat = glow(M.edgeColor);

  // ราง: ครึ่งวงกลมหน้าผู้เล่น บอกขอบเขตซุ้ม 180°
  const rail = new THREE.Mesh(
    new THREE.TorusGeometry(M.railRadius, 0.055, 6, 64, Math.PI),
    centreMat,
  );
  rail.rotation.x = -Math.PI / 2;
  rail.rotation.z = Math.PI;          // ให้ครึ่งวงอยู่ฝั่ง -Z (หน้าผู้เล่น)
  rail.position.y = 0.55;
  group.add(rail);

  const post = (yawDeg, h, mat) => {
    const yaw = yawDeg * DEG;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, h, 6), mat);
    m.position.set(-Math.sin(yaw) * M.railRadius, h / 2, -Math.cos(yaw) * M.railRadius);
    group.add(m);

    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), mat);
    cap.position.set(m.position.x, h, m.position.z);
    group.add(cap);
    return m;
  };

  post(0, M.centerPostHeight, centreMat);       // หมุดกลางซุ้ม
  post(-90, M.postHeight, edgeMat);
  post(90, M.postHeight, edgeMat);
  post(-45, M.postHeight * 0.6, centreMat);
  post(45, M.postHeight * 0.6, centreMat);

  return group;
}

/** ท้องฟ้ากลางคืน — gradient + ดาว ไม่ต้องมีไฟล์ */
export function buildSky() {
  const group = new THREE.Group();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      // ShaderMaterial เขียน gl_FragColor ตรงๆ ไม่ผ่าน output color space conversion
      // เลยต้องเก็บสีแบบ "ดิบ" (LinearSRGBColorSpace = ไม่แปลง) ไม่งั้น constructor
      // จะแปลง sRGB→linear ให้ แล้วท้องฟ้าจะออกมาดำสนิท
      uniforms: {
        top: { value: new THREE.Color().setHex(0x04060f, THREE.LinearSRGBColorSpace) },
        mid: { value: new THREE.Color().setHex(0x111d3f, THREE.LinearSRGBColorSpace) },
        bot: { value: new THREE.Color().setHex(0x243056, THREE.LinearSRGBColorSpace) },
      },
      vertexShader: `
        varying float vH;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vH = normalize(wp.xyz).y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 top, mid, bot;
        varying float vH;
        void main() {
          float h = clamp(vH, -1.0, 1.0);
          vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.55)) : mix(mid, bot, -h);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  sky.frustumCulled = false;
  group.add(sky);

  // ดาว — ถูกมาก แต่ทำให้ฉากไม่ว่างเปล่า
  const N = 700;
  const pos = new Float32Array(N * 3);
  const R = 2000;
  for (let i = 0; i < N; i++) {
    const az = Math.random() * Math.PI * 2;
    const y = Math.random() * 0.95 + 0.03;       // เหนือขอบฟ้าเท่านั้น
    const ring = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(az) * ring * R;
    pos[i * 3 + 1] = y * R;
    pos[i * 3 + 2] = Math.sin(az) * ring * R;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xbfd4ff, size: 2.4, sizeAttenuation: false,
    transparent: true, opacity: 0.75, depthWrite: false,
  }));
  stars.frustumCulled = false;
  group.add(stars);

  return group;
}

// ── helpers: ทาสีลง vertex color เพื่อคุมโทนโดยไม่เพิ่ม material ──
//
// *** ระวัง color space ***  vertex color ที่เขียนลงไปคือค่า "linear"
// แล้ว renderer จะแปลงเป็น sRGB ตอน output ให้อีกที → ค่า 0.10 linear จะออกมาสว่างราว 0.35
// ตอนแรกใส่ 0.028-0.10 แล้วตึกออกมาเป็นสีเทาสว่าง ไม่ใช่ silhouette ตามที่ spec ต้องการ
// ค่าที่ใช้จริงเลยต้องต่ำกว่าที่รู้สึกว่า "ควรจะเป็น" ประมาณ 3 เท่า
function paint(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

function paintGradient(geo, h) {
  const p = geo.attributes.position;
  const n = p.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (p.getY(i) + h / 2) / h;            // 0 = โคน, 1 = ยอด
    // t⁴ = เกือบดำทั้งตึก สว่างเฉพาะขอบบนสุด → ได้ silhouette ที่มีเส้นขอบฟ้าคมๆ
    const v = 0.006 + t * t * t * t * 0.048;
    c[i * 3] = v * 0.70; c[i * 3 + 1] = v * 0.88; c[i * 3 + 2] = v * 1.6;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}
