"""SpaceHT — Phase C server (บูธงานโรงเรียน)

    python app.py            ->  http://0.0.0.0:5000

สถาปัตยกรรม (spec §8): host ทุกอย่างไว้ที่เดียว
    [server]  Flask + SocketIO + SQLite (meteors.db อ่านอย่างเดียว, leaderboard อ่าน-เขียน)
        ↑                         ↑
    มือถือเด็ก (รันเกมเต็ม)     จอ admin

server **ไม่มี game loop** — แค่ 3 อย่าง:
    1. จัดตารางอุกกาบาตทั้งรอบตอนเริ่ม แล้วส่งไปทีเดียว
    2. dedupe ว่าใครยิงโดนดวงไหนก่อน
    3. เก็บ leaderboard
ที่เหลือมือถือเรนเดอร์และคำนวณเองหมด
"""

import os
import socket
import json
import threading

from flask import Flask, render_template, send_from_directory, request, jsonify, Response
from flask_socketio import SocketIO, join_room, leave_room

from game import config as C
from game import db as gmn_db
from game import board
from game.clock import now_ms
from game.rooms import Rooms
from game.words import clean_player_name

ROOT = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, template_folder="templates", static_folder=None)
app.config["SECRET_KEY"] = os.urandom(24)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*",
                    ping_timeout=25, ping_interval=10)

rooms = Rooms()

# ── สถานะตัวจับเวลาเบื้องหลัง ───────────────────────────
# เดิมเป็น bool `_bg_started` ตัวเดียว ซึ่งเชื่อถือไม่ได้ 2 กรณี:
#
#   1. **fork** ถ้า hoster สั่ง gunicorn --preload โมดูลจะถูก import ใน master
#      แล้วค่อย fork worker — เธรดไม่ข้าม fork มาด้วย (มีแต่เธรดที่เรียก fork
#      เท่านั้นที่รอด) แต่ `_bg_started = True` *ข้ามมา* → worker คิดว่าตัวจับเวลา
#      ทำงานอยู่ทั้งที่ไม่มี → รอบค้างที่ countdown ตลอดกาล ไม่มี tick สักตัว
#      ไม่มีอุกกาบาตขึ้นเลย และไม่มี error ให้เห็น (เจอบน Render จริง)
#   2. **เธรดตาย** exception หลุดออกจาก while True เมื่อไร ก็ไม่มีใครสตาร์ทใหม่
#
# เลยเก็บตัวเธรดกับ pid ไว้ตรงๆ แล้วเช็คของจริงทุกครั้งแทนการเชื่อ flag
_watcher = {
    "thread": None,
    "pid": None,
    "loops": 0,
    "last_ms": 0.0,
    "started_ms": 0.0,
    "restarts": 0,
    "error": None,
}
_watcher_lock = threading.Lock()


def safe(fn):
    """
    ห้าม handler ตายเงียบ

    Flask-SocketIO กลืน exception ใน handler โดย default → กดปุ่มแล้วไม่มีอะไรเกิดขึ้น
    ไม่มี error ให้เห็นทั้งฝั่ง server และ client ซึ่งหาสาเหตุแทบไม่ได้
    (เจอมาแล้ว: start_round เงียบสนิท ไม่มีร่องรอยอะไรเลย)
    หน้างานจริงยิ่งต้องมี — เด็กกดแล้วไม่ขึ้นอะไร เราต้องรู้ว่าเพราะอะไร
    """
    import functools
    import traceback

    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except Exception as e:
            traceback.print_exc()
            try:
                socketio.emit("error_msg",
                              {"msg": f"{type(e).__name__}: {e}", "where": fn.__name__},
                              to=request.sid)
            except Exception:
                pass
    return wrapper


# ══════════════════════════════════════════════════════════
# Routes
# ══════════════════════════════════════════════════════════
@app.route("/health")
def health():
    """
    endpoint แรกที่ต้องมีตอน deploy (§9 C1.1) — hoster ใช้เช็คว่าแอปยังไม่ตาย

    ต้องบอกสถานะ *ฐานข้อมูล* ด้วย ไม่ใช่แค่ ok:true
    เพราะแอปที่ DB หายยังตอบ 200 ได้ทุกอย่าง เปิดเกมได้ เข้าห้องได้ กดเริ่มได้
    ต่างกันแค่ฟ้าโล่งทั้งรอบ — ถ้า /health ไม่ฟ้อง จะไม่มีทางรู้ก่อนถึงหน้างาน
    """
    _ensure_bg()                      # เจอว่าตายเมื่อไร สตาร์ทใหม่ตรงนี้เลย
    db = gmn_db.diagnostics()
    w = watcher_status()
    return jsonify({
        # ok = พร้อมจัดงานจริง ไม่ใช่แค่ process ยังไม่ตาย
        # DB ครบแต่ตัวจับเวลาไม่เดิน = เกมค้าง countdown ไม่มีอุกกาบาต ต้องนับว่าไม่ ok
        "ok": bool(db["ok"] and db["meteors"] > 0 and w["alive"] and not w["stalled"]),
        "meteors": db["meteors"],
        "db": db,
        "watcher": w,
        "rooms": len(rooms.all()),
        "rounds_played": board.total_rounds(),
        "uptime_ms": round(now_ms()),
    })


