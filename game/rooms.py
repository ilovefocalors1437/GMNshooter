"""game/rooms.py — ห้อง HT### / ทีม / ตารางอุกกาบาตของรอบ

*** หัวใจของ co-op: ทุกเครื่องต้องเห็นอุกกาบาตชุดเดียวกันเป๊ะ ***

spec §2 บอกให้ส่ง seed แล้วให้ทุกเครื่องสุ่มเอง แต่ข้อมูลจริงอยู่ใน SQLite
ที่มีแต่ server เข้าถึงได้ ถ้าส่งแค่ seed ฝั่ง client ก็สุ่มอะไรไม่ได้อยู่ดี

เลยทำแบบนี้แทน: **server จัดตารางทั้งรอบล่วงหน้าแล้วส่งไปทีเดียวตอนเริ่ม**
  - ~120 ดวง × ~250 bytes ≈ 30 KB ส่งครั้งเดียว ไม่ใช่ทุก frame
  - ได้ผลเหมือนกันเป๊ะโดยไม่ต้องพึ่ง PRNG ฝั่ง client ให้ตรงกัน ซึ่งเปราะกว่ามาก
  - client ที่เข้าช้า/หลุดแล้วกลับมา ก็เล่นตารางเดิมต่อได้ทันที ไม่ต้อง resync

การตัดสินว่าใครยิงโดน = dedupe ล้วนๆ ไม่มี game loop ฝั่ง server (spec §2)
"""

import random
import secrets
import threading
import time

from . import config as C
from . import db as gmn_db
from .clock import now_ms


# สีผู้เล่นมาจาก config — ถ้าคนเกินจำนวนสี ก็วนใช้ซ้ำ (ยังแยกกันด้วยชื่อ/หมายเลข)
PLAYER_COLORS = C.SLOT_COLORS


class Player:
    """
    หนึ่งคน = หนึ่งคะแนน หนึ่งคอมโบ หนึ่งชื่อ

    เดิมคะแนนกับคอมโบเป็นของ *ห้อง* ทุกคนยิงเข้ากองกลางเดียวกัน
    เปลี่ยนเมื่อ 2026-08-24: ทุกคนอยู่สนามเดียวกัน แย่งอุกกาบาตชุดเดียวกัน
    แต่ใครยิงโดนคนนั้นได้คะแนน คอมโบก็เป็นสายของใครของมัน (ดู CLAUDE.md)

    `color` คือสีประจำตัวที่ระบบแจกให้ (แดง/น้ำเงิน) ใช้แยกกระสุนกับป้ายบนจอ
    `name` คือชื่อที่เจ้าตัวพิมพ์เอง ใช้ขึ้น leaderboard — คนละเรื่องกัน
    """

    def __init__(self, meta, slot):
        self.slot = slot
        self.color = meta["name"]        # สีประจำตัว ไม่ใช่ชื่อคน
        self.name = None                 # ชื่อที่เจ้าตัวพิมพ์ ยังไม่ตั้ง = None
        self.en = meta["en"]
        self.hex = meta["hex"]
        self.rgb = meta["rgb"]
        self.is_admin = False
        self.token = None
        self.sid = None
        self.last_seen = 0.0
        self.kills = 0
        self.shots = 0
        self.role = "ground"             # "ground" (ภาคพื้น) | "spaceship" (ผู้ควบคุมยาน)

        # ── สถิติส่วนตัว ──
        self.score = 0
        self.combo = 0
        self.best_combo = 0
        self.last_kill_ms = -1e9

    @property
    def taken(self):
        return self.token is not None

    @property
    def connected(self):
        return self.sid is not None

    @property
    def named(self):
        return bool(self.name)

    @property
    def display(self):
        """ชื่อที่เอาไปโชว์ได้เสมอ — ยังไม่พิมพ์ชื่อก็ใช้สีไปก่อน"""
        return self.name or self.color

    def reset_round(self):
        self.kills = 0
        self.shots = 0
        self.score = 0
        self.combo = 0
        self.best_combo = 0
        self.last_kill_ms = -1e9

    def public(self):
        return {"slot": self.slot, "name": self.display, "named": self.named,
                "role": self.role,
                "color": self.color, "en": self.en, "hex": self.hex,
                "rgb": self.rgb, "taken": self.taken, "connected": self.connected,
                "kills": self.kills, "shots": self.shots,
                "score": self.score, "combo": self.combo,
                "bestCombo": self.best_combo, "isAdmin": self.is_admin}


