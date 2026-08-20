"""game/board.py — leaderboard ที่ต้องรอดข้ามการ restart

spec §6 เตือนไว้ตรงๆ: "free hoster ส่วนใหญ่ใช้ ephemeral filesystem — restart แล้วไฟล์หาย
leaderboard หายกลางงาน = บูธพัง"

เลยเขียน 2 ชั้นพร้อมกันทุกครั้งที่มีคะแนนใหม่:
  1. SQLite  data/leaderboard.db   ← ตัวหลัก query ง่าย
  2. JSON    data/leaderboard.json ← สำเนาที่ดาวน์โหลดออกไปเก็บได้ทันที

ถ้า hoster ล้าง fs ทั้งคู่ก็หาย — เลยต้องมีปุ่ม "สำรองข้อมูล" บนจอ admin (§7)
ที่ดึง JSON ก้อนนี้ไปเก็บไว้เครื่องตัวเอง อย่างน้อยกู้คืนได้

**เรียงด้วยคะแนนหลังคูณตัวคูณความยากแล้วเท่านั้น** (§10 ห้ามเรียงด้วยคะแนนดิบ)
ไม่งั้นทีมที่เล่น Easy ครองบอร์ดทั้งวัน
"""

import json
import os
import sqlite3
import threading
import time

from . import config as C

_lock = threading.RLock()
_con = None

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "data", "leaderboard.db")
JSON_PATH = os.path.join(os.path.dirname(DB_PATH), "leaderboard.json")

SCHEMA = """
CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY,
    team        TEXT NOT NULL,
    score       INTEGER NOT NULL,   -- คะแนนหลังคูณพายุแล้ว
    raw_score   INTEGER NOT NULL,   -- ก่อนคูณ (ไว้ตรวจย้อนหลัง)
    per_head    REAL NOT NULL,      -- score / players  ← ใช้เรียงบอร์ด
    players     INTEGER NOT NULL,
    kills       INTEGER NOT NULL,
    storm_hits  INTEGER NOT NULL,
    storm_total INTEGER NOT NULL,
    storm_passed INTEGER NOT NULL,
    is_admin    INTEGER NOT NULL,   -- แยกบอร์ด admin ออกจากบอร์ดเด็กเด็ดขาด
    ts          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perhead ON scores(is_admin, per_head DESC);
"""


def _conn():
    global _con
    if _con is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _con = sqlite3.connect(DB_PATH, check_same_thread=False)
        _con.row_factory = sqlite3.Row
        _con.executescript(SCHEMA)
        _con.commit()
    return _con


def submit(team, raw_score, players, kills, storm_hits, storm_total,
           storm_passed, storm_mult, is_admin=False, bonus=0):
    """
    บันทึกผลรอบ คืน (row_id, คะแนนสุดท้าย, อันดับ)

    เรียงบอร์ดด้วย **คะแนนต่อหัว** ไม่ใช่คะแนนรวม
    ทีม 5 คนยิงได้มากกว่าทีม 1 คนโดยธรรมชาติ (เจออุกกาบาตเยอะกว่าตามสัดส่วน)
    หารด้วยจำนวนคนแล้วเทียบกันได้ตรงๆ ไม่มี magic number ไม่มีข้อครหาว่าโกง
    """
    players = max(1, int(players))
    # โบนัส QTE บวก *หลัง* คูณพายุ — ทีมที่พลาดพายุแต่รุมลูกไฟดวงสุดท้ายได้
    # ต้องได้โบนัสเต็ม ไม่ใช่โดนหารครึ่งไปด้วย
    final = int(round(raw_score * storm_mult)) + int(bonus)
    per_head = final / players

    with _lock:
        c = _conn()
        cur = c.execute(
            "INSERT INTO scores (team, score, raw_score, per_head, players, kills,"
            " storm_hits, storm_total, storm_passed, is_admin, ts)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (team, final, int(raw_score), per_head, players, int(kills),
             int(storm_hits), int(storm_total), 1 if storm_passed else 0,
             1 if is_admin else 0, time.time()))
        c.commit()
        rid = cur.lastrowid
        rank = c.execute(
            "SELECT COUNT(*)+1 FROM scores WHERE is_admin=? AND per_head > ?",
            (1 if is_admin else 0, per_head)).fetchone()[0]
        _export_json()
    return rid, final, rank


def top(n=10, is_admin=False):
    with _lock:
        rows = _conn().execute(
            "SELECT * FROM scores WHERE is_admin=? ORDER BY per_head DESC, ts ASC LIMIT ?",
            (1 if is_admin else 0, n)).fetchall()
    return [_row(r, i + 1) for i, r in enumerate(rows)]


def total_rounds():
    with _lock:
        return _conn().execute("SELECT COUNT(*) FROM scores").fetchone()[0]


def rank_of(row_id):
    with _lock:
        c = _conn()
        r = c.execute("SELECT score FROM scores WHERE id=?", (row_id,)).fetchone()
        if not r:
            return None, 0
        rank = c.execute("SELECT COUNT(*)+1 FROM scores WHERE score > ?", (r["score"],)).fetchone()[0]
        total = c.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
    return rank, total


def all_rows():
    with _lock:
        rows = _conn().execute("SELECT * FROM scores ORDER BY is_admin, per_head DESC, ts ASC").fetchall()
    return [_row(r, i + 1) for i, r in enumerate(rows)]


def reset():
    with _lock:
        c = _conn()
        c.execute("DELETE FROM scores")
        c.commit()
        _export_json()


def _row(r, rank):
    return {
        "rank": rank, "id": r["id"], "team": r["team"], "score": r["score"],
        "rawScore": r["raw_score"], "perHead": round(r["per_head"]),
        "players": r["players"], "kills": r["kills"],
        "stormHits": r["storm_hits"], "stormTotal": r["storm_total"],
        "stormPassed": bool(r["storm_passed"]), "isAdmin": bool(r["is_admin"]),
        "ts": r["ts"],
    }


def _export_json():
    """เขียนสำเนา JSON ทุกครั้งที่บอร์ดเปลี่ยน — เรียกใต้ _lock แล้วเท่านั้น"""
    try:
        rows = _conn().execute("SELECT * FROM scores ORDER BY is_admin, per_head DESC, ts ASC").fetchall()
        data = {"exportedAt": time.time(), "count": len(rows),
                "scores": [_row(r, i + 1) for i, r in enumerate(rows)]}
        tmp = JSON_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, JSON_PATH)      # atomic — ไฟล์จะไม่เหลือครึ่งๆ ถ้าดับกลางคัน
    except OSError:
        pass
