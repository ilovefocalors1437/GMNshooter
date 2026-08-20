"""tools/bake_gmn.py — GMN traj_summary txt → SQLite

    python tools/bake_gmn.py data/gmn_daily_sample.txt
    python tools/bake_gmn.py data/traj_summary_yearly_2019.txt --db data/meteors.db
    python tools/bake_gmn.py data/*.txt --append

*** สตรีมอ่านทีละบรรทัด ห้ามโหลดเข้า RAM ทั้งก้อน (spec §7) ***
ไฟล์ yearly ใหญ่ได้ถึง 857 MB และ traj_summary_all.txt = 3 GB
ถ้า read() ทั้งไฟล์คือจบเห่ ต่อให้เครื่องไหว มันก็ช้าโดยไม่จำเป็น

column index ทั้งหมดมาจากการรัน tools/peek_gmn.py กับไฟล์จริง ไม่ได้เดา
ถ้า GMN เปลี่ยน format วันหนึ่ง ให้รัน peek ใหม่แล้วแก้ COL ข้างล่างนี้ที่เดียว
"""

import argparse
import os
import sqlite3
import sys
import glob

# index จริงจาก peek_gmn.py (ไฟล์คั่นด้วย ';' มี 86 คอลัมน์)
COL = {
    "gmn_id":   0,   # Unique trajectory identifier
    "dt_utc":   2,   # Beginning UTC Time
    "shower":   4,   # IAU code  ('...' = sporadic ไม่สังกัดฝนดาวตกไหน)
    "ra":       7,   # RAgeo  deg
    "dec":      9,   # DECgeo deg
    "vgeo":    15,   # Vgeo   km/s
    "ht_beg":  67,   # ความสูงตอนเริ่มติดไฟ (กม.)
    "ht_end":  73,   # ความสูงตอนไหม้หมด (กม.)
    "duration": 75,  # Duration วินาที — เวลาที่มันไหม้อยู่จริงบนฟ้า
    "mag":     76,   # Peak AbsMag
    "stations": 85,  # Participating stations เช่น "CZ0012,DK000K"
}
N_COLS = 86

SCHEMA = """
CREATE TABLE IF NOT EXISTS meteors (
    id          INTEGER PRIMARY KEY,   -- rowid ต่อเนื่อง ใช้สุ่มหยิบแบบ O(log n)
    gmn_id      TEXT,
    dt_utc      TEXT,
    ra          REAL,   -- RAgeo  องศา 0..360   (radiant = ทิศบนทรงกลมฟ้า ไม่ใช่พิกัดบนโลก)
    dec         REAL,   -- DECgeo องศา -90..90
    vgeo        REAL,   -- km/s
    ht_beg      REAL,   -- กม. ที่เริ่มติดไฟ  (ปกติ ~100 กม.)
    ht_end      REAL,   -- กม. ที่ไหม้หมด    (ปกติ ~80 กม. — ไม่ถึงพื้น)
    duration    REAL,   -- วินาทีที่มันไหม้อยู่จริง — ใช้ทั้งนาฬิกาจริง (§5.1) และคัดความยาก (§3)
    mag         REAL,   -- ยิ่งติดลบยิ่งสว่าง
    shower      TEXT,   -- IAU code เช่น PER, GEM, หรือ NULL ถ้า sporadic
    station_cc  TEXT    -- ประเทศของสถานีที่เห็น เช่น "CZ,DK"
);
"""


def parse_line(line):
    """คืน tuple พร้อมลง DB หรือ None ถ้าบรรทัดนี้ใช้ไม่ได้"""
    parts = line.split(";")
    if len(parts) < N_COLS - 2:
        return None
    try:
        ra = float(parts[COL["ra"]])
        dec = float(parts[COL["dec"]])
        vgeo = float(parts[COL["vgeo"]])
    except (ValueError, IndexError):
        return None

    try:
        mag = float(parts[COL["mag"]])
    except (ValueError, IndexError):
        mag = None

    try:
        duration = float(parts[COL["duration"]])
    except (ValueError, IndexError):
        duration = None

    def _f(key):
        try:
            return float(parts[COL[key]])
        except (ValueError, IndexError):
            return None
    ht_beg, ht_end = _f("ht_beg"), _f("ht_end")

    shower = parts[COL["shower"]].strip()
    if shower in ("...", "", "-1"):
        shower = None                      # sporadic — ไม่สังกัดฝนดาวตกไหน

    # "CZ0012,DK000K" → "CZ,DK"  (2 ตัวแรกของรหัสสถานีคือ ISO country code)
    try:
        raw = parts[COL["stations"]].strip()
        ccs = []
        for st in raw.split(","):
            st = st.strip()
            if len(st) >= 2:
                cc = st[:2].upper()
                if cc not in ccs:
                    ccs.append(cc)
        station_cc = ",".join(ccs) if ccs else None
    except IndexError:
        station_cc = None

    return (
        parts[COL["gmn_id"]].strip(),
        parts[COL["dt_utc"]].strip(),
        ra, dec, vgeo, ht_beg, ht_end, duration, mag, shower, station_cc,
    )


