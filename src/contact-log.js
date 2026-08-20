// contact-log.js — การ์ด GMN
//
// *** นี่คือชิ้นที่สำคัญที่สุดของทั้งโปรเจกต์ ***
// เราไม่ได้ขาย gameplay เราขาย "อุกกาบาตดวงนี้มีอยู่จริง และนี่คือหลักฐาน"
//
// การ์ด 1 ใบต้องตอบ 4 คำถามที่เด็กถามเองในใจ:
//   1. มันคืออะไร        → ชื่อกลุ่มฝนดาวตก
//   2. มันอยู่นานแค่ไหน   → ไหม้อยู่บนฟ้ากี่วินาที (เด็กเพิ่งใช้เวลาพอๆ กันยิงมัน)
//   3. มันอยู่ตรงไหน      → ทิศ + มุมเงย เมื่อมองจากกรุงเทพ
//   4. ใครเห็นมัน        → กล้องประเทศไหนบันทึกไว้  ← อันนี้ทำให้เด็ก wow ที่สุด
//                          (กล้องบนหลังคาบ้านคนธรรมดา ไม่ใช่ดาวเทียม)
//                          และตอบคำถาม "ทำไมนิ่งอยู่กรุงเทพแต่ยิงของโครเอเชียได้"

import { CFG } from './config.js';

// az (องศา วัดจากทิศเหนือ ตามเข็ม) → คำไทย
// ห้ามโชว์เป็นตัวเลของศา เด็กอ่านไม่เข้าใจว่า az 47° แปลว่าอะไร
const DIRS = [
  'ทิศเหนือ', 'ทิศตะวันออกเฉียงเหนือ', 'ทิศตะวันออก', 'ทิศตะวันออกเฉียงใต้',
  'ทิศใต้', 'ทิศตะวันตกเฉียงใต้', 'ทิศตะวันตก', 'ทิศตะวันตกเฉียงเหนือ',
];

export function azToThai(azDeg) {
  if (azDeg === null || azDeg === undefined) return null;
  const i = Math.round((((azDeg % 360) + 360) % 360) / 45) % 8;
  return DIRS[i];
}

export class ContactLog {
  constructor(el) {
    this.el = el;
    this.shown = [];      // การ์ดที่โชว์อยู่ตอนนี้ (สูงสุด CFG.card.maxVisible)
    this.queue = [];      // ยิงเร็วกว่าที่อ่านทัน ให้ต่อคิวไว้
    this.hidden = false;  // ช่วงพายุซ่อนการ์ดทั้งหมด
    this.all = [];        // เก็บทุกดวงของรอบไว้สรุปตอนจบ
  }

  /**
   * @param meteor  ดวงที่เพิ่งจบชีวิต (ต้องมี .gmn)
   * @param outcome 'hit' | 'burned'
   */
  add(meteor, outcome) {
    const g = meteor && meteor.gmn;
    if (!g) return;                      // ดวงที่ไม่มีข้อมูลจริง ไม่ต้องโกหกลงการ์ด

    const item = { g, outcome, t: 0 };
    this.all.push(item);
    if (this.hidden) return;             // ช่วงพายุ เก็บเงียบไว้โชว์ตอนสรุป
    this.queue.push(item);
    this._pump();
  }

  /** เรียกทุก frame — คุมเวลาค้างขั้นต่ำของแต่ละใบ */
  update(dt) {
    if (this.hidden) return;
    let dirty = false;
    for (const it of this.shown) it.t += dt;
    if (this.queue.length && this._canSwap()) { this._pump(); dirty = true; }
    if (dirty) this.render();
  }

  _canSwap() {
    if (this.shown.length < CFG.card.maxVisible) return true;
    // ใบเก่าสุดต้องอยู่ครบเวลาขั้นต่ำก่อน ไม่งั้นกระพริบจนอ่านไม่ทัน
    const oldest = this.shown[this.shown.length - 1];
    return oldest.t >= CFG.card.minHoldSec;
  }

