# game/words.py — blocklist ชื่อทีม
#
# spec §3: "ต้องมี blocklist คำหยาบ ไทย+อังกฤษ (งานโรงเรียน เด็กจะลองแน่นอน — ไม่ใช่ optional)"
#
# กลยุทธ์: normalize ก่อนเทียบ เพราะเด็กจะเลี่ยงด้วยการใส่เลข/ช่องว่าง/สระแปลกๆ
#   "H3LL"  → "hell"
#   "ค ว ย" → "ควย"
# ไม่ได้ตั้งใจให้กันได้ 100% (ทำไม่ได้อยู่แล้ว) แต่ให้ด่านแรกไม่ผ่านง่ายๆ
# ที่เหลือจอ admin มีปุ่มเตะอยู่แล้ว

import re
import unicodedata

# แปลงตัวเลข/สัญลักษณ์ที่ใช้แทนตัวอักษร (leetspeak)
LEET = str.maketrans({
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
    "@": "a", "$": "s", "!": "i", "|": "i", "+": "t",
})

TH = [
    "ควย", "หี", "เหี้ย", "สัส", "สัด", "เย็ด", "แตด", "จิ๋ม", "ตูด", "ขี้",
    "อีดอก", "กระหรี่", "แม่ง", "มึง", "กู", "ไอ้เวร", "ระยำ", "ชาติหมา",
    "หำ", "ไข่แตก", "เงี่ยน", "โง่", "ควาย", "สถุน", "ชิบหาย", "ฉิบหาย",
]

EN = [
    "fuck", "shit", "bitch", "cunt", "dick", "cock", "pussy", "penis", "vagina",
    "asshole", "bastard", "whore", "slut", "nigger", "nigga", "fag", "faggot",
    "rape", "nazi", "hitler", "sex", "porn", "anal", "cum", "wank", "jerkoff",
    "retard", "damn", "hell", "piss", "boob", "tit", "arse", "bollock", "twat",
]

BLOCKED = TH + EN


def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower().translate(LEET)
    # ตัดทุกอย่างที่ไม่ใช่ตัวอักษรไทย/อังกฤษออก — กัน "f.u.c.k" / "ค-ว-ย"
    return re.sub(r"[^a-z฀-๿]", "", s)


def is_blocked(name: str) -> bool:
    n = _normalize(name)
    if not n:
        return False
    return any(bad in n for bad in (_normalize(b) for b in BLOCKED))


def clean_team_name(raw, min_len=3, max_len=12):
    """
    คืน (ชื่อที่ใช้ได้, ข้อความ error)
    ชื่อผ่าน → (ชื่อ, None) / ไม่ผ่าน → (None, เหตุผล)
    """
    if raw is None:
        return None, "ยังไม่ได้ใส่ชื่อทีม"
    name = " ".join(str(raw).split())        # ตัดช่องว่างหัวท้าย + ยุบช่องว่างซ้ำ
    name = name.upper()                       # spec: บังคับตัวใหญ่

    if len(name) < min_len:
        return None, f"ชื่อทีมต้องยาวอย่างน้อย {min_len} ตัว"
    if len(name) > max_len:
        return None, f"ชื่อทีมยาวได้ไม่เกิน {max_len} ตัว"
    if is_blocked(name):
        return None, "ชื่อนี้ใช้ไม่ได้ ลองใหม่นะ"
    return name, None