def bake(paths, db_path, append=False, batch=5000):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    if not append and os.path.exists(db_path):
        os.remove(db_path)

    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)
    # เร่ง insert — ไฟล์ใหญ่ๆ ต่างกันหลายเท่า
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")

    total_in = total_ok = 0
    rows = []

    for path in paths:
        if not os.path.exists(path):
            print(f"  ! ข้าม (ไม่เจอไฟล์): {path}")
            continue
        size = os.path.getsize(path)
        print(f"  อ่าน {os.path.basename(path)}  ({size/1024/1024:.1f} MB)")

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:                      # ← สตรีม ไม่ใช่ f.read()
                line = line.strip()
                if not line or line.startswith("#"):
                    continue                    # header กับบรรทัดว่างระหว่าง record
                total_in += 1
                row = parse_line(line)
                if row is None:
                    continue
                rows.append(row)
                total_ok += 1

                if len(rows) >= batch:
                    _flush(con, rows)
                    rows = []
                    if total_ok % 100000 == 0:
                        print(f"    ... {total_ok:,} แถว")

    if rows:
        _flush(con, rows)

    print("  ทำ index...")
    con.execute("CREATE INDEX IF NOT EXISTS idx_shower ON meteors(shower)")
    # index สำหรับคัดความยาก (§3) — Easy = สว่าง+ไหม้นาน / Extreme = รวมดวงจางที่ไหม้แวบเดียว
    con.execute("CREATE INDEX IF NOT EXISTS idx_diff ON meteors(mag, duration)")
    con.commit()

    _report(con, db_path, total_in, total_ok)
    con.close()


def _flush(con, rows):
    con.executemany(
        "INSERT INTO meteors (gmn_id, dt_utc, ra, dec, vgeo, ht_beg, ht_end,"
        " duration, mag, shower, station_cc) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)


def _report(con, db_path, total_in, total_ok):
    c = con.cursor()
    n = c.execute("SELECT COUNT(*) FROM meteors").fetchone()[0]
    print("\n" + "=" * 62)
    print(f"  DB       {db_path}")
    print(f"  ขนาด     {os.path.getsize(db_path)/1024/1024:.1f} MB")
    print(f"  อ่านมา   {total_in:,} บรรทัด → ใช้ได้ {total_ok:,} ({total_in-total_ok:,} ตกไป)")
    print(f"  ในตาราง  {n:,} ดวง")
    if not n:
        return

    lo, hi = c.execute("SELECT MIN(dt_utc), MAX(dt_utc) FROM meteors").fetchone()
    print(f"  ช่วงเวลา {lo}  →  {hi}")

    vmin, vmax, vavg = c.execute("SELECT MIN(vgeo), MAX(vgeo), AVG(vgeo) FROM meteors").fetchone()
    print(f"  Vgeo     {vmin:.1f} – {vmax:.1f} km/s (เฉลี่ย {vavg:.1f})")
    mmin, mmax = c.execute("SELECT MIN(mag), MAX(mag) FROM meteors WHERE mag IS NOT NULL").fetchone()
    print(f"  mag      {mmin:.2f} (สว่างสุด) – {mmax:.2f}")
    dmin, dmax, davg = c.execute(
        "SELECT MIN(duration), MAX(duration), AVG(duration) FROM meteors"
        " WHERE duration IS NOT NULL").fetchone()
    ndur = c.execute("SELECT COUNT(*) FROM meteors WHERE duration IS NOT NULL").fetchone()[0]
    print(f"  duration {dmin:.2f} – {dmax:.2f} วิ (เฉลี่ย {davg:.2f}) · มีค่า {ndur:,}/{n:,} ดวง")

    print("\n  ฝนดาวตกที่เจอบ่อยสุด:")
    for sh, cnt in c.execute(
            "SELECT COALESCE(shower,'(sporadic)'), COUNT(*) c FROM meteors"
            " GROUP BY shower ORDER BY c DESC LIMIT 8"):
        print(f"    {sh:12} {cnt:>8,}")

    print("\n  ประเทศที่สังเกตได้ (นับตามสถานีแรก):")
    for cc, cnt in c.execute(
            "SELECT substr(station_cc,1,2), COUNT(*) c FROM meteors"
            " WHERE station_cc IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 10"):
        print(f"    {cc:12} {cnt:>8,}")
    print("=" * 62)


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="ไฟล์ traj_summary (ใส่หลายไฟล์/wildcard ได้)")
    ap.add_argument("--db", default=os.path.join(root, "data", "meteors.db"))
    ap.add_argument("--append", action="store_true", help="ต่อท้าย DB เดิม ไม่ลบทิ้ง")
    a = ap.parse_args()

    paths = []
    for p in a.inputs:
        p = p if os.path.isabs(p) else os.path.join(root, p)
        paths.extend(sorted(glob.glob(p)) or [p])

    bake(paths, a.db if os.path.isabs(a.db) else os.path.join(root, a.db), a.append)