@app.route("/")
@app.route("/play")
def page_play():
    # หน้าเดียวจบตั้งแต่กรอกรหัสห้องยันสรุปผล — ไม่เปลี่ยนหน้าเลย
    # เพราะการ navigate ระหว่างเล่นจะทำให้ socket หลุดและต้อง rejoin ใหม่ทุกครั้ง
    return render_template("play.html")


@app.route("/admin")
def page_admin():
    return render_template("admin.html")


@app.route("/api/leaderboard")
def api_board():
    """บอร์ดเดียวรายบุคคล — admin กับเด็กอยู่ตารางเดียวกัน แข่งกันตรงๆ"""
    return jsonify({
        "scores": board.top(20),
        "total": board.total_rounds(),
        "entries": board.total_entries(),
    })


@app.route("/api/backup")
def api_backup():
    """ปุ่ม 'สำรองข้อมูล' บนจอ admin — โหลดบอร์ดทั้งหมดไปเก็บเองกัน ephemeral fs"""
    if request.args.get("pw") != C.ADMIN_PASSWORD:
        return jsonify({"error": "unauthorized"}), 401
    data = {"scores": board.all_rows(), "total": board.total_rounds()}
    return Response(
        json.dumps(data, ensure_ascii=False, indent=1),
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=spaceht-leaderboard.json"})


@app.route("/api/gmn/stats")
def api_gmn_stats():
    s = gmn_db.stats()
    s["cameras"] = C.GMN_CAMERAS_WORLDWIDE
    s["countries_note"] = C.GMN_COUNTRIES
    return jsonify(s)


# static ของเกม (ยังไม่ใช้ npm/bundler — เสิร์ฟไฟล์ตรงๆ)
@app.route("/src/<path:fn>")
def src(fn):
    return _nocache(send_from_directory(os.path.join(ROOT, "src"), fn))


@app.route("/3D asset/<path:fn>")
def asset3d(fn):
    return _nocache(send_from_directory(os.path.join(ROOT, "3D asset"), fn))


@app.route("/static/<path:fn>")
def static_files(fn):
    return _nocache(send_from_directory(os.path.join(ROOT, "static"), fn))


def _nocache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


# ══════════════════════════════════════════════════════════
# Socket — ห้อง
# ══════════════════════════════════════════════════════════
def _emit_room(room, event="room", extra=None):
    payload = room.public()
    if extra:
        payload.update(extra)
    socketio.emit(event, payload, to=room.code)


@socketio.on("time_sync")
@safe
def on_time_sync(data=None):
    """หา offset นาฬิกา — อุกกาบาตทุกดวงอ้างอิงเวลา server ตัวเดียว"""
    _ensure_bg()      # client เรียกถี่ที่สุด ใช้เป็นจังหวะกู้ตัวจับเวลาได้ดีที่สุด
    socketio.emit("time_sync", {"c": (data or {}).get("c"), "s": now_ms()}, to=request.sid)


@socketio.on("admin_hello")
@safe
def on_admin_hello(data=None):
    """
    จอ admin เชื่อมต่อ — คืนรหัสห้องหลัก แล้ว **เข้า socket room ด้วย**

    บั๊กเดิม: admin ไม่เคย join_room(code) เลย ทำให้ event `room` / `tick` /
    `round_end` ที่ส่งแบบ to=room.code ไปไม่ถึงจอ admin → แผงควบคุมขึ้น "—"
    ตลอดกาล ทั้งที่ห้องทำงานปกติ
    """
    _ensure_bg()
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("admin_hello", {"ok": False}, to=request.sid)
        return
    room = rooms.primary()
    if room is None:
        socketio.emit("error_msg", {"msg": "สร้างห้องไม่ได้"}, to=request.sid)
        return
    room.watch(request.sid)
    join_room(room.code)
    socketio.emit("admin_hello", {
        "ok": True, "code": room.code,
        "meteors": gmn_db.count() if gmn_db.available() else 0,
    }, to=request.sid)
    _emit_room(room)


@socketio.on("create_room")
@safe
def on_create_room(data=None):
    """ห้องใหม่ — ต้องมีรหัส admin ไม่งั้นเด็กกดสร้างรัวจนรหัสบนจอเปลี่ยนตลอด"""
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    old = rooms.primary()
    if old is not None:
        old.unwatch(request.sid)
        leave_room(old.code)
        rooms.drop(old.code)
    r = rooms.create()
    if r is None:
        socketio.emit("error_msg", {"msg": "สร้างห้องไม่ได้"}, to=request.sid)
        return
    r.watch(request.sid)
    join_room(r.code)
    socketio.emit("room_created", {"code": r.code}, to=request.sid)
    _emit_room(r)


@socketio.on("spectate")
@safe
def on_spectate(data=None):
    """
    ดูอย่างเดียว ไม่กินสล็อต — ใช้กับ iframe ฝั่งซ้ายของจอ admin

    ได้ schedule เดียวกับผู้เล่นเป๊ะ เลยเห็นอุกกาบาตดวงเดียวกัน เวลาเดียวกัน
    แต่ยิงไม่ได้ (server ไม่รับ kill จากคนที่ไม่ใช่ผู้เล่นอยู่แล้ว)
    """
    _ensure_bg()
    code = ((data or {}).get("code") or "").strip().upper()
    room = rooms.get(code) or rooms.primary()
    if room is None:
        socketio.emit("join_failed", {"reason": "no_room", "msg": "ไม่เจอห้อง"},
                      to=request.sid)
        return
    room.watch(request.sid)
    join_room(room.code)
    socketio.emit("spectating", {
        "code": room.code, "serverMs": now_ms(),
    }, to=request.sid)
    if room.state in ("countdown", "playing", "qte"):
        socketio.emit("round_start", _round_payload(room), to=request.sid)
    _emit_room(room)


@socketio.on("join_room_code")
@safe
def on_join(data=None):
    _ensure_bg()
    d = data or {}
    code = (d.get("code") or "").strip().upper()
    room = rooms.get(code)
    if room is None:
        socketio.emit("join_failed", {"reason": "no_room",
                                      "msg": f"ไม่เจอห้อง {code}"}, to=request.sid)
        return

    token = d.get("token") or None
    known = token and token in room.by_token
    # จอ admin ที่สับมาเล่นเต็มจอ — ส่งรหัส admin มาด้วย
    # ตั้งแต่ 2026-08-24 admin เล่นห้องเดียวกับเด็ก แย่งอุกกาบาตชุดเดียวกันจริงๆ
    # จึงต้องเข้าห้องได้แม้รอบเพิ่งเริ่ม (มี countdown 3 วิ ทันพอดี ไม่เสียเวลาเล่น)
    as_admin = d.get("pw") == C.ADMIN_PASSWORD

    # เข้าระหว่างรอบไม่ได้ ยกเว้นคนเดิมที่หลุดแล้วกลับมา (เวลาไม่หยุดเดินให้)
    if room.state in ("countdown", "playing", "qte") and not known and not as_admin:
        socketio.emit("join_failed", {
            "reason": "in_progress", "msg": "รอบนี้เริ่มไปแล้ว รอรอบหน้านะ",
            "timeLeftMs": round(room.time_left_ms())}, to=request.sid)
        return

    p, tok, is_new = room.join(token, request.sid)
    if p is None:
        socketio.emit("join_failed", {"reason": "full",
                                      "msg": f"ห้องนี้เต็มแล้ว ({C.MAX_SLOTS} คน)"}, to=request.sid)
        return

    if as_admin:
        # ชื่อตายตัว ไม่ต้องพิมพ์ และเด็กตั้งชื่อชนไม่ได้ (กันไว้ที่ clean_player_name)
        with room.lock:
            p.is_admin = True
            p.name = C.ADMIN_NAME

    join_room(room.code)
    socketio.emit("joined", {
        "token": tok, "slot": p.slot, "name": p.display, "color": p.color,
        "en": p.en, "hex": p.hex, "rgb": p.rgb, "rejoin": not is_new,
        "code": room.code, "isAdmin": p.is_admin,
        "needName": not p.named,        # ยังไม่พิมพ์ชื่อ = ต้องถามก่อนถึงจะเริ่มได้
        "nameMin": C.NAME_MIN, "nameMax": C.NAME_MAX,
        "serverMs": now_ms(),
    }, to=request.sid)

    # กลับเข้ามากลางรอบ → ส่งตารางเดิมให้เล่นต่อทันที ไม่ต้อง resync อะไร
    if room.state in ("countdown", "playing", "qte"):
        socketio.emit("round_start", _round_payload(room), to=request.sid)

    _emit_room(room)


@socketio.on("set_name")
@safe
def on_set_name(data=None):
    """
    ทุกคนพิมพ์ชื่อของตัวเอง — ชื่อนี้คือชื่อที่จะขึ้น leaderboard

    เดิมคนแรกตั้งชื่อ *ทีม* แล้วคนอื่นไม่ต้องกรอกอะไร
    เปลี่ยนเมื่อ 2026-08-24: บอร์ดเป็นรายบุคคล ถ้าไม่มีชื่อของตัวเอง
    บอร์ดจะเต็มไปด้วย "แดง" ซ้ำกันหลายสิบแถวจากคนละกลุ่ม แยกไม่ออกเลย
    """
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    me = room.player_of_sid(request.sid)
    if me is None:
        return
    if me.is_admin:                       # admin ใช้ชื่อตายตัว ห้ามเปลี่ยน
        socketio.emit("name_set", {"name": me.name, "slot": me.slot}, to=request.sid)
        return

    name, err = clean_player_name((data or {}).get("name"),
                                  C.NAME_MIN, C.NAME_MAX, reserved=(C.ADMIN_NAME,))
    if err:
        socketio.emit("name_rejected", {"msg": err}, to=request.sid)
        return
    if room.name_taken(name, exclude=me):
        socketio.emit("name_rejected",
                      {"msg": "ชื่อนี้มีคนใช้ในห้องแล้ว ใช้ชื่ออื่นนะ"}, to=request.sid)
        return

    room.set_name(request.sid, name)
    socketio.emit("name_set", {"name": name, "slot": me.slot}, to=request.sid)
    _emit_room(room)


@socketio.on("start_round")
@safe
def on_start_round(data=None):
    """ผู้เล่นกดเริ่มเอง — ปิดไว้โดย default (admin เป็นคนกด)"""
    if not C.ALLOW_PLAYER_START:
        socketio.emit("error_msg", {"msg": "รอ admin กดเริ่มนะ"}, to=request.sid)
        return
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    _begin(room, request.sid)


@socketio.on("admin_login")
@safe
def on_admin_login(data=None):
    """หน้าเดียวจบ — กรอกรหัสห้อง = เล่น, กรอกรหัส admin = เข้าหน้า admin"""
    ok = (data or {}).get("pw") == C.ADMIN_PASSWORD
    socketio.emit("admin_login", {"ok": ok}, to=request.sid)


@socketio.on("admin_start")
@safe
def on_admin_start(data=None):
    """
    admin กดเริ่ม — คนเข้าห้องได้เรื่อยๆ จนถึงจังหวะนี้

    ต้องมีรหัส ไม่งั้นเด็กเปิด /admin เองแล้วกดเริ่มตัดหน้าคนที่ยังเข้าไม่ทัน
    """
    d = data or {}
    if d.get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    room = rooms.get(d.get("code")) or rooms.primary()
    if room is None:
        socketio.emit("error_msg", {"msg": "ไม่เจอห้องนี้"}, to=request.sid)
        return
    if not _begin(room, request.sid):
        return

    # กดเริ่มแล้ว admin สับไปเล่นเต็มจอ — **ห้องเดียวกับเด็ก**
    # เปลี่ยนเมื่อ 2026-08-24 ตามที่เจ้าของงานสั่ง: ทุกคนอยู่สนามเดียวกัน
    # แย่งอุกกาบาตชุดเดียวกันจริงๆ คะแนนแยกเป็นรายคนอยู่แล้วเลยไม่ปนกัน
    socketio.emit("admin_play", {"code": room.code, "roomCode": room.code},
                  to=request.sid)


@socketio.on("admin_room_start")
@safe
def on_admin_room_start(data=None):
    """
    หน้า /play?admin=1 เรียกเองหลัง join ห้องสำเร็จ

    ปกติ admin_start เริ่มรอบไปแล้ว ตัวนี้เลยเป็นแค่ตาข่ายกันพลาด:
    ถ้าจอ admin โหลดช้าจนรอบยังไม่เริ่ม กดตรงนี้ก็เริ่มได้เหมือนกัน
    """
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    if room.state in ("countdown", "playing", "qte"):
        return                              # เริ่มไปแล้ว ไม่ต้องทำอะไร
    _begin(room, request.sid)


@socketio.on("admin_solo")
@safe
def on_admin_solo(data=None):
    """admin อยากลงไปเล่นเอง — ห้องเดียวกับเด็ก คะแนนแยกเป็นรายคนอยู่แล้ว"""
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    r = rooms.primary()
    socketio.emit("admin_solo", {"code": r.code if r else None}, to=request.sid)


def _begin(room, who_sid):
    """คืน True ถ้ารอบเริ่มจริง — จอ admin ใช้ตัดสินว่าจะสลับไปเต็มจอดีหรือยัง"""
    if room.state in ("countdown", "playing", "qte"):
        return False
    if not room.active():
        socketio.emit("error_msg", {"msg": "ยังไม่มีผู้เล่นในห้อง"}, to=who_sid)
        return False
    # บอร์ดเป็นรายบุคคล — ใครยังไม่พิมพ์ชื่อก็ไม่รู้จะบันทึกคะแนนในชื่ออะไร
    missing = room.unnamed()
    if missing:
        socketio.emit("error_msg", {
            "msg": "ยังมีคนไม่ได้ตั้งชื่อ: " + ", ".join(p.color for p in missing),
        }, to=who_sid)
        return False

    # ── ประตูข้อมูล ────────────────────────────────────────
    # DB ไม่พร้อม = ไม่มีอุกกาบาตให้จัดตาราง ต้องบอกออกไป ไม่ใช่เริ่มรอบเงียบๆ
    # แล้วปล่อยให้เด็กยืนมองฟ้าโล่ง 75 วินาที
    # (ตาม CLAUDE.md: คิวว่าง = รอ/retry ไม่ใช่แต่งดวงปลอมขึ้นมาแทน)
    db = gmn_db.diagnostics()
    if not db["ok"] or db["meteors"] <= 0:
        gmn_db.report_to_log()
        socketio.emit("error_msg", {
            "msg": "ไม่มีข้อมูลอุกกาบาต — ฐานข้อมูลไม่พร้อม เริ่มรอบไม่ได้",
            "where": "db", "detail": db.get("error"),
        }, to=who_sid)
        return False

    schedule = room.start_round()
    if not schedule:
        # DB พร้อมแต่จัดตารางไม่ได้สักดวง (เช่น ไม่มีเรดิแอนต์ดวงไหนอยู่บนฟ้ากรุงเทพ
        # ในซุ้มยิงตอนนี้เลย) — ก็ยังห้ามเริ่ม ต้องบอกแล้วให้กดใหม่
        room.to_lobby()
        print("[GMN] ตารางอุกกาบาตว่าง ทั้งที่ DB มี "
              f"{db['meteors']:,} แถว — ไม่เริ่มรอบ", flush=True)
        socketio.emit("error_msg", {
            "msg": "จัดตารางอุกกาบาตไม่ได้สักดวง — ลองกดเริ่มใหม่อีกครั้ง",
            "where": "schedule",
        }, to=who_sid)
        _emit_room(room)
        return False

    socketio.emit("round_start", _round_payload(room), to=room.code)
    _emit_room(room)
    return True


def _round_payload(room):
    with room.lock:
        return {
            "roundId": room.round_id,
            "startMs": room.start_ms,          # เวลา server ที่รอบเริ่มจริง
            "endMs": room.end_ms,
            "serverMs": now_ms(),
            "roundSec": C.ROUND_SEC,
            "stormStartSec": C.STORM_START_SEC,
            "stormPassRate": C.STORM_PASS_RATE,
            "stormMinScale": C.STORM_MIN_SCALE,
            "schedule": room.schedule,          # ตารางทั้งรอบ ส่งครั้งเดียว
            "destroyed": list(room.destroyed.keys()),
            "players": [p.public() for p in room.active()],
            "shipHp": room.ship_hp,
            "shipMaxHp": room.ship_max_hp,
        }


def _qte_payload(room):
    """ลูกไฟดวงสุดท้าย + หน้าต่างเวลา — ทุกเครื่องเห็นดวงเดียวกันเวลาเดียวกัน"""
    with room.lock:
        return {
            "roundId": room.round_id,
            "startMs": room.qte_start_ms,
            "endMs": room.qte_end_ms,
            "serverMs": now_ms(),
            "qteSec": C.QTE_SEC,
            "need": room.qte_need,
            "hits": room.qte_hits,
            "meteor": room.qte_wire,
            "shipHp": room.ship_hp,
            "shipMaxHp": room.ship_max_hp,
        }


@socketio.on("player_aim")
@safe
def on_player_aim(data=None):
    """ส่งมุมเล็ง (yaw/pitch) ไปให้ผู้เล่นคนอื่นในห้องเห็นป้อมหมุนตามแบบ realtime"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state in ("playing", "qte", "countdown"):
        p = room.player_of_sid(request.sid)
        if p:
            d = data or {}
            socketio.emit("player_aim", {
                "slot": p.slot,
                "yaw": d.get("yaw", 0),
                "pitch": d.get("pitch", 0),
            }, to=room.code, include_self=False)


@socketio.on("player_fire")
@safe
def on_player_fire(data=None):
    """ส่ง action การยิง (Muzzle Flash + Laser Tracer) ไปยังเพื่อนร่วมทีมทุกคน"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state in ("playing", "qte"):
        p = room.player_of_sid(request.sid)
        if p:
            p.shots += 1
            d = data or {}
            socketio.emit("player_fire", {
                "slot": p.slot,
                "hex": p.hex,
                "rgb": p.rgb,
                "yaw": d.get("yaw", 0),
                "pitch": d.get("pitch", 0),
                "from": d.get("from"),
                "to": d.get("to"),
                "targetId": d.get("targetId", 0),
            }, to=room.code, include_self=False)


@socketio.on("ship_nav")
@safe
def on_ship_nav(data=None):
    """ผู้ควบคุมยานส่งการเคลื่อนที่/เลี้ยว/เร่งเครื่อง (Sync ไปยังสมาชิกในห้อง)"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state in ("playing", "qte", "countdown"):
        socketio.emit("ship_nav", data or {}, to=room.code, include_self=False)


@socketio.on("nav_waypoint")
@safe
def on_nav_waypoint(data=None):
    """ยานบินผ่านวงแหวนนำร่องสู่ดวงจันทร์ (Lunar Nav Ring) -> ได้แต้มโบนัส + ซ่อมเกราะ"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state in ("playing", "qte"):
        with room.lock:
            bonus = 500
            room.team_score += bonus
            if room.ship_hp < room.ship_max_hp:
                room.ship_hp = min(room.ship_max_hp, room.ship_hp + 5)
            socketio.emit("nav_ring_passed", {
                "ringId": (data or {}).get("ringId", 0),
                "bonus": bonus,
                "score": room.team_score,
                "teamScore": room.team_score,
                "shipHp": room.ship_hp,
                "shipMaxHp": room.ship_max_hp,
            }, to=room.code)


@socketio.on("select_role")
@safe
def on_select_role(data=None):
    """เลือกหน้าที่: 'ground' (ภาคพื้น) หรือ 'spaceship' (ผู้ควบคุมยาน จำกัด 1 คนต่อทีม)"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state == "lobby":
        role = (data or {}).get("role", "ground")
        room.set_player_role(request.sid, role)
        _emit_room(room)


@socketio.on("pulse_shield")
@safe
def on_pulse_shield(data=None):
    """ผู้ควบคุมยานเปิดใช้งาน Energy Pulse ฟื้นฟูเกราะยาน +15 HP"""
    room = rooms.room_of_sid(request.sid)
    if room:
        res = room.pulse_shield(request.sid)
        if res:
            socketio.emit("shield_pulse", res, to=room.code)


@socketio.on("miss")
@safe
def on_miss(data=None):
    """อุกกาบาตหลุดรอดไปชนแนวบินของยาน Long March 5 — หัก HP ยานตามความเร็วจริง"""
    room = rooms.room_of_sid(request.sid)
    if room and room.state in ("playing", "qte"):
        try:
            mid = int((data or {}).get("meteorId", 0))
        except (TypeError, ValueError):
            return
        res = room.record_miss(mid)
        if res:
            socketio.emit("ship_damage", res, to=room.code)


@socketio.on("shot")
@safe
def on_shot(_data=None):
    room = rooms.room_of_sid(request.sid)
    if room:
        room.note_shot(request.sid)


@socketio.on("kill")
@safe
def on_kill(data=None):
    """
    client บอกว่ายิงโดนดวงไหน — server ตัดสินคนเดียวว่าใครถึงก่อน

    ยิงซ้ำ = เงียบๆ ไม่ได้แต้ม ไม่ error ไม่ต้องแจ้งใคร (spec §2)
    """
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    try:
        mid = int((data or {}).get("meteorId"))
    except (TypeError, ValueError):
        return

    res = room.claim_kill(request.sid, mid)
    if res is None:
        return
    # นัดที่ยังไม่ครบ → ทุกเครื่องหดก้อนพร้อมกัน / ครบแล้ว → แตก
    socketio.emit(res["kind"], res, to=room.code)


@socketio.on("qte_tap")
@safe
def on_qte_tap(_data=None):
    """รัวยิงลูกไฟดวงสุดท้าย — server นับคนเดียว ทุกเครื่องเห็นตัวเลขเดียวกัน"""
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    res = room.qte_tap(request.sid)
    if res is None:
        return
    socketio.emit("qte_progress", res, to=room.code)


@socketio.on("disconnect")
@safe
def on_disconnect(*_a):
    room = rooms.room_of_sid(request.sid)
    if room:
        room.unwatch(request.sid)
        room.leave(request.sid)
        _emit_room(room)


# ══════════════════════════════════════════════════════════
# ตัวจับเวลาจบรอบ (ไม่ใช่ game loop — เช็คแค่ว่าหมดเวลาหรือยัง)
# ══════════════════════════════════════════════════════════
def _round_watcher():
    my_pid = os.getpid()
    print(f"[watcher] เริ่มทำงาน pid={my_pid}", flush=True)
    while True:
        socketio.sleep(0.25)
        # ถูกแทนที่ด้วยตัวใหม่แล้ว → ถอยออกไป ไม่งั้นสองตัววนพร้อมกัน
        # แล้ว tick จะถูกส่งซ้ำ เวลาบน HUD ของเด็กจะกระตุก
        if _watcher["thread"] is not threading.current_thread():
            print(f"[watcher] pid={my_pid} ถูกแทนที่แล้ว — เลิกวน", flush=True)
            return
        # ครบหนึ่งรอบแล้วค่อยนับ — /health เอาไว้ดูว่ามันยังวนอยู่จริงไหม
        _watcher["loops"] += 1
        _watcher["last_ms"] = now_ms()
        try:
            all_rooms = rooms.all()
        except Exception as e:
            # เดิมบรรทัดนี้อยู่นอก try — โยน exception ทีเดียวเธรดตายทั้งตัว
            # แล้วเกมจะค้างที่ countdown ตลอดกาลโดยไม่มีร่องรอย
            import traceback
            _watcher["error"] = f"rooms.all(): {type(e).__name__}: {e}"
            traceback.print_exc()
            continue
        for room in all_rooms:
            try:
                ev = room.tick()
                if ev == "qte":
                    socketio.emit("qte_start", _qte_payload(room), to=room.code)
                    _emit_room(room)
                elif ev == "end":
                    _finish_round(room)
                elif room.state == "qte":
                    socketio.emit("tick", {
                        "timeLeftMs": 0, "qteLeftMs": round(room.qte_left_ms()),
                        "teamScore": room.team_score,
                        "teamCombo": room.team_combo,
                        "score": room.team_score,
                        "combo": room.team_combo,
                        "kills": room.kills,
                        "phase": "qte",
                        "qteHits": room.qte_hits, "qteNeed": room.qte_need,
                        "stormHits": room.storm_hits, "stormTotal": room.storm_total,
                        "shipHp": room.ship_hp, "shipMaxHp": room.ship_max_hp,
                    }, to=room.code)
                elif room.state == "playing":
                    socketio.emit("tick", {
                        "timeLeftMs": round(room.time_left_ms()),
                        "teamScore": room.team_score,
                        "teamCombo": room.team_combo,
                        "score": room.team_score,
                        "combo": room.team_combo,
                        "kills": room.kills,
                        "phase": room.phase(),
                        "stormHits": room.storm_hits, "stormTotal": room.storm_total,
                        "shipHp": room.ship_hp, "shipMaxHp": room.ship_max_hp,
                    }, to=room.code)
                elif room.state == "ended" and room.ended_for(C.RESET_AFTER_SEC):
                    # กลับ lobby เองหลังจบรอบ — บูธจะได้ต่อคิวรอบถัดไปได้เลย
                    room.to_lobby()
                    _emit_room(room)
            except Exception as e:      # ห้ามให้ห้องเดียวพังทั้ง watcher
                import traceback
                _watcher["error"] = f"{room.code}: {type(e).__name__}: {e}"
                traceback.print_exc()


def _finish_round(room):
    """
    จบรอบ — บันทึก **คะแนนรวมของทีม** (Team Leaderboard)
    """
    with room.lock:
        passed, mult, rate = room.storm_result()
        qte_passed, qte_bonus, qte_rate = room.qte_result()
        players = room.active()
        mission_rank = room.calc_rank()

        res = board.submit_round(
            [{"name": p.display, "raw": p.score, "kills": p.kills,
              "bestCombo": p.best_combo, "isAdmin": p.is_admin, "slot": p.slot, "role": p.role}
             for p in players],
            storm_mult=mult, bonus=qte_bonus,
            storm_passed=passed, qte_passed=qte_passed,
            team_score=room.team_score, team_kills=room.kills,
            team_best_combo=room.team_best_combo, code=room.code)

        room.last_board = res

        summary = {
            "teamName": res["teamName"],
            "teamScore": res["teamScore"],
            "teamRawScore": res["teamRawScore"],
            "teamKills": res["teamKills"],
            "teamBestCombo": res["teamBestCombo"],
            "teamRank": res["teamRank"],
            "results": res["players"],
            "stormMult": mult, "stormPassed": passed,
            "stormHits": room.storm_hits, "stormTotal": room.storm_total,
            "stormRate": round(rate, 3), "stormPassRate": C.STORM_PASS_RATE,
            "qteHits": room.qte_hits, "qteNeed": room.qte_need,
            "qtePassed": qte_passed, "qteBonus": qte_bonus,
            "qteRate": round(qte_rate, 3),
            "qteMeteor": (room.qte_wire or {}).get("gmn"),
            "kills": room.kills,
            "players": [p.public() for p in players],
            "playerCount": len(players),
            "totalRounds": board.total_rounds(),
            "gmnTotal": gmn_db.count(),
            "gmnCameras": C.GMN_CAMERAS_WORLDWIDE,
            "top": board.top(10),
            "shipHp": room.ship_hp,
            "shipMaxHp": room.ship_max_hp,
            "missionRank": mission_rank,
            "ce7Status": "ONLINE & SCANNING",
        }
    socketio.emit("round_end", summary, to=room.code)
    _emit_room(room)


def watcher_status():
    """สถานะตัวจับเวลา — /health อ่านจากตรงนี้

    stalled = เธรดยังอยู่แต่ไม่ได้วนมานานผิดปกติ (ค้างที่ lock อะไรสักอย่าง)
    ต่างจาก dead ตรงที่ dead คือไม่มีเธรดแล้ว ต้องแยกให้ออกเวลาหาสาเหตุ
    """
    t = _watcher["thread"]
    alive = bool(t is not None and t.is_alive())
    since = now_ms() - _watcher["last_ms"] if _watcher["loops"] else None
    return {
        "alive": alive,
        "same_process": _watcher["pid"] == os.getpid(),
        "watcher_pid": _watcher["pid"],
        "pid": os.getpid(),
        "loops": _watcher["loops"],
        "last_loop_ago_ms": None if since is None else round(since),
        "stalled": bool(alive and since is not None and since > 5000),
        "started_ms": round(_watcher["started_ms"]),
        "restarts": _watcher["restarts"],
        "error": _watcher["error"],
    }


def _ensure_bg():
    """
    ตัวจับเวลาต้องมีอยู่จริง *ในโปรเซสนี้* — ห้ามเชื่อ flag

    ไม่มีตัวนี้ = รอบไม่เคยเปลี่ยนจาก countdown เป็น playing
    = client ไม่เริ่มนับเวลา = ไม่มีอุกกาบาตขึ้นสักดวงทั้งรอบ โดยไม่มี error ให้เห็น
    """
    with _watcher_lock:
        t = _watcher["thread"]
        ok = (t is not None and t.is_alive() and _watcher["pid"] == os.getpid())
        if ok:
            return
        if t is not None:
            _watcher["restarts"] += 1
            print(f"[watcher] ตัวจับเวลาไม่อยู่ในโปรเซสนี้แล้ว "
                  f"(alive={t.is_alive()} watcher_pid={_watcher['pid']} pid={os.getpid()}) "
                  f"— สตาร์ทใหม่ ครั้งที่ {_watcher['restarts']}", flush=True)
        _watcher["pid"] = os.getpid()
        _watcher["loops"] = 0
        _watcher["last_ms"] = now_ms()
        _watcher["started_ms"] = now_ms()
        _watcher["thread"] = socketio.start_background_task(_round_watcher)


# ══════════════════════════════════════════════════════════
def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return {i for i in ips if not i.startswith("127.")}


def bootstrap():
    """
    ห้องหลัก + ตัวจับเวลาต้องมีตั้งแต่บูต

    เรียกตอน import ด้วย ไม่ใช่เฉพาะ __main__ — บน hoster มันรันด้วย
    gunicorn ซึ่ง import app:app เฉยๆ บล็อก __main__ ไม่เคยทำงาน
    (ต้อง worker เดียวเท่านั้น — ห้องเก็บใน RAM หลาย worker = คนละห้อง ดู Procfile)
    """
    _ensure_bg()
    # ตะโกนสถานะ DB ลง log ทันทีที่ import — gunicorn ไม่เคยรัน __main__
    # ถ้าไม่พิมพ์ตรงนี้ log บน hoster จะไม่มีร่องรอยเลยว่า DB หาย
    gmn_db.report_to_log()
    return rooms.primary()


FIRST_ROOM = bootstrap()


if __name__ == "__main__":
    first = FIRST_ROOM
    # พิมพ์ URL ที่ copy ไปวางได้เลย — ห้ามพิมพ์ <ip> เป็นคำแทนที่
    # (เคยพิมพ์แบบนั้นแล้วสับสน นึกว่าต้อง deploy ก่อนถึงจะเข้าได้)
    ips = sorted(local_ips())
    print("=" * 62, flush=True)
    print("  GMNshooter Phase C   ทำงานอยู่แล้ว ไม่ต้อง deploy อะไรทั้งนั้น", flush=True)
    print("", flush=True)
    print(f"  รหัสห้องตอนนี้   {first.code if first else '?'}", flush=True)
    print("", flush=True)
    print("  เปิดบนคอมเครื่องนี้:", flush=True)
    print(f"     จอ admin    http://localhost:{C.PORT}/admin", flush=True)
    print(f"     หน้าเล่นเกม  http://localhost:{C.PORT}/", flush=True)
    if ips:
        print("", flush=True)
        print("  เปิดบนมือถือ (ต้องต่อ WiFi วงเดียวกับคอม):", flush=True)
        for ip in ips:
            print(f"     http://{ip}:{C.PORT}/", flush=True)
    print("", flush=True)
    print(f"  meteors.db   {gmn_db.count():,} ดวง", flush=True)
    print(f"  leaderboard  {board.total_rounds()} รอบที่บันทึกไว้", flush=True)
    print("=" * 62, flush=True)
    socketio.run(app, host=C.HOST, port=C.PORT, debug=False, allow_unsafe_werkzeug=True)