class Room:
    """หนึ่งห้อง = หนึ่งทีม ทุกคนช่วยกันยิงสะเก็ดดาวสะสม Team Score ร่วมกัน"""

    def __init__(self, code):
        self.lock = threading.RLock()
        self.code = code
        self.created = time.time()
        self.players = []
        self.by_token = {}

        self.state = "lobby"             # lobby | countdown | playing | qte | ended

        self.round_id = 0
        self.seed = 0
        self.schedule = []               # ตารางอุกกาบาตทั้งรอบ
        self.destroyed = {}              # meteorId -> slot ที่ยิงได้ (dedupe)
        self.missed = set()                 # meteorId -> ที่หลุดไปชนยาน
        self.ship_hp = C.SHIP_MAX_HP        # พลังเกราะยาน Long March 5 (200 HP)
        self.ship_max_hp = C.SHIP_MAX_HP
        self.start_ms = 0.0
        self.end_ms = 0.0

        # ── คะแนนรายทีม (Team Score & Combo) ──
        self.team_score = 0
        self.team_combo = 0
        self.team_best_combo = 0
        self.team_last_kill_ms = -1e9
        self.kills = 0                   # ผลรวมของทั้งทีม
        self.last_board = None
        self.storm_total = 0
        self.storm_hits = 0
        self.damage = {}                 # meteorId -> โดนยิงไปกี่นัดแล้ว

        # ── QTE ปิดท้ายรอบ ──
        self.qte_wire = None             # ลูกไฟดวงสุดท้าย (จัดไว้ตั้งแต่ตอนเริ่มรอบ)
        self.qte_need = 0
        self.qte_hits = 0
        self.qte_start_ms = 0.0
        self.qte_end_ms = 0.0
        self.qte_by_slot = {}            # slot -> รัวได้กี่ครั้ง
        self._qte_last_tap = {}          # sid -> เวลาแตะล่าสุด (กันรัวเกินมนุษย์)

        self.ended_ms = 0.0
        self.arrived_at_moon = False
        self.ending_type = "normal"
        # คนที่ "ดู" อย่างเดียว ไม่กินสล็อต ไม่นับเป็นผู้เล่น (จอ admin)
        self.watchers = set()

    # ══ ผู้เล่น ══════════════════════════════════════════════
    def join(self, token, sid):
        """คนเดิมกลับมา = slot เดิม / คนใหม่ = เพิ่ม slot ต่อท้าย"""
        with self.lock:
            if token and token in self.by_token:
                p = self.by_token[token]
                p.sid = sid
                p.last_seen = time.time()
                return p, token, False

            if len(self.players) >= C.MAX_SLOTS:
                return None, None, False

            slot = len(self.players) + 1
            meta = PLAYER_COLORS[(slot - 1) % len(PLAYER_COLORS)]
            p = Player(meta, slot)
            tok = secrets.token_urlsafe(12)
            p.token = tok
            p.sid = sid
            p.last_seen = time.time()
            self.players.append(p)
            self.by_token[tok] = p
            return p, tok, True

    def watch(self, sid):
        with self.lock:
            self.watchers.add(sid)

    def unwatch(self, sid):
        with self.lock:
            self.watchers.discard(sid)

    def has_sid(self, sid):
        with self.lock:
            return sid in self.watchers or self.player_of_sid(sid) is not None

    def player_of_sid(self, sid):
        with self.lock:
            for p in self.players:
                if p.sid == sid:
                    return p
            return None

    def leave(self, sid):
        with self.lock:
            p = self.player_of_sid(sid)
            if p:
                p.sid = None
                p.last_seen = time.time()
            return p

    def active(self):
        return [p for p in self.players if p.taken]

    def set_name(self, sid, name):
        """ตั้งชื่อของตัวเอง — คืน Player ถ้าสำเร็จ, None ถ้าไม่ใช่ผู้เล่นในห้อง"""
        with self.lock:
            p = self.player_of_sid(sid)
            if p is None:
                return None
            p.name = name
            return p

    def name_taken(self, name, exclude=None):
        """ชื่อซ้ำกับคนอื่นในห้องไหม — บอร์ดรายบุคคลจะได้ไม่มีสองแถวชื่อเดียวกัน"""
        low = (name or "").strip().lower()
        with self.lock:
            return any(p is not exclude and (p.name or "").lower() == low
                       for p in self.players)

    def unnamed(self):
        """คนที่ยังไม่พิมพ์ชื่อ — เริ่มรอบไม่ได้ถ้ายังเหลือ"""
        return [p for p in self.active() if not p.named]

    def total_score(self):
        """คะแนนรวมของทั้งทีม"""
        with self.lock:
            return self.team_score

    def connected_count(self):
        return sum(1 for p in self.players if p.connected)

    def set_player_role(self, sid, role):
        """กำหนดหน้าที่: 'ground' (ภาคพื้น) หรือ 'spaceship' (ผู้ควบคุมยาน จำกัด 1 คน)"""
        with self.lock:
            p = self.player_of_sid(sid)
            if not p:
                return None
            if role == "spaceship":
                for other in self.players:
                    if other.role == "spaceship" and other != p:
                        other.role = "ground"
                p.role = "spaceship"
            else:
                p.role = "ground"
            return p

    def has_spaceship_pilot(self):
        with self.lock:
            return any(p.role == "spaceship" for p in self.active())

    def pulse_shield(self, sid):
        """ผู้ควบคุมยานเปิดใช้งาน Energy Pulse ฟื้นฟูเกราะยาน +15 HP"""
        with self.lock:
            p = self.player_of_sid(sid)
            if not p or p.role != "spaceship" or self.state not in ("playing", "qte"):
                return None
            heal = 15
            self.ship_hp = min(self.ship_max_hp, self.ship_hp + heal)
            return {
                "kind": "shield_pulse",
                "slot": p.slot,
                "name": p.display,
                "hex": p.hex,
                "heal": heal,
                "shipHp": self.ship_hp,
                "shipMaxHp": self.ship_max_hp,
            }

    def empty_for(self, seconds):
        """ห้างร้างมานานพอจะเก็บทิ้งหรือยัง"""
        with self.lock:
            if self.connected_count():
                return False
            last = max([p.last_seen for p in self.players] + [self.created])
            return time.time() - last > seconds

    # ══ รอบ ══════════════════════════════════════════════════
    def start_round(self):
        """สร้างตารางอุกกาบาตทั้งรอบแล้วเข้าสู่ countdown"""
        with self.lock:
            self.round_id += 1
            self.seed = secrets.randbelow(2 ** 31)
            self.destroyed = {}
            self.missed = set()
            self.ship_hp = C.SHIP_MAX_HP
            self.team_score = 0
            self.team_combo = 0
            self.team_best_combo = 0
            self.team_last_kill_ms = -1e9
            self.kills = 0
            self.last_board = None
            self.storm_total = 0
            self.storm_hits = 0
            self.damage = {}
            self.qte_hits = 0
            self.qte_by_slot = {}
            self._qte_last_tap = {}
            self.qte_start_ms = 0.0
            self.qte_end_ms = 0.0

            # ถ้ายังไม่มีใครเลือกควบคุมยาน ให้คนแรกเป็นคนควบคุมยานอัตโนมัติ
            active_p = self.active()
            if active_p and not any(p.role == "spaceship" for p in active_p):
                active_p[0].role = "spaceship"

            for p in self.players:
                p.reset_round()

            self.schedule = self._build_schedule()
            self.state = "countdown"
            t = now_ms()
            self.start_ms = t + C.COUNTDOWN_SEC * 1000
            self.end_ms = self.start_ms + C.ROUND_SEC * 1000
            return self.schedule

    def _build_schedule(self):
        """
        ตารางทั้งรอบ 2 เฟส:
          0:00-0:50 ปกติ  — ดวงทั่วไป ยิงนัดเดียวแตก
          0:50-1:15 พายุ  — เฉพาะดวงที่ไหม้เร็ว ถี่ขึ้น ยิง 2-5 นัดถึงแตก

        ทั้งสองเฟสใช้ข้อมูลจริงจาก GMN ทั้งหมด พายุแค่ *คัด* กลุ่มที่ไหม้เร็ว
        ไม่ได้แต่งดวงขึ้นมาใหม่ (ดู CLAUDE.md)
        """
        rng = random.Random(self.seed)
        n_players = max(1, len(self.active()))

        # spawnRate สเกลตามจำนวนคน → งานต่อหัวเท่ากันไม่ว่าทีมใหญ่หรือเล็ก
        rate = C.SPAWN_RATE_PER_MIN * n_players

        out = []
        mid = 1

        # ── เฟสปกติ ──
        norm_sec = C.STORM_START_SEC
        n_norm = max(1, int(norm_sec / 60.0 * rate * C.SCHEDULE_MARGIN))
        gap = norm_sec * 1000.0 / n_norm
        for i, ev in enumerate(gmn_db.pick(n_norm)):
            t0 = max(0.0, i * gap + (rng.random() - 0.5) * gap * C.SPAWN_JITTER)
            w = self._to_wire(mid, min(t0, norm_sec * 1000 - 1), ev, rng)
            w["storm"] = False
            w["hp"] = 1
            out.append(w); mid += 1

        # ── เฟสพายุ ──
        storm_sec = C.STORM_END_SEC - C.STORM_START_SEC
        n_storm = max(1, C.STORM_METEORS_PER_PLAYER * n_players)
        gap = storm_sec * 1000.0 / n_storm
        storm_where = f"duration IS NOT NULL AND duration <= {C.STORM_MAX_DURATION}"
        for i, ev in enumerate(_fill(gmn_db.pick(n_storm, where=storm_where), n_storm)):
            t0 = C.STORM_START_SEC * 1000 + max(0.0, i * gap + (rng.random() - 0.5) * gap * 0.5)
            w = self._to_wire(mid, t0, ev, rng)
            w["storm"] = True
            w["hp"] = _storm_hp(ev.get("mag"))
            out.append(w); mid += 1
            self.storm_total += 1

        out.sort(key=lambda w: w["t0"])

        # ── ลูกไฟดวงสุดท้าย (QTE) ──
        # จัดไว้ตั้งแต่ตอนนี้ จะได้ไม่ต้อง query DB ตอนจังหวะหมดเวลา
        self.qte_wire = self._build_qte(mid, rng)
        self.qte_need = C.QTE_TAPS_PER_PLAYER * n_players
        return out

    def _build_qte(self, mid, rng):
        """ดวงจริงที่ mag สว่างระดับ fireball และอยู่กลางซุ้ม — ทุกคนต้องเห็นพร้อมกัน"""
        # ดวงสว่างระดับ fireball มีแค่ 7,694 จาก 472,388 ดวง (1.6%)
        # บวกกับเงื่อนไข "ต้องอยู่กลางซุ้มตอนนี้" → วัดจริงแล้วพลาด 2 ใน 10 รอบ
        # รอบที่พลาดคือจบเกมดื้อๆ ไม่มีฉากปิดท้าย — หน้างานจริงยอมไม่ได้
        # เลยค่อยๆ ขยายเงื่อนไขแทน — ยังเป็นดวงจริงทุกขั้น ไม่ได้แต่งขึ้นมาสักดวง
        bright = f"mag IS NOT NULL AND mag <= {C.QTE_MAG_MAX}"
        plans = [
            (bright, C.QTE_YAW_LIMIT_DEG),          # สว่างมาก + อยู่กลางซุ้ม
            (bright, C.YAW_LIMIT_DEG),              # สว่างมาก ที่ไหนในซุ้มก็ได้
            ("mag IS NOT NULL AND mag <= 0", C.YAW_LIMIT_DEG),
            ("1=1", C.YAW_LIMIT_DEG),               # ท้ายสุด ดวงไหนก็ได้ ขอให้มีฉากปิดท้าย
        ]
        ev = None
        for where, lim in plans:
            ev = gmn_db.pick(1, yaw_limit_deg=lim, where=where, max_tries_each=200)
            if ev:
                break
        if not ev:
            return None
        w = self._to_wire(mid, 0.0, ev[0], rng)
        w["storm"] = False
        w["qte"] = True
        w["hp"] = 0                      # ยิงไม่แตก — มันไหม้หมดเองเมื่อจบ QTE
        w["size"] = round(w["size"] * C.QTE_SIZE_MULT, 3)
        w["flightSec"] = float(C.QTE_SEC)   # จังหวะของช่วง QTE ไม่ใช่ตัวคูณเวลาทั้งเกม
        return w

    def _to_wire(self, mid, t0, ev, rng):
        """เหตุการณ์จริง → พารามิเตอร์เส้นทางที่ client เอาไปเดินต่อเองได้"""
        import math
        yaw0 = math.radians(ev["yawDeg"])
        pitch0 = math.radians(ev["altDeg"])

        # วางจุดเกิดตามแนวเรดิแอนต์ที่ระยะคงที่ (ไม่ใช่ระยะแนวนอนคงที่)
        # ไม่งั้นดวงที่เรดิแอนต์เกือบกลางหัวจะถูกดันขึ้นไปสูงเป็นหมื่นเมตรจาก tan()
        R = C.GMN_SPAWN_RANGE
        dist0 = max(40.0, R * math.cos(pitch0))
        alt0 = R * math.sin(pitch0)

        vt = _clamp01((ev["vgeo"] - C.GMN_VGEO_SLOW) / (C.GMN_VGEO_FAST - C.GMN_VGEO_SLOW))
        flight = C.FLIGHT_SEC_MAX + (C.FLIGHT_SEC_MIN - C.FLIGHT_SEC_MAX) * vt

        mag = ev["mag"] if ev["mag"] is not None else C.GMN_MAG_DIM
        mt = _clamp01((C.GMN_MAG_DIM - mag) / (C.GMN_MAG_DIM - C.GMN_MAG_BRIGHT))
        size = C.SIZE_MIN + (C.SIZE_MAX - C.SIZE_MIN) * mt

        lim = math.radians(C.YAW_LIMIT_DEG - C.YAW_MARGIN_DEG)
        drift = (rng.random() - 0.5) * 2 * math.radians(C.YAW_DRIFT_DEG)

        return {
            "id": mid,
            "t0": round(t0, 1),                     # ms นับจากเริ่มรอบ
            "yaw0": round(yaw0, 5),
            "dist0": round(dist0, 2),
            "alt0": round(alt0, 2),
            "yawImpact": round(max(-lim, min(lim, yaw0 + drift)), 5),
            "distImpact": round(C.IMPACT_DIST_MIN
                                + rng.random() * (C.IMPACT_DIST_MAX - C.IMPACT_DIST_MIN), 2),
            "flightSec": round(flight, 3),
            "size": round(size, 3),
            "spin": [round(rng.random() * 2 - 1, 3), round(rng.random() * 2 - 1, 3),
                     round(rng.random() * 2 - 1, 3), round((rng.random() * 2 - 1) * C.SPIN_SPEED, 3)],
            "gmn": ev,
        }

    def begin_play(self):
        with self.lock:
            if self.state == "countdown":
                self.state = "playing"

    def tick(self):
        """คืน 'qte' / 'end' ตอนเปลี่ยนสถานะ นอกนั้น None

        หมด 1:15 แล้วไม่จบทันที — เข้า QTE ลูกไฟดวงสุดท้ายก่อน
        (ถ้าคิว GMN ว่างจนหาดวง fireball ไม่ได้ ก็จบเลย ไม่แต่งดวงขึ้นมา)
        """
        with self.lock:
            t = now_ms()
            if self.state == "countdown" and t >= self.start_ms:
                self.state = "playing"
            if self.state == "playing" and t >= self.end_ms:
                if self.qte_wire is not None:
                    self.state = "qte"
                    self.qte_start_ms = t
                    self.qte_end_ms = t + C.QTE_SEC * 1000
                    return "qte"
                self.state = "ended"
                self.ended_ms = t
                return "end"
            if self.state == "qte" and t >= self.qte_end_ms:
                self.state = "ended"
                self.ended_ms = t
                return "end"
            return None

    def time_left_ms(self):
        with self.lock:
            if self.state == "countdown":
                return C.ROUND_SEC * 1000
            if self.state != "playing":
                return 0
            return max(0.0, self.end_ms - now_ms())

    def qte_left_ms(self):
        with self.lock:
            if self.state != "qte":
                return 0
            return max(0.0, self.qte_end_ms - now_ms())

    # ══ QTE — รัวยิงลูกไฟดวงสุดท้ายพร้อมกันทั้งทีม ══
    def qte_tap(self, sid):
        """
        นับเฉพาะตอนอยู่ในหน้าต่าง QTE จริงๆ และต้องเป็นผู้เล่นในห้อง

        มีเพดานความถี่ต่อคน — ไม่งั้นเปิด console แล้ว emit รัวก็จบเกม
        (เด็กงานโรงเรียนทำแน่ ไม่ใช่ข้อสมมติ)
        """
        with self.lock:
            if self.state != "qte":
                return None
            p = self.player_of_sid(sid)
            if p is None:
                return None
            t = now_ms()
            if t - self._qte_last_tap.get(sid, -1e9) < C.QTE_MIN_TAP_MS:
                return None
            self._qte_last_tap[sid] = t
            self.qte_hits += 1
            self.qte_by_slot[p.slot] = self.qte_by_slot.get(p.slot, 0) + 1
            return {"hits": self.qte_hits, "need": self.qte_need,
                    "slot": p.slot, "hex": p.hex}

    def qte_result(self):
        """คืน (ผ่านไหม, โบนัส, สัดส่วน) — ไม่ครบก็ได้ตามสัดส่วน ไม่มีหักคะแนน"""
        with self.lock:
            if not self.qte_need or self.qte_wire is None:
                return False, 0, 0.0
            rate = min(1.0, self.qte_hits / self.qte_need)
            return self.qte_hits >= self.qte_need, int(round(C.QTE_BONUS * rate)), rate

    # ══ ยิงโดน — dedupe ล้วนๆ ไม่มี rollback ไม่มี reconcile ══
    def claim_kill(self, sid, meteor_id):
        """
        client บอกว่ายิงโดนดวงไหน — server ตัดสินคนเดียว

        ช่วงพายุดวงหนึ่งต้องยิงหลายนัด: นัดที่ยังไม่ครบคืน state 'damaged'
        ให้ทุกเครื่องหดก้อนพร้อมกัน ครบแล้วถึงจะ 'destroyed'
        ยิงซ้ำดวงที่แตกไปแล้ว = เงียบๆ ไม่ได้แต้ม ไม่ error
        """
        with self.lock:
            if self.state != "playing":
                return None
            p = self.player_of_sid(sid)
            if p is None or meteor_id in self.destroyed:
                return None

            wire = next((w for w in self.schedule if w["id"] == meteor_id), None)
            if wire is None:
                return None

            need = max(1, int(wire.get("hp", 1)))
            done = self.damage.get(meteor_id, 0) + 1
            self.damage[meteor_id] = done

            if done < need:
                return {"kind": "damaged", "meteorId": meteor_id, "slot": p.slot,
                        "hex": p.hex, "done": done, "need": need}

            self.destroyed[meteor_id] = p.slot

            # คะแนนและคอมโบรวมของทั้งทีม (Team Score & Team Combo)
            t = now_ms()
            if t - self.team_last_kill_ms > C.COMBO_WINDOW_MS:
                self.team_combo = 0
            self.team_combo = min(C.COMBO_MAX, self.team_combo + 1)
            self.team_best_combo = max(self.team_best_combo, self.team_combo)
            self.team_last_kill_ms = t

            p.combo = self.team_combo
            p.best_combo = max(p.best_combo, p.combo)
            p.last_kill_ms = t

            gained = C.SCORE_PER_HIT * self.team_combo
            self.team_score += gained
            p.score += gained
            p.kills += 1
            self.kills += 1

            # ยิงสกัดกั้นสำเร็จ -> ช่วยฟื้นฟูเกราะยานเล็กน้อย (Telemetry Buff)
            if self.ship_hp < self.ship_max_hp:
                self.ship_hp = min(self.ship_max_hp, self.ship_hp + C.SHIP_REPAIR_ON_COMBO)

            # ศึกเดือดยังนับรวมทั้งห้องเหมือนเดิม — event พิเศษต้องช่วยกัน
            if wire.get("storm"):
                self.storm_hits += 1

            return {"kind": "destroyed", "meteorId": meteor_id, "slot": p.slot, "hex": p.hex,
                    "name": p.display, "role": p.role,
                    "gained": gained, "score": self.team_score, "teamScore": self.team_score,
                    "combo": self.team_combo, "teamCombo": self.team_combo,
                    "kills": p.kills, "roomKills": self.kills,
                    "shipHp": self.ship_hp, "shipMaxHp": self.ship_max_hp,
                    "stormHits": self.storm_hits, "stormTotal": self.storm_total}

    def record_miss(self, meteor_id):
        """
        อุกกาบาตที่ยิงสกัดไม่ทันและหลุดเข้าสู่แนวเส้นทางของยาน Long March 5
        ดาเมจคิดตามความเร็วจริง (vgeo จาก GMN): ยิ่งเร็ว พลังงานจลน์ยิ่งสูง (max 20)
        """
        with self.lock:
            if self.state not in ("playing", "qte"):
                return None
            if meteor_id in self.destroyed or meteor_id in self.missed:
                return None

            wire = next((w for w in self.schedule if w["id"] == meteor_id), None)
            if wire is None:
                return None

            self.missed.add(meteor_id)
            v = 25.0
            if wire.get("gmn") and wire["gmn"].get("vgeo") is not None:
                v = float(wire["gmn"]["vgeo"])

            dmg = int(round(v / C.SHIP_DMG_SPEED_DIV))
            dmg = max(C.SHIP_MIN_DAMAGE, min(C.SHIP_MAX_DAMAGE, dmg))
            self.ship_hp = max(0, self.ship_hp - dmg)

            return {
                "kind": "ship_damage",
                "meteorId": meteor_id,
                "dmg": dmg,
                "speed": round(v, 1),
                "shipHp": self.ship_hp,
                "shipMaxHp": self.ship_max_hp,
                "emergency": self.ship_hp <= 0,
                "shower": (wire.get("gmn") or {}).get("shower", "Meteor"),
            }

    def calc_rank(self):
        """ระดับความสำเร็จของภารกิจ Thailand CE-7 Moonshot"""
        if self.ship_hp <= 0:
            return "F"
        if self.arrived_at_moon:
            return "S"
        if self.ship_hp >= 40:
            return "A"
        return "B"

    def ended_for(self, seconds):
        with self.lock:
            return self.state == "ended" and self.ended_ms and \
                (now_ms() - self.ended_ms) > seconds * 1000

    def to_lobby(self):
        """
        จบรอบแล้วกลับไปรอรอบใหม่ — ห้องเดิม รหัสเดิม เด็กชุดใหม่เข้าได้เลย
        """
        with self.lock:
            self.state = "lobby"
            self.schedule = []
            self.destroyed = {}
            self.missed = set()
            self.ship_hp = C.SHIP_MAX_HP
            self.arrived_at_moon = False
            self.ending_type = "normal"
            self.team_score = 0
            self.team_combo = 0
            self.team_best_combo = 0
            self.team_last_kill_ms = -1e9
            self.damage = {}
            self.ended_ms = 0.0
            self.kills = 0
            self.storm_total = 0
            self.storm_hits = 0
            self.qte_wire = None
            self.qte_need = 0
            self.qte_hits = 0
            self.qte_by_slot = {}
            self._qte_last_tap = {}
            self.qte_start_ms = 0.0
            self.qte_end_ms = 0.0

            # เหลือเฉพาะคนที่ยังต่ออยู่ (สล็อต/สีคงเดิม ไม่เรียงใหม่ กันสีเพี้ยน)
            keep = [p for p in self.players if p.connected]
            self.players = keep
            self.by_token = {t: p for t, p in self.by_token.items() if p in keep}
            for p in keep:
                p.reset_round()

    def storm_result(self):
        """คืน (ผ่านไหม, ตัวคูณ, อัตราส่วน)"""
        with self.lock:
            if not self.storm_total:
                return True, C.STORM_PASS_MULT, 1.0
            rate = self.storm_hits / self.storm_total
            passed = rate >= C.STORM_PASS_RATE
            return passed, (C.STORM_PASS_MULT if passed else C.STORM_FAIL_MULT), rate

    def phase(self):
        """'lobby' | 'normal' | 'storm' | 'ended'"""
        with self.lock:
            if self.state == "qte":
                return "qte"
            if self.state != "playing":
                return self.state
            el = (now_ms() - self.start_ms) / 1000.0
            return "storm" if el >= C.STORM_START_SEC else "normal"

    def note_shot(self, sid):
        with self.lock:
            p = self.player_of_sid(sid)
            if p:
                p.shots += 1

    # ══ สรุป ═════════════════════════════════════════════════
    def public(self):
        with self.lock:
            return {
                "code": self.code, "state": self.state,
                "phase": self.phase(),
                "stormHits": self.storm_hits, "stormTotal": self.storm_total,
                "stormStartSec": C.STORM_START_SEC, "stormPassRate": C.STORM_PASS_RATE,
                "roundId": self.round_id,
                "players": [p.public() for p in self.players],
                "totalScore": self.total_score(),
                "teamScore": self.team_score,
                "teamCombo": self.team_combo,
                "kills": self.kills,
                "timeLeftMs": round(self.time_left_ms()),
                "qteLeftMs": round(self.qte_left_ms()),
                "qteHits": self.qte_hits, "qteNeed": self.qte_need,
                "playerCount": len(self.active()),
                "shipHp": self.ship_hp,
                "shipMaxHp": self.ship_max_hp,
                "missionRank": self.calc_rank(),
            }


