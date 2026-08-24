"""game/board.py — leaderboard รายบุคคล ที่ต้องรอดข้ามการ restart

spec §6 เตือนไว้ตรงๆ: "free hoster ส่วนใหญ่ใช้ ephemeral filesystem — restart แล้วไฟล์หาย
leaderboard หายกลางงาน = บูธพัง"

เลยเขียน 2 ชั้นพร้อมกันทุกครั้งที่มีคะแนนใหม่:
  1. SQLite  data/leaderboard.db   ← ตัวหลัก query ง่าย
  2. JSON    data/leaderboard.json ← สำเนาที่ดาวน์โหลดออกไปเก็บได้ทันที

ถ้า hoster ล้าง fs ทั้งคู่ก็หาย — เลยต้องมีปุ่ม "สำรองข้อมูล" บนจอ admin (§7)
ที่ดึง JSON ก้อนนี้ไปเก็บไว้เครื่องตัวเอง อย่างน้อยกู้คืนได้

── เปลี่ยนเมื่อ 2026-08-24 (ตามที่เจ้าของงานสั่ง) ──────────────────
เดิม: 1 แถว = 1 ทีม · เรียงด้วยคะแนนต่อหัว · บอร์ด admin แยกจากบอร์ดเด็ก
ตอนนี้: **1 แถว = 1 คน · เรียงด้วยคะแนนของคนคนนั้น · บอร์ดเดียวรวม admin ด้วย**

ไม่ต้องหารด้วยจำนวนคนอีกแล้ว เพราะทุกคนยิงเก็บคะแนนของตัวเอง
คนในห้องใหญ่ไม่ได้เปรียบโดยอัตโนมัติ — อุกกาบาตชุดเดียวกันแต่ต้องแย่งกันยิง
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
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,      -- ชื่อที่เจ้าตัวพิมพ์เอง (admin ใช้ชื่อตายตัว)
    score        INTEGER NOT NULL,   -- คะแนนหลังคูณพายุ + โบนัส QTE  ← ใช้เรียงบอร์ด
    raw_score    INTEGER NOT NULL,   -- ก่อนคูณ (ไว้ตรวจย้อนหลัง)
    kills        INTEGER NOT NULL,
    best_combo   INTEGER NOT NULL,
    storm_passed INTEGER NOT NULL,   -- ผลรวมของทั้งห้อง ไม่ใช่ของคนเดียว
    qte_passed   INTEGER NOT NULL,   -- เหมือนกัน — event พิเศษต้องช่วยกัน
    is_admin     INTEGER NOT NULL,   -- ไว้ติดป้ายเฉยๆ **ไม่ได้แยกบอร์ด**
    round_no     INTEGER NOT NULL,   -- รอบที่เท่าไรของงาน
    ts           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score ON scores(score DESC);

-- นับ "จำนวนรอบที่เล่นไปแล้ว" แยกจากจำนวนแถว
-- เพราะตอนนี้ 1 รอบมีหลายแถว (แถวละคน) นับแถวแล้วจะได้เลขเฟ้อทันที
CREATE TABLE IF NOT EXISTS rounds (
    id      INTEGER PRIMARY KEY,
    players INTEGER NOT NULL,
    ts      REAL NOT NULL
);
"""


def _conn():
    global _con
    if _con is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _con = sqlite3.connect(DB_PATH, check_same_thread=False)
        _con.row_factory = sqlite3.Row
        _migrate(_con)
        _con.executescript(SCHEMA)
        _con.commit()
    return _con


def _migrate(c):
    """
    ตาราง scores ของเดิมเก็บแถวละ *ทีม* คนละหน้าตากับของใหม่

    ถ้าเจอของเก่าให้เปลี่ยนชื่อเก็บไว้เฉยๆ ไม่ลบทิ้ง — คะแนนของงานที่ผ่านมาแล้ว
    ไม่ใช่ของที่จะมาโยนทิ้งเพราะเราเปลี่ยนกติกา (ดึงกลับด้วย SQL ได้ถ้าอยากได้)
    """
    try:
        cols = [r[1] for r in c.execute("PRAGMA table_info(scores)")]
    except sqlite3.Error:
        return
    if cols and "name" not in cols:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        c.execute(f"ALTER TABLE scores RENAME TO scores_team_{stamp}")
        c.commit()
        print(f"[board] เจอบอร์ดแบบทีมของเดิม — ย้ายไปเก็บที่ scores_team_{stamp} "
              f"แล้วเริ่มบอร์ดรายบุคคลใหม่", flush=True)


