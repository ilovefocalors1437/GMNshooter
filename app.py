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

from flask import Flask, render_template, send_from_directory, request, jsonify, Response
from flask_socketio import SocketIO, join_room, leave_room

from game import config as C
from game import db as gmn_db
from game import board
from game.clock import now_ms
from game.rooms import Rooms
from game.words import clean_team_name

ROOT = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, template_folder="templates", static_folder=None)
app.config["SECRET_KEY"] = os.urandom(24)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*",
                    ping_timeout=25, ping_interval=10)

rooms = Rooms()
_bg_started = False


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
    """endpoint แรกที่ต้องมีตอน deploy (§9 C1.1) — hoster ใช้เช็คว่าแอปยังไม่ตาย"""
    return jsonify({
        "ok": True,
        "meteors": gmn_db.count() if gmn_db.available() else 0,
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
    """2 บอร์ดแยกกันเด็ดขาด — รอบที่ admin เล่นห้ามปนกับทีมเด็ก"""
    return jsonify({
        "teams": board.top(10, is_admin=False),
        "admin": board.top(10, is_admin=True),
        "total": board.total_rounds(),
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
        "adminCode": rooms.admin_room().code,
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
        "code": room.code, "team": room.team, "serverMs": now_ms(),
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

    # เข้าระหว่างรอบไม่ได้ ยกเว้นคนเดิมที่หลุดแล้วกลับมา (เวลาไม่หยุดเดินให้)
    if room.state in ("countdown", "playing", "qte") and not known:
        socketio.emit("join_failed", {
            "reason": "in_progress", "msg": "รอบนี้เริ่มไปแล้ว รอรอบหน้านะ",
            "timeLeftMs": round(room.time_left_ms())}, to=request.sid)
        return

    p, tok, is_new = room.join(token, request.sid)
    if p is None:
        socketio.emit("join_failed", {"reason": "full",
                                      "msg": f"ห้องนี้เต็มแล้ว ({C.MAX_SLOTS} คน)"}, to=request.sid)
        return

    join_room(room.code)
    socketio.emit("joined", {
        "token": tok, "slot": p.slot, "name": p.name, "en": p.en, "hex": p.hex,
        "rgb": p.rgb, "rejoin": not is_new, "code": room.code,
        "team": room.team, "needTeamName": room.team is None,
        "serverMs": now_ms(),
    }, to=request.sid)

    # กลับเข้ามากลางรอบ → ส่งตารางเดิมให้เล่นต่อทันที ไม่ต้อง resync อะไร
    if room.state in ("countdown", "playing", "qte"):
        socketio.emit("round_start", _round_payload(room), to=request.sid)

    _emit_room(room)


@socketio.on("set_team")
@safe
def on_set_team(data=None):
    """คนแรกที่เข้าห้องเป็นคนตั้งชื่อทีม คนที่ 2-3 ไม่ต้องกรอกอะไร (spec §3)"""
    room = rooms.room_of_sid(request.sid)
    if room is None:
        return
    if room.team is not None:
        socketio.emit("team_set", {"team": room.team}, to=request.sid)
        return

    name, err = clean_team_name((data or {}).get("name"),
                                C.TEAM_NAME_MIN, C.TEAM_NAME_MAX)
    if err:
        socketio.emit("team_rejected", {"msg": err}, to=request.sid)
        return

    with room.lock:
        room.team = _unique_team_name(name)
    socketio.emit("team_set", {"team": room.team}, to=request.sid)
    _emit_room(room)


def _unique_team_name(name):
    """ชื่อซ้ำ → ต่อเลข HARMONY, HARMONY2 (spec §3)"""
    existing = {r.team for r in rooms.all() if r.team}
    if name not in existing:
        return name
    i = 2
    while f"{name}{i}" in existing:
        i += 1
    return f"{name}{i}"


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

    # กดเริ่มแล้ว admin สับไปเล่นเต็มจอด้วย — แต่อยู่ห้องของตัวเอง
    # เหตุผลที่ต้องแยกห้อง: ถ้า admin ลงเล่นห้องเดียวกับเด็ก
    # มันจะแย่งอุกกาบาตจากเด็ก และคะแนนจะปนกับคะแนนทีม
    ar = rooms.admin_room()
    if ar is not None and ar.state not in ("countdown", "playing", "qte"):
        with ar.lock:
            ar.team = C.ADMIN_TEAM_NAME
    socketio.emit("admin_play", {"code": ar.code if ar else None,
                                 "roomCode": room.code}, to=request.sid)


@socketio.on("admin_room_start")
@safe
def on_admin_room_start(data=None):
    """
    หน้า /play?admin=1 เรียกเองหลัง join ห้อง admin สำเร็จ

    ต้องรอให้ join ก่อน — _begin ต้องการห้องที่มีผู้เล่นจริงอย่างน้อยหนึ่งคน
    """
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    room = rooms.room_of_sid(request.sid)
    if room is None or not room.is_admin_room:
        return
    if room.team is None:
        with room.lock:
            room.team = C.ADMIN_TEAM_NAME
    _begin(room, request.sid)


@socketio.on("admin_solo")
@safe
def on_admin_solo(data=None):
    """admin อยากลงไปเล่นเอง — ห้องแยก คะแนนลงบอร์ด ADMIN ไม่ปนกับเด็ก"""
    if (data or {}).get("pw") != C.ADMIN_PASSWORD:
        socketio.emit("error_msg", {"msg": "รหัส admin ไม่ถูก"}, to=request.sid)
        return
    r = rooms.admin_room()
    socketio.emit("admin_solo", {"code": r.code if r else None}, to=request.sid)


def _begin(room, who_sid):
    """คืน True ถ้ารอบเริ่มจริง — จอ admin ใช้ตัดสินว่าจะสลับไปเต็มจอดีหรือยัง"""
    if room.state in ("countdown", "playing", "qte"):
        return False
    if room.team is None:
        socketio.emit("error_msg", {"msg": "ยังไม่มีใครตั้งชื่อทีม"}, to=who_sid)
        return False
    if not room.active():
        socketio.emit("error_msg", {"msg": "ยังไม่มีผู้เล่นในห้อง"}, to=who_sid)
        return False
    room.start_round()
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
            "team": room.team,
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
        }


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
    while True:
        socketio.sleep(0.25)
        for room in rooms.all():
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
                        "score": room.score, "kills": room.kills, "combo": room.combo,
                        "phase": "qte",
                        "qteHits": room.qte_hits, "qteNeed": room.qte_need,
                        "stormHits": room.storm_hits, "stormTotal": room.storm_total,
                    }, to=room.code)
                elif room.state == "playing":
                    socketio.emit("tick", {
                        "timeLeftMs": round(room.time_left_ms()),
                        "score": room.score, "kills": room.kills, "combo": room.combo,
                        # client ใช้ phase ตัดสินว่าจะซ่อนการ์ด/โชว์ตัวนับพายุเมื่อไร
                        "phase": room.phase(),
                        "stormHits": room.storm_hits, "stormTotal": room.storm_total,
                    }, to=room.code)
                elif room.state == "ended" and room.ended_for(C.RESET_AFTER_SEC):
                    # กลับ lobby เองหลังจบรอบ — บูธจะได้ต่อคิวรอบถัดไปได้เลย
                    room.to_lobby()
                    _emit_room(room)
            except Exception as e:      # ห้ามให้ห้องเดียวพังทั้ง watcher
                print("round watcher:", e, flush=True)


def _finish_round(room):
    with room.lock:
        passed, mult, rate = room.storm_result()
        qte_passed, qte_bonus, qte_rate = room.qte_result()
        is_admin = bool(getattr(room, "is_admin_room", False))
        rid, final, rank = board.submit(
            room.team or "NO NAME", room.score, len(room.active()), room.kills,
            room.storm_hits, room.storm_total, passed, mult, is_admin,
            bonus=qte_bonus)
        room.last_board = {"id": rid, "final": final, "rank": rank}
        summary = {
            "team": room.team, "rawScore": room.score, "score": final,
            "stormMult": mult, "stormPassed": passed,
            "stormHits": room.storm_hits, "stormTotal": room.storm_total,
            "stormRate": round(rate, 3), "stormPassRate": C.STORM_PASS_RATE,
            "qteHits": room.qte_hits, "qteNeed": room.qte_need,
            "qtePassed": qte_passed, "qteBonus": qte_bonus,
            "qteRate": round(qte_rate, 3),
            "qteMeteor": (room.qte_wire or {}).get("gmn"),
            "kills": room.kills, "bestCombo": room.best_combo,
            "players": [p.public() for p in room.active()],
            "playerCount": len(room.active()),
            "perHead": round(final / max(1, len(room.active()))),
            "rank": rank, "totalRounds": board.total_rounds(),
            "gmnTotal": gmn_db.count(),
            "gmnCameras": C.GMN_CAMERAS_WORLDWIDE,
            "isAdmin": is_admin,
            "top": board.top(10, is_admin),
        }
    socketio.emit("round_end", summary, to=room.code)
    _emit_room(room)


def _ensure_bg():
    global _bg_started
    if not _bg_started:
        _bg_started = True
        socketio.start_background_task(_round_watcher)


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
