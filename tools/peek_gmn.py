"""tools/peek_gmn.py — ส่องหัวไฟล์ GMN ก่อนเขียน parser

    python tools/peek_gmn.py data/gmn_daily_sample.txt

กฎเหล็กของ spec §7: **ห้ามเดาชื่อคอลัมน์**
ไฟล์ GMN ไม่ใช่ CSV ธรรมดา — มี header หลายบรรทัด คั่นด้วยอะไรก็ไม่รู้จนกว่าจะเห็น
ถ้าเดาแล้วผิด จะได้ข้อมูลที่ "ดูเหมือนถูก" แต่คนละคอลัมน์ ซึ่งจับได้ยากมากทีหลัง

สคริปต์นี้ไม่แปลงอะไรทั้งนั้น แค่พิมพ์ของจริงให้ดูแล้วเดาให้ว่าคอลัมน์ไหนคืออะไร
"""

import sys
import os

N_HEAD = 40


def main(path):
    if not os.path.exists(path):
        print(f"ไม่เจอไฟล์: {path}")
        return 1

    size = os.path.getsize(path)
    print(f"ไฟล์   {path}")
    print(f"ขนาด   {size:,} bytes ({size/1024/1024:.1f} MB)")
    print("=" * 100)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = []
        for i, line in enumerate(f):
            if i >= N_HEAD:
                break
            lines.append(line.rstrip("\n"))

    print(f"--- {len(lines)} บรรทัดแรกดิบๆ ---")
    for i, line in enumerate(lines):
        mark = "H" if line.lstrip().startswith("#") else " "
        print(f"{i:3}{mark}| {line[:200]}")

    # ── เดา delimiter จากบรรทัดข้อมูลจริง (ไม่ใช่บรรทัด comment) ──
    print("\n" + "=" * 100)
    data_lines = [l for l in lines if l.strip() and not l.lstrip().startswith("#")]
    if not data_lines:
        print("ยังไม่เจอบรรทัดข้อมูลใน 40 บรรทัดแรก — เพิ่ม N_HEAD แล้วรันใหม่")
        return 0

    sample = data_lines[0]
    for name, ch in [("semicolon ;", ";"), ("comma ,", ","), ("tab \\t", "\t"), ("pipe |", "|")]:
        print(f"  {name:14} → แบ่งได้ {len(sample.split(ch)):3} ช่อง")
    print("  whitespace     → แบ่งได้ %3d ช่อง" % len(sample.split()))

    # ── บรรทัด header (ขึ้นต้นด้วย #) มักเก็บชื่อคอลัมน์ไว้ ──
    print("\n" + "=" * 100)
    print("--- บรรทัดที่ขึ้นต้นด้วย # (น่าจะเป็นชื่อคอลัมน์กับหน่วย) ---")
    hdr = [l for l in lines if l.lstrip().startswith("#")]
    for h in hdr:
        print("  " + h[:200])

    # ── จับคู่ชื่อคอลัมน์กับค่าจริง เพื่อยืนยันว่า index ตรงกัน ──
    delim = ";" if len(sample.split(";")) > 3 else None
    if delim and hdr:
        print("\n" + "=" * 100)
        print(f"--- จับคู่ index ↔ ชื่อ ↔ ค่าจริง (delimiter = '{delim}') ---")
        # หา header ที่แบ่งแล้วได้จำนวนช่องเท่ากับบรรทัดข้อมูล
        vals = [v.strip() for v in sample.split(delim)]
        best = None
        for h in hdr:
            cells = [c.strip(" #") for c in h.split(delim)]
            if len(cells) == len(vals):
                best = cells if best is None else best
        names = best or [""] * len(vals)
        for i, (n, v) in enumerate(zip(names, vals)):
            print(f"  [{i:3}]  {n[:34]:34}  =  {v[:34]}")
        print(f"\n  รวม {len(vals)} คอลัมน์")

    return 0


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else "data/gmn_daily_sample.txt"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isabs(p):
        p = os.path.join(root, p)
    sys.exit(main(p))