def _fill(events, n):
    """
    DB คืนมาไม่ครบ n ดวง → วนใช้ดวงที่ได้มาซ้ำจนครบ

    ยังเป็นข้อมูลจริง 100% — ไม่ใช่การแต่งดวงขึ้นมา แค่เอาดวงที่มีมาหมุนซ้ำ
    (ตอนนี้ filter ช่วงศึกเดือดโดน 176,269 แถว ไม่มีทางขาด — มีไว้เผื่ออนาคต)
    """
    if not events:
        return []
    if len(events) >= n:
        return events[:n]
    return [events[i % len(events)] for i in range(n)]


def _storm_hp(mag):
    """ก้อนสว่าง = ใหญ่ = ทนกว่า — จำนวนนัดมาจาก mag จริง ไม่ได้สุ่ม"""
    if mag is None:
        return 3
    for threshold, hp in C.STORM_HP_BY_MAG:
        if mag <= threshold:
            return hp
    return 2


def _clamp01(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


# ══════════════════════════════════════════════════════════
# ทะเบียนห้อง
# ══════════════════════════════════════════════════════════
class Rooms:
    def __init__(self):
        self.lock = threading.RLock()
        self.rooms = {}

    def create(self):
        with self.lock:
            self._gc()
            for _ in range(200):
                code = "HT%03d" % secrets.randbelow(1000)
                if code not in self.rooms:
                    r = Room(code)
                    self.rooms[code] = r
                    return r
            return None                   # ห้องเต็ม 1000 ห้องพร้อมกัน (ไม่น่าเกิด)

    def primary(self):
        """
        ห้องหลักของบูธ — มีใบเดียว ถ้าหายก็สร้างใหม่

        บูธมีจอเดียว รหัสเดียว ถ้าปล่อยให้ create() ทุกครั้งที่ admin refresh
        รหัสบนจอจะเปลี่ยนไปเรื่อยๆ แล้วเด็กที่พิมพ์รหัสเก่าจะเข้าไม่ได้

        ตั้งแต่ 2026-08-24 ไม่มีห้องแยกของ admin แล้ว — admin ลงเล่นห้องนี้
        ห้องเดียวกับเด็ก แย่งอุกกาบาตชุดเดียวกันจริงๆ (ดู CLAUDE.md)
        """
        with self.lock:
            for r in self.rooms.values():
                return r
            return self.create()

    def drop(self, code):
        with self.lock:
            self.rooms.pop((code or "").strip().upper(), None)

    def get(self, code):
        with self.lock:
            return self.rooms.get((code or "").strip().upper())

    def room_of_sid(self, sid):
        """หา room จาก sid — ผู้เล่นก่อน ถ้าไม่ใช่ค่อยดูคนที่กำลังดูอยู่"""
        with self.lock:
            for r in self.rooms.values():
                if r.player_of_sid(sid):
                    return r
            for r in self.rooms.values():
                if sid in r.watchers:
                    return r
            return None

    def all(self):
        with self.lock:
            return list(self.rooms.values())

    def _gc(self):
        dead = [c for c, r in self.rooms.items()
                if not r.watchers and r.empty_for(C.ROOM_TTL_SEC)]
        for c in dead:
            self.rooms.pop(c, None)
