# game/room.py — slot / token / state ของผู้เล่น
#
# กฎที่ทำให้เรื่องนี้ไม่พัง (spec §4):
#   "เด็กล็อกจอ / refresh / กด Home ต้องกลับ slot เดิม ไม่ใช่กลายเป็น player 4"
#
# วิธี: slot ผูกกับ *token* ไม่ใช่ผูกกับ socket connection
#   - มือถือเข้าครั้งแรก → server ออก token ให้ → เก็บใน sessionStorage
#   - หลุด/refresh → ส่ง token เดิมกลับมา → ได้ slot เดิมทันที
#   - slot จะถูกปล่อยให้คนใหม่ ก็ต่อเมื่อเจ้าของเดิมหายไปเกิน SLOT_RECLAIM_SEC
#
# ถ้าผูก slot กับ socket id ตรงๆ เด็กกด refresh ทีเดียวก็กลายเป็นคนใหม่ทันที

import secrets
import string
import time
import threading

from . import config as C


def _now() -> float:
    return time.time()


class Slot:
    def __init__(self, meta: dict):
        self.slot = meta["slot"]
        self.name = meta["name"]
        self.en = meta["en"]
        self.hex = meta["hex"]
        self.rgb = meta["rgb"]

        self.token = None
        self.sid = None            # socket id ปัจจุบัน (None = หลุดอยู่)
        self.last_seen = 0.0

        # aim ล่าสุดที่มือถือส่งมา — เป็น "มุมสัมบูรณ์" ไม่ใช่ delta
        self.yaw = 0.0
        self.pitch = 12 * 3.14159265 / 180

        self.score = 0
        self.combo = 0
        self.last_hit_ms = -1e9
        self.last_fire_ms = -1e9
        self.hits = 0
        self.shots = 0

    @property
    def taken(self) -> bool:
        return self.token is not None

    @property
    def connected(self) -> bool:
        return self.sid is not None

    @property
    def stale(self) -> bool:
        """หายไปนานพอที่จะปล่อยให้คนอื่นมาใช้แล้วหรือยัง"""
        return (not self.connected) and (_now() - self.last_seen > C.SLOT_RECLAIM_SEC)

    def reset_scores(self):
        self.score = 0
        self.combo = 0
        self.hits = 0
        self.shots = 0
        self.last_hit_ms = -1e9
        self.last_fire_ms = -1e9

    def public(self) -> dict:
        """ข้อมูลที่ส่งให้จอใหญ่ได้ — ไม่มี token"""
        return {
            "slot": self.slot, "name": self.name, "en": self.en,
            "hex": self.hex, "rgb": self.rgb,
            "taken": self.taken, "connected": self.connected,
            "score": self.score, "combo": self.combo,
        }


class Room:
    def __init__(self):
        self.lock = threading.RLock()
        self.code = "".join(secrets.choice(string.ascii_uppercase.replace("O", "").replace("I", ""))
                            for _ in range(4))
        self.slots = [Slot(m) for m in C.SLOT_COLORS]
        self.by_token = {}
        self.screens = set()       # sid ของจอใหญ่ (เผื่อเปิดหลายจอ)

    # ── slot lookup ────────────────────────────────────────
    def slot_of_token(self, token):
        with self.lock:
            return self.by_token.get(token)

    def slot_of_sid(self, sid):
        with self.lock:
            for s in self.slots:
                if s.sid == sid:
                    return s
            return None

    # ── join ───────────────────────────────────────────────
    def join(self, token, sid):
        """
        คืน (slot, token, is_new) หรือ (None, None, False) ถ้าเต็ม

        ลำดับความสำคัญ:
          1. token เดิมที่รู้จัก → slot เดิมเสมอ (แม้ slot จะยัง "เต็ม" อยู่ก็ตาม)
          2. slot ว่าง
          3. slot ที่เจ้าของเดิมหายไปนานเกิน SLOT_RECLAIM_SEC
        """
        with self.lock:
            if token:
                s = self.by_token.get(token)
                if s is not None:
                    s.sid = sid
                    s.last_seen = _now()
                    return s, token, False

            for s in self.slots:
                if not s.taken:
                    return self._claim(s, sid)

            for s in self.slots:
                if s.stale:
                    self.by_token.pop(s.token, None)
                    s.reset_scores()
                    return self._claim(s, sid)

            return None, None, False

    def _claim(self, s, sid):
        tok = secrets.token_urlsafe(12)
        s.token = tok
        s.sid = sid
        s.last_seen = _now()
        self.by_token[tok] = s
        return s, tok, True

    def leave(self, sid):
        """socket หลุด — ยังไม่ปล่อย slot แค่ทำเครื่องหมายว่าไม่ได้ต่ออยู่"""
        with self.lock:
            s = self.slot_of_sid(sid)
            if s:
                s.sid = None
                s.last_seen = _now()
            return s

    # ── aim ────────────────────────────────────────────────
    def set_aim(self, sid, yaw, pitch):
        with self.lock:
            s = self.slot_of_sid(sid)
            if s is None:
                return None
            s.yaw = yaw
            s.pitch = pitch
            s.last_seen = _now()
            return s

    # ── สรุปสถานะ ──────────────────────────────────────────
    def aims(self) -> dict:
        with self.lock:
            return {str(s.slot): [round(s.yaw, 4), round(s.pitch, 4)]
                    for s in self.slots if s.taken}

    def state(self) -> dict:
        with self.lock:
            return {"slots": [s.public() for s in self.slots], "code": self.code}

    def active_slots(self):
        with self.lock:
            return [s for s in self.slots if s.taken]

    def reset(self):
        """ล้างแค่คะแนน คนเดิมยังอยู่ครบ — ใช้ตอนเริ่มรอบใหม่กับกลุ่มเดิม"""
        with self.lock:
            for s in self.slots:
                s.reset_scores()

    def kick_all(self):
        """
        ไล่ทุกคนออก คืน slot ให้ว่างหมด — ใช้ตอนเปลี่ยนกลุ่มเด็กหน้างาน

        จำเป็นเพราะ SLOT_RECLAIM_SEC ตั้งใจกันไม่ให้ slot หลุดตอน refresh
        ผลข้างเคียงคือกลุ่มก่อนหน้าเดินจากไปแล้ว slot ยังค้างอีก 90 วิ
        ซึ่งนานเกินไปเวลามีคิวต่อแถว
        """
        with self.lock:
            for s in self.slots:
                s.token = None
                s.sid = None
                s.last_seen = 0.0
                s.reset_scores()
            self.by_token.clear()
