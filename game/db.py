"""game/db.py — สุ่มหยิบอุกกาบาตจริงจาก SQLite แล้วแปลงเป็นทิศบนฟ้ากรุงเทพ

หัวใจอยู่ที่ 3 ข้อเท็จจริงใน spec §7 ที่ทำให้ออกแบบผิดได้ง่ายมาก:

1. **radiant คือทิศบนทรงกลมฟ้า ไม่ใช่พิกัดบนโลก**
   RA/Dec บอกว่า "มันพุ่งมาจากทิศไหนของอวกาศ" ไม่ได้บอกว่ามันตกที่ประเทศไหน
   → เอามาแปลงเป็น alt/az ของกรุงเทพได้อย่างถูกต้องตามหลักดาราศาสตร์

2. **อุกกาบาตเป็นเหตุการณ์เฉพาะที่** ดวงที่กล้องที่อังกฤษจับได้ คนกรุงเทพมองไม่เห็น
   → เราไม่ได้อ้างว่าเห็น เราอ้างว่า "ถ้าเรดิแอนต์นี้อยู่บนฟ้ากรุงเทพตอนนี้ จะอยู่ตรงไหน"
   contact log เลยต้องบอก observed country ตามจริงเสมอ

3. **ห้าม filter ประเทศ / ห้าม filter ว่าเกิดเหนือกรุงเทพ** — ไทยแทบไม่มีกล้อง GMN
   filter แล้วจะได้ศูนย์แถว

ไม่ใช้ astropy: การแปลง RA/Dec → alt/az เป็นตรีโกณล้วน ~20 บรรทัด
ส่วน astropy ต้อง compile บน Windows ARM64 ซึ่งพังบ่อยและกินพื้นที่เป็นร้อย MB
"""

import math
import os
import random
import sqlite3
import threading
from datetime import datetime, timezone

from . import config as C

_lock = threading.Lock()
_con = None

# ── ISO 3166-1 alpha-2 → ชื่อประเทศ (เท่าที่ GMN มีสถานีจริง) ──
# ไม่ใช้ lib ภายนอกเพื่อ map ชื่อ — dict สั้นๆ พอ ที่ไม่รู้จักก็โชว์รหัสไปตรงๆ
COUNTRY = {
    "AU": "Australia", "AT": "Austria", "BE": "Belgium", "BR": "Brazil", "BG": "Bulgaria",
    "CA": "Canada", "CL": "Chile", "CN": "China", "HR": "Croatia", "CY": "Cyprus",
    "CZ": "Czechia", "DK": "Denmark", "EE": "Estonia", "FI": "Finland", "FR": "France",
    "DE": "Germany", "GR": "Greece", "HU": "Hungary", "IS": "Iceland", "IN": "India",
    "IE": "Ireland", "IL": "Israel", "IT": "Italy", "JP": "Japan", "LV": "Latvia",
    "LT": "Lithuania", "LU": "Luxembourg", "MX": "Mexico", "NL": "Netherlands",
    "NZ": "New Zealand", "NO": "Norway", "PL": "Poland", "PT": "Portugal",
    "RO": "Romania", "RS": "Serbia", "SK": "Slovakia", "SI": "Slovenia",
    "ZA": "South Africa", "KR": "South Korea", "ES": "Spain", "SE": "Sweden",
    "CH": "Switzerland", "TH": "Thailand", "TR": "Turkey", "UA": "Ukraine",
    "UK": "United Kingdom", "GB": "United Kingdom", "US": "United States",
    "AR": "Argentina", "UY": "Uruguay", "RU": "Russia",
}

# ── ชื่อฝนดาวตกที่เจอบ่อย (IAU code → ชื่อเต็ม) ──
SHOWERS = {
    "PER": "Perseids", "GEM": "Geminids", "QUA": "Quadrantids", "ORI": "Orionids",
    "LYR": "Lyrids", "ETA": "Eta Aquariids", "SDA": "Southern δ Aquariids",
    "CAP": "α Capricornids", "TAU": "Taurids", "STA": "Southern Taurids",
    "NTA": "Northern Taurids", "LEO": "Leonids", "URS": "Ursids", "DRA": "Draconids",
    "AUR": "Aurigids", "SPE": "September ε Perseids", "NDA": "Northern δ Aquariids",
    "KCG": "κ Cygnids", "AOA": "α Aurigids", "EQA": "η Aquariids", "ERI": "η Eridanids",
    "AXC": "α Cygnids", "KAP": "κ Aquariids", "MON": "Monocerotids", "HYD": "σ Hydrids",
    "COM": "Comae Berenicids", "LMI": "Leonis Minorids", "PON": "Piscids",
    "NZC": "Northern June Aquilids", "SZC": "Southern June Aquilids",
}