def submit_round(entries, storm_mult, bonus, storm_passed, qte_passed, team_score=None, team_kills=None, team_best_combo=None, code=""):
    """
    บันทึกผลรอบ — **1 แถวต่อ 1 ทีม** (Team Score Leaderboard)
    """
    with _lock:
        c = _conn()
        ts = time.time()
        cur = c.execute("INSERT INTO rounds (players, ts) VALUES (?,?)",
                        (len(entries), ts))
        round_no = c.execute("SELECT COUNT(*) FROM rounds").fetchone()[0]

        if team_score is None:
            team_score = sum(int(e.get("raw", 0)) for e in entries)
        raw = int(team_score)
        final = int(round(raw * storm_mult)) + int(bonus)

        kills = int(team_kills if team_kills is not None else sum(int(e.get("kills", 0)) for e in entries))
        best_combo = int(team_best_combo if team_best_combo is not None else max([int(e.get("bestCombo", 0)) for e in entries] + [0]))

        member_names = [e.get("name") or "?" for e in entries if e.get("name")]
        team_label = f"ทีม {code}" if code else "ทีมผู้พิทักษ์"
        if member_names:
            team_label += f" ({', '.join(member_names)})"

        is_admin_team = any(e.get("isAdmin") for e in entries)

        cur = c.execute(
            "INSERT INTO scores (name, score, raw_score, kills, best_combo,"
            " storm_passed, qte_passed, is_admin, round_no, ts)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (team_label, final, raw, kills, best_combo,
             1 if storm_passed else 0, 1 if qte_passed else 0,
             1 if is_admin_team else 0, round_no, ts))
        row_id = cur.lastrowid
        c.commit()

        rank = c.execute(
            "SELECT COUNT(*)+1 FROM scores WHERE score > ?", (final,)).fetchone()[0]
        _export_json()

        player_rows = []
        for e in entries:
            player_rows.append({
                "slot": e.get("slot"),
                "name": e.get("name"),
                "role": e.get("role", "ground"),
                "score": final,
                "rawScore": raw,
                "kills": int(e.get("kills", 0)),
                "bestCombo": int(e.get("bestCombo", 0)),
                "rank": rank,
            })

        return {
            "teamRowId": row_id,
            "teamName": team_label,
            "teamScore": final,
            "teamRawScore": raw,
            "teamKills": kills,
            "teamBestCombo": best_combo,
            "teamRank": rank,
            "players": player_rows,
        }


def top(n=10):
    """บอร์ดเดียว รวม admin กับผู้เล่นไว้ด้วยกัน เรียงด้วยคะแนนตรงๆ"""
    with _lock:
        rows = _conn().execute(
            "SELECT * FROM scores ORDER BY score DESC, ts ASC LIMIT ?", (n,)).fetchall()
    return [_row(r, i + 1) for i, r in enumerate(rows)]


def total_rounds():
    with _lock:
        return _conn().execute("SELECT COUNT(*) FROM rounds").fetchone()[0]


def total_entries():
    with _lock:
        return _conn().execute("SELECT COUNT(*) FROM scores").fetchone()[0]


def rank_of(row_id):
    with _lock:
        c = _conn()
        r = c.execute("SELECT score FROM scores WHERE id=?", (row_id,)).fetchone()
        if not r:
            return None, 0
        rank = c.execute("SELECT COUNT(*)+1 FROM scores WHERE score > ?",
                         (r["score"],)).fetchone()[0]
        total = c.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
    return rank, total


def all_rows():
    with _lock:
        rows = _conn().execute(
            "SELECT * FROM scores ORDER BY score DESC, ts ASC").fetchall()
    return [_row(r, i + 1) for i, r in enumerate(rows)]


def reset():
    with _lock:
        c = _conn()
        c.execute("DELETE FROM scores")
        c.execute("DELETE FROM rounds")
        c.commit()
        _export_json()


def _row(r, rank):
    return {
        "rank": rank, "id": r["id"], "name": r["name"], "score": r["score"],
        "rawScore": r["raw_score"], "kills": r["kills"],
        "bestCombo": r["best_combo"],
        "stormPassed": bool(r["storm_passed"]), "qtePassed": bool(r["qte_passed"]),
        "isAdmin": bool(r["is_admin"]), "roundNo": r["round_no"], "ts": r["ts"],
    }


def _export_json():
    """เขียนสำเนา JSON ทุกครั้งที่บอร์ดเปลี่ยน — เรียกใต้ _lock แล้วเท่านั้น"""
    try:
        rows = _conn().execute(
            "SELECT * FROM scores ORDER BY score DESC, ts ASC").fetchall()
        data = {"exportedAt": time.time(), "count": len(rows),
                "rounds": _conn().execute("SELECT COUNT(*) FROM rounds").fetchone()[0],
                "scores": [_row(r, i + 1) for i, r in enumerate(rows)]}
        tmp = JSON_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, JSON_PATH)      # atomic — ไฟล์จะไม่เหลือครึ่งๆ ถ้าดับกลางคัน
    except OSError:
        pass
