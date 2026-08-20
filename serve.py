"""SpaceHT — dev server (Phase A)

    python serve.py            -> http://localhost:8000
    python serve.py 8080       -> port อื่น

ทำแค่ 2 อย่าง:
  1. chdir ไปโฟลเดอร์ที่ไฟล์นี้อยู่ (เรียกจากที่ไหนก็ได้)
  2. ยัด no-cache header — ไม่งั้นแก้ config.js แล้ว refresh ไม่ติด ซึ่งทรมานมากตอนจูน feel

ไม่มี build step ไม่มี npm. ES module ต้องผ่าน http:// เปิดไฟล์ตรงๆ ไม่ได้.
"""

import os
import sys
import json
import http.server
import socketserver
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))

# GMN — โหลดแบบ optional ไม่มี data/meteors.db ก็ยังเล่นได้ (เกมจะสุ่มเอาเอง)
sys.path.insert(0, ROOT)
try:
    from game import db as gmn_db
except Exception as _e:      # noqa
    gmn_db = None


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # ── API เล็กๆ สำหรับข้อมูล GMN จริง ────────────────────
    # ต้องผ่าน server เพราะข้อมูลอยู่ใน SQLite 48 MB — โยนให้ browser ทั้งก้อนไม่ไหว
    # และการแปลง RA/Dec → alt/az ต้องรู้เวลาจริง ทำฝั่ง server จบในที่เดียว
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/gmn/"):
            return self._gmn(parsed)
        return super().do_GET()

    def _gmn(self, parsed):
        if gmn_db is None or not gmn_db.available():
            return self._json({"available": False,
                               "hint": "ยังไม่มี data/meteors.db — รัน tools/bake_gmn.py ก่อน"}, 200)
        try:
            if parsed.path == "/gmn/stats":
                return self._json(gmn_db.stats())
            if parsed.path == "/gmn/spawn":
                q = parse_qs(parsed.query)
                n = max(1, min(64, int(q.get("n", ["12"])[0])))
                return self._json({"available": True, "events": gmn_db.pick(n)})
        except Exception as e:
            return self._json({"available": False, "error": f"{type(e).__name__}: {e}"}, 500)
        return self._json({"error": "unknown endpoint"}, 404)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # เงียบไว้ ไม่งั้น log ท่วมตอนโหลด module สิบไฟล์
        if "404" in (fmt % args):
            sys.stderr.write("  404  %s\n" % (fmt % args))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    # ต้อง threaded: เกมยิง /gmn/spawn ระหว่างเล่นเพื่อเติมคิวอุกกาบาต
    # ถ้า server รับได้ทีละ request เดียว การเติมคิวจะไปบล็อกการโหลดไฟล์อื่น
    # แล้วเกมค้างเป็นวินาที (เจอมาแล้วตอนเทสต์ — หน้าเว็บโหลดค้างสนิท)
    daemon_threads = True
    # *** อย่าเปิด SO_REUSEADDR บน Windows ***
    # บน Linux/Mac มันแปลว่า "reuse port ที่เพิ่งปิดไป" (ดี กัน Address already in use)
    # แต่บน Windows มันแปลว่า "ให้หลาย process bind port เดียวกันได้พร้อมกัน"
    # ผลคือเปิด serve.py ทิ้งไว้ 2-3 ตัวโดยไม่รู้ตัว แล้ว request วิ่งไปเข้าตัวไหนก็ไม่รู้
    # → หน้าขาวเปล่า ไม่มี error ให้เห็นเลย หา bug ไม่เจอแน่นอน
    # ปล่อยให้ bind ชนแล้วฟ้องออกมาตรงๆ ดีกว่าเยอะ
    allow_reuse_address = (os.name != "nt")


if __name__ == "__main__":
    os.chdir(ROOT)
    try:
        httpd = Server(("", PORT), NoCacheHandler)
    except OSError as e:
        print(f"\n  เปิด port {PORT} ไม่ได้: {e}\n")
        print(f"  แปลว่ามี serve.py (หรือโปรแกรมอื่น) ใช้ port {PORT} ค้างอยู่แล้ว")
        print("  ปิดตัวเก่าก่อน — เปิด PowerShell แล้วรัน:\n")
        print("    Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" |")
        print("      Where-Object { $_.CommandLine -like '*serve.py*' } |")
        print("      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n")
        print(f"  หรือใช้ port อื่นไปเลย:  python serve.py {PORT + 1}\n")
        raise SystemExit(1)

    with httpd:
        # flush=True — ถ้าไม่ใส่ แล้ว stdout ไม่ใช่ terminal (โดน pipe / รันเป็น background)
        # Python จะ buffer ไว้ ไม่พ่นอะไรออกมาเลย นึกว่า server ค้าง ทั้งที่รันอยู่ปกติ
        print(f"GMNshooter  ->  http://localhost:{PORT}", flush=True)
        print(f"serving  {ROOT}", flush=True)
        print("เปิดด้วย Chrome/Edge นะ อย่าใช้ Simple Browser ของ VS Code", flush=True)
        print("Ctrl+C to stop", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