  _pump() {
    while (this.queue.length && this._canSwap()) {
      this.shown.unshift(this.queue.shift());
      if (this.shown.length > CFG.card.maxVisible) this.shown.pop();
    }
    this.render();
  }

  setStormMode(on) {
    this.hidden = !!on;
    if (on) { this.shown.length = 0; this.queue.length = 0; }
    this.render();
  }

  clear() {
    this.shown.length = 0; this.queue.length = 0; this.all.length = 0;
    this.render();
  }

  render() {
    if (!this.el) return;
    if (this.hidden) { this.el.innerHTML = ''; return; }

    this.el.innerHTML = this.shown.map((it, i) => {
      const g = it.g;
      const group = g.showerName
        ? `${g.showerName} (${g.shower})`
        : 'Sporadic — ไม่สังกัดฝนดาวตก';

      // duration null → ข้ามบรรทัดไปเลย ห้ามโชว์ขีด
      const burn = (g.duration === null || g.duration === undefined) ? '' :
        `<div class="cd-row"><span>ไหม้อยู่บนฟ้า</span><b>${g.duration.toFixed(2)} วินาที</b></div>`;

      const dir = azToThai(g.azDeg);
      const alt = (g.altDeg === null || g.altDeg === undefined)
        ? '' : `สูง ${Math.round(g.altDeg)}°`;
      const seen = dir
        ? `<div class="cd-row"><span>เห็นจากกรุงเทพ</span><b>${dir}<br><i>${alt}</i></b></div>`
        : '';

      const cams = (g.detectedBy || []).join(' + ');
      const cam = cams ? `<div class="cd-cam">📡 กล้อง ${esc(cams)}</div>` : '';

      const res = it.outcome === 'hit'
        ? ''
        : `<div class="cd-miss">✗ ไหม้หมดที่ ${g.htEnd ? g.htEnd + ' กม.' : 'กลางอากาศ'}</div>`;

      return `<div class="cd${i === 0 ? ' fresh' : ''}${it.outcome === 'hit' ? '' : ' miss'}">
        <div class="cd-grp">${esc(group)}</div>
        ${burn}${seen}${cam}${res}
      </div>`;
    }).join('');
  }

  /**
   * สรุปแบบ "ยิงอะไรไป กล้องชาติไหนบันทึกไว้ อย่างละกี่ดวง"
   *
   * จับคู่ ฝนดาวตก × ประเทศ เพราะนั่นคือประโยคที่เด็กเล่าต่อได้จริง
   * ("ยิง Quadrantids ที่กล้องอังกฤษถ่ายไว้ได้ 3 ดวง")
   * นับด้วยกล้องตัวแรกของแต่ละดวงเท่านั้น ไม่งั้นดวงเดียวไปโผล่หลายแถว
   */
  catches() {
    const rows = {};
    for (const it of this.all) {
      if (it.outcome !== 'hit') continue;
      const shower = it.g.showerName || it.g.shower || 'Sporadic';
      const cam = (it.g.detectedBy || [])[0] || null;
      const key = shower + '\u0000' + (cam || '');
      if (!rows[key]) rows[key] = { shower, cam, n: 0 };
      rows[key].n++;
    }
    return Object.values(rows).sort((a, b) => b.n - a.n);
  }

  /** สรุปตอนจบรอบ — นับกลุ่มฝนดาวตกกับประเทศกล้อง */
  summary() {
    const showers = {}, cams = {};
    let hits = 0;
    for (const it of this.all) {
      if (it.outcome !== 'hit') continue;
      hits++;
      const k = it.g.showerName || 'Sporadic';
      showers[k] = (showers[k] || 0) + 1;
      for (const c of (it.g.detectedBy || [])) cams[c] = (cams[c] || 0) + 1;
    }
    return {
      hits,
      showers: Object.entries(showers).sort((a, b) => b[1] - a[1]),
      cameras: Object.entries(cams).sort((a, b) => b[1] - a[1]).map(c => c[0]),
    };
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