# ══════════════════════════════════════════════════════════
# ดาราศาสตร์: RA/Dec (J2000) → alt/az ที่ผู้สังเกต
# ══════════════════════════════════════════════════════════
def julian_date(dt: datetime) -> float:
    """UTC datetime → Julian Date (แม่นพอสำหรับช่วง 1900-2100)"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    y, m = dt.year, dt.month
    d = dt.day
    ut = dt.hour + dt.minute / 60 + (dt.second + dt.microsecond / 1e6) / 3600
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return (math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1))
            + d + b - 1524.5 + ut / 24.0)


def gmst_deg(jd: float) -> float:
    """Greenwich Mean Sidereal Time เป็นองศา"""
    d = jd - 2451545.0
    t = d / 36525.0
    g = (280.46061837 + 360.98564736629 * d
         + 0.000387933 * t * t - (t ** 3) / 38710000.0)
    return g % 360.0


def radec_to_altaz(ra_deg, dec_deg, when: datetime,
                   lat_deg=C.OBSERVER_LAT, lon_deg=C.OBSERVER_LON):
    """
    คืน (alt_deg, az_deg) — az วัดจากทิศเหนือ ตามเข็มนาฬิกา (N=0, E=90)

    ไม่แก้ precession/nutation/refraction: ระดับความแม่นนั้นไม่มีผลกับเกม
    ที่ซุ้มกว้าง 180° และเป้ากินมุมเป็นองศา
    """
    jd = julian_date(when)
    lst = (gmst_deg(jd) + lon_deg) % 360.0        # local sidereal time
    ha = math.radians((lst - ra_deg) % 360.0)     # hour angle

    dec = math.radians(dec_deg)
    lat = math.radians(lat_deg)

    sin_alt = math.sin(dec) * math.sin(lat) + math.cos(dec) * math.cos(lat) * math.cos(ha)
    sin_alt = max(-1.0, min(1.0, sin_alt))
    alt = math.asin(sin_alt)

    az = math.atan2(-math.sin(ha) * math.cos(dec),
                    math.cos(lat) * math.sin(dec) - math.sin(lat) * math.cos(dec) * math.cos(ha))
    return math.degrees(alt), math.degrees(az) % 360.0


def az_to_yaw_deg(az_deg: float) -> float:
    """
    az (N=0 ตามเข็ม) → yaw ของเกม (0 = หน้า, บวก = ซ้าย) ในช่วง -180..180

    เกมหันหน้าไปทางทิศเหนือ: az 0 → yaw 0, az 90 (ตะวันออก/ขวามือ) → yaw -90
    """
    yaw = -az_deg
    while yaw > 180:
        yaw -= 360
    while yaw < -180:
        yaw += 360
    return yaw


# ══════════════════════════════════════════════════════════
# DB
# ══════════════════════════════════════════════════════════
def _ensure_db():
    """
    แตก data/meteors.db.gz → meteors.db ถ้ายังไม่มี

    git เก็บเฉพาะตัว .gz (28 MB) — ตัวเต็ม 60 MB ใหญ่เกินกว่าที่ GitHub อยากเห็น
    และ hoster ส่วนใหญ่ fs หายทุก restart → แตกใหม่ทุกครั้งที่บูต (0.3 วิ)
    เขียนลงไฟล์ชั่วคราวก่อนแล้ว rename — กันได้ไฟล์ครึ่งๆ ตอน process โดนฆ่ากลางคัน
    """
    if os.path.exists(C.DB_PATH):
        return True
    src = C.DB_PATH + ".gz"
    if not os.path.exists(src):
        return False
    import gzip
    import shutil
    tmp = C.DB_PATH + ".part"
    os.makedirs(os.path.dirname(C.DB_PATH), exist_ok=True)
    print("meteors.db ยังไม่มี — กำลังแตกจาก meteors.db.gz ...", flush=True)
    with gzip.open(src, "rb") as f, open(tmp, "wb") as out:
        shutil.copyfileobj(f, out, 1024 * 1024)
    os.replace(tmp, C.DB_PATH)
    print("แตกเสร็จ", flush=True)
    return True


def available() -> bool:
    return _ensure_db()


def _conn():
    global _con
    if _con is None:
        _ensure_db()
        _con = sqlite3.connect(C.DB_PATH, check_same_thread=False)
        _con.row_factory = sqlite3.Row
    return _con


def count() -> int:
    if not available():
        return 0
    with _lock:
        return _conn().execute("SELECT COUNT(*) FROM meteors").fetchone()[0]


def _random_row(cur, n_rows, where="1=1"):
    """
    หยิบแบบสุ่มด้วย rowid — เร็วกว่า ORDER BY RANDOM() เป็นพันเท่าตอนไฟล์ใหญ่
    (ORDER BY RANDOM() ต้องสแกน 472,388 แถวทุกครั้ง)
    """
    # *** ORDER BY id ห้ามตัดออก ***
    # ถ้าไม่ใส่ SQLite จะเลือกใช้ index idx_diff(mag,duration) แล้วคืน "แถวแรกตามลำดับ index"
    # ซึ่งเป็นแถวเดิมทุกครั้งไม่ว่าจะสุ่ม rid มาเป็นอะไร → ได้อุกกาบาตดวงเดิมซ้ำทั้งรอบ
    # (เจอมาแล้วตอนเทสต์: difficulty=normal คืนดวงเดียวกัน 6 ครั้งติด)
    # *** NOT INDEXED ห้ามตัดออก ***
    # ถ้าปล่อยให้ SQLite เลือกเอง มันจะไปใช้ idx_diff(mag,duration) กับเงื่อนไขความยาก
    # แล้วต้องเรียงผลลัพธ์ตาม id ใหม่ทุกครั้ง → กลายเป็นสแกนทั้งช่วง index ต่อ 1 query
    # วัดจริง: difficulty=normal (ครอบคลุม 309k แถว) ใช้เวลา 42 วินาทีต่อการหยิบ 105 ดวง
    #          ส่วน easy/extreme ใช้ 0.03 วินาที เพราะบังเอิญ planner เลือกทางอื่น
    # บังคับสแกนตาม rowid แทน → เจอแถวที่เข้าเงื่อนไขภายในไม่กี่แถวเสมอ
    rid = random.randint(1, n_rows)
    r = cur.execute(
        f"SELECT * FROM meteors NOT INDEXED WHERE id >= ? AND ({where}) LIMIT 1",
        (rid,)).fetchone()
    if r is None:      # สุ่มไปตกท้ายตาราง วนกลับมาหาย้อนขึ้น
        r = cur.execute(
            f"SELECT * FROM meteors NOT INDEXED WHERE id <= ? AND ({where}) "
            f"ORDER BY id DESC LIMIT 1", (rid,)).fetchone()
    return r


def pick(n=1, when=None, min_alt_deg=3.0, yaw_limit_deg=None, max_tries_each=80,
         where="1=1"):
    """
    สุ่มหยิบ n ดวงที่ "ตอนนี้อยู่บนฟ้ากรุงเทพ ในซุ้มยิงพอดี"

    ดวงที่เรดิแอนต์อยู่ใต้ขอบฟ้าหรือหลังตัวผู้เล่น ให้หยิบใหม่ (spec §7)
    ไม่ใช่การโกงข้อมูล — เป็นการเลือกมุมกล้อง: ของจริงก็มีแค่ครึ่งฟ้าที่มองเห็นได้
    """
    if not available():
        return []
    yaw_limit = C.YAW_LIMIT_DEG if yaw_limit_deg is None else yaw_limit_deg
    when = when or datetime.now(timezone.utc)

    out = []
    with _lock:
        cur = _conn().cursor()
        n_rows = cur.execute("SELECT MAX(id) FROM meteors").fetchone()[0] or 0
        if not n_rows:
            return []

        for _ in range(n):
            for _try in range(max_tries_each):
                r = _random_row(cur, n_rows, where)
                if r is None:
                    break
                alt, az = radec_to_altaz(r["ra"], r["dec"], when)
                if alt < min_alt_deg:
                    continue
                yaw = az_to_yaw_deg(az)
                if abs(yaw) > yaw_limit - C.YAW_MARGIN_DEG:
                    continue
                out.append(_to_event(r, alt, az, yaw, when))
                break
    return out





def _to_event(r, alt, az, yaw, when):
    """แถวใน DB → ข้อมูลที่เกมใช้ได้ พร้อมของสำหรับ contact log"""
    cc = (r["station_cc"] or "").split(",")
    countries = [COUNTRY.get(c, c) for c in cc if c]
    shower_code = r["shower"]

    return {
        # ── ทิศ/ความเร็ว/ขนาด = ของจริงจาก GMN ──
        "yawDeg": round(yaw, 3),
        "pitchDeg": round(alt, 3),
        "azDeg": round(az, 3),
        "altDeg": round(alt, 3),
        "vgeo": round(r["vgeo"], 2),
        "mag": None if r["mag"] is None else round(r["mag"], 2),

        # เวลาที่มันไหม้อยู่จริงบนฟ้า — §5.1 เอาไปโชว์ "ในโลกจริง มันมีอยู่ 1.24 วินาที"
        "duration": None if r["duration"] is None else round(r["duration"], 2),

        # ความสูงที่ติดไฟ → ไหม้หมด (กม.)
        # ทั้งฐานข้อมูล 472,388 ดวง ต่ำสุดจบที่ 32 กม. เฉลี่ย 88 กม. — ไม่มีดวงไหนถึงพื้น
        # นี่คือหลักฐานว่าทำไมโหมดปกติอุกกาบาตต้องไหม้หมดกลางอากาศ ไม่ใช่ตกใส่เมือง
        "htBeg": None if r["ht_beg"] is None else round(r["ht_beg"], 1),
        "htEnd": None if r["ht_end"] is None else round(r["ht_end"], 1),

        # ── ของสำหรับ contact log — บอกความจริงทั้งหมด ไม่มีบรรทัดไหนโกหก ──
        "gmnId": r["gmn_id"],
        "dtUtc": r["dt_utc"],
        "shower": shower_code,
        "showerName": SHOWERS.get(shower_code) if shower_code else None,
        "stationCc": r["station_cc"],

        # §5.4: ห้ามใช้คำว่า "observed: China" เด็ดขาด เด็กอ่านแล้วเข้าใจว่า
        # "อุกกาบาตอยู่ที่จีน" ซึ่งผิด — ต้องสื่อว่าเป็น *กล้องที่บันทึกไว้*
        "detectedBy": countries,                       # list ของประเทศ (§5.2 ใช้ 2 ตัวแรก)
        "detectedByText": " · ".join(countries) if countries else None,
        "computedFor": when.strftime("%Y-%m-%d %H:%MZ"),
    }


def stats():
    if not available():
        return {"available": False, "path": C.DB_PATH}
    with _lock:
        c = _conn().cursor()
        n = c.execute("SELECT COUNT(*) FROM meteors").fetchone()[0]
        lo, hi = c.execute("SELECT MIN(dt_utc), MAX(dt_utc) FROM meteors").fetchone()
        showers = c.execute(
            "SELECT COALESCE(shower,'(sporadic)'), COUNT(*) c FROM meteors"
            " GROUP BY shower ORDER BY c DESC LIMIT 6").fetchall()
        countries = c.execute(
            "SELECT substr(station_cc,1,2), COUNT(*) c FROM meteors"
            " WHERE station_cc IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 8").fetchall()
    return {
        "available": True, "count": n, "from": lo, "to": hi,
        "showers": [[s[0], s[1]] for s in showers],
        "countries": [[COUNTRY.get(c[0], c[0]), c[1]] for c in countries],
        "observer": {"lat": C.OBSERVER_LAT, "lon": C.OBSERVER_LON, "name": "Bangkok"},
    }
