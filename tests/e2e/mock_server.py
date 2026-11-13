"""Serve o site com um back-end falso (API e PostgREST) para testar telas sem Supabase. Aplica a CSP do vercel.json.
Grava as escritas em /__writes para o teste conferir o que o navegador enviou."""

import json
import mimetypes
import os
import sys
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, "api"))
from _matching import rank  # noqa: E402

PORT = 8765
ORIGIN = f"http://localhost:{PORT}"
ME = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
NOW = datetime.now(timezone.utc).isoformat()
SOON = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
LATER = (datetime.now(timezone.utc) + timedelta(days=50)).isoformat()
WRITES = []

with open(os.path.join(ROOT, "vercel.json"), encoding="utf-8") as f:
    CSP = next(h["value"] for h in json.load(f)["headers"][0]["headers"] if h["key"] == "Content-Security-Policy")
CSP = CSP.replace("https://*.supabase.co", ORIGIN).replace("wss://*.supabase.co", f"ws://localhost:{PORT}")


def rep(i, kind, species, custody, name, sex, size, colors, breed, desc, hood, lat, lng, ago, user=None, review="approved", status="open", photo=True, expires=LATER):
    return dict(id=f"aaaaaaaa-aaaa-4aaa-8aaa-{i:012d}", user_id=user, has_owner=bool(user), kind=kind, species=species, custody=custody, pet_name=name, sex=sex,
                size=size, colors=colors, breed=breed, description=desc, photo_path=f"demo/{i}.svg" if photo else None, thumb_path=f"demo/{i}.svg" if photo else None,
                neighborhood=hood, lat=lat, lng=lng, event_date=(date.today() - timedelta(days=ago)).isoformat(), status=status, review_status=review,
                review_note=None, reviewed_at=None, created_at=NOW, expires_at=expires, owner={"display_name": "Ana Paula"})


REPORTS = [
    rep(1, "lost", "dog", None, "Thor", "male", "medium", ["caramelo", "branco"], "SRD", "Coleira vermelha, muito dócil. Fugiu durante os fogos.", "Vila Rio Branco", -23.587, -48.042, 4, user=ME, expires=SOON),
    rep(2, "found", "dog", "with_finder", None, "male", "medium", ["caramelo", "branco"], None, "Estava perto da praça, com coleira vermelha sem plaquinha.", "Centro", -23.591, -48.049, 2, user=OTHER),
    rep(3, "lost", "cat", None, "Mel", "female", "small", ["tricolor"], None, "Castrada, tem uma mancha preta no nariz.", "Jardim Itália", -23.600, -48.060, 7, photo=False),
    rep(4, "found", "cat", "sighted", None, "female", "small", ["tricolor"], None, "Vi no telhado da padaria duas noites seguidas.", "Vila Nova Itapetininga", -23.605, -48.055, 5),
    rep(5, "lost", "dog", None, "Pipoca", "female", "small", ["branco"], "Poodle", "Tosada recentemente, usa roupinha azul.", "Jardim Fogaça", -23.579, -48.063, 1),
    rep(6, "found", "dog", "with_finder", None, "unknown", "large", ["preto"], None, "Cachorro grande andando na SP-127, levei para casa.", "Chapadinha", -23.568, -48.028, 3),
    rep(7, "lost", "dog", None, "Bob", "male", "large", ["preto", "marrom"], "Rottweiler", "Muito amigável. Atende pelo nome.", "Vila Belo Horizonte", -23.595, -48.035, 6),
    rep(8, "found", "other", "sighted", None, "unknown", "small", ["cinza"], None, "Calopsita pousou na janela e voou de novo.", "Taboãozinho", -23.611, -48.044, 0, photo=False),
    rep(9, "lost", "dog", None, "Luna", "female", "medium", ["preto"], "SRD", "Reencontrada!", "Centro", -23.590, -48.052, 12, status="reunited"),
    rep(10, "found", "cat", "with_finder", None, "male", "small", ["cinza"], None, "Gato cinza aguardando moderação, muito manso.", "Centro", -23.592, -48.05, 1, user=OTHER, review="pending"),
]
CONV_ID = "cccccccc-cccc-4ccc-8ccc-000000000001"
CONV = {
    "id": CONV_ID, "report_id": REPORTS[1]["id"], "asker_id": ME, "owner_id": OTHER, "asker_context": "inquiry", "last_message_at": NOW,
    "report": REPORTS[1], "asker": {"display_name": "Rodrigo"}, "owner": {"display_name": "Ana Paula"},
    "handovers": {"id": "dddddddd-dddd-4ddd-8ddd-000000000001", "status": "approved"},
}
MSGS = [
    {"id": 1, "sender_id": ME, "body": "Oi! Acho que é o meu cachorro. Ele tem uma cicatriz pequena na orelha esquerda e tem medo de fogos.", "created_at": NOW},
    {"id": 2, "sender_id": OTHER, "body": "Oi! Ele tem mesmo uma marca na orelha. Consegue mandar mais algum detalhe?", "created_at": NOW},
    {"id": 3, "sender_id": ME, "body": "A coleira vermelha foi comprada na feira, tem uma costura azul do lado de dentro.", "created_at": NOW},
]
HANDOVER = {"id": CONV["handovers"]["id"], "conversation_id": CONV_ID, "report_id": REPORTS[1]["id"], "finder_id": OTHER, "claimant_id": ME, "status": "approved",
            "created_at": NOW, "updated_at": NOW, "reviewed_at": None, "finder_confirmed_at": NOW, "claimant_confirmed_at": None, "admin_note": None, "transcript": []}
NOTICES = [
    {"id": 1, "kind": "match", "report_id": REPORTS[0]["id"], "other_report_id": REPORTS[1]["id"], "conversation_id": None, "body": "Pode ser o mesmo animal de Thor (Vila Rio Branco): animal encontrado (Centro)"},
    {"id": 2, "kind": "message", "report_id": REPORTS[1]["id"], "other_report_id": None, "conversation_id": CONV_ID, "body": "Nova mensagem"},
]
FLAG = {"id": "eeeeeeee-eeee-4eee-8eee-000000000001", "reason": "Pediu dinheiro para devolver o animal.", "created_at": NOW, "report_id": None, "conversation_id": CONV_ID,
        "reporter": {"display_name": "Rodrigo"}, "report": None, "conversation": CONV}


def eq(q, key):
    value = q.get(key, "")
    return value[3:] if value.startswith("eq.") else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, body, ctype="application/json", extra=None, code=200):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "*")
        self.send_header("Access-Control-Expose-Headers", "*")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_OPTIONS(self):
        self.out(b"")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        p = u.path
        if p == "/__writes":
            return self.out(WRITES)
        if p == "/__add_message":
            MSGS.append({"id": 4, "sender_id": OTHER, "body": "Mensagem enviada enquanto você estava sem conexão.", "created_at": NOW})
            return self.out({})
        if p == "/api/config":
            return self.out({"supabaseUrl": ORIGIN, "supabaseAnonKey": "mock"})
        if p == "/api/matches":
            r = next((x for x in REPORTS if x["id"] == q.get("id")), None)
            return self.out({"report_id": q.get("id"), "matches": rank(r, REPORTS) if r else []})
        if p.startswith("/storage/v1/object/public/"):
            n = p.rsplit("/", 1)[-1].split(".")[0]
            svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#8a{n.zfill(1)[-1]}f70"/><text x="200" y="160" text-anchor="middle" font-size="40" fill="#fff">foto {n}</text></svg>'
            return self.out(svg.encode(), "image/svg+xml")
        if p.startswith("/rest/v1/"):
            return self.rest(p.split("/")[-1], q)
        path = "/index.html" if p == "/" else p
        file = ROOT + path
        if not os.path.exists(file):
            file = ROOT + path + ".html"
        if not os.path.isfile(file):
            return self.out(b"", "text/plain", code=404)
        with open(file, "rb") as f:
            self.out(f.read(), mimetypes.guess_type(file)[0] or "text/plain")

    def do_POST(self):
        self.write()

    def do_PATCH(self):
        self.write()

    def do_DELETE(self):
        self.write()

    def write(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        body = json.loads(raw) if raw and "json" in ctype else None
        WRITES.append({"method": self.command, "path": self.path, "body": body, "bytes": len(raw), "type": ctype})
        if self.path.startswith("/rest/v1/rpc/admin_metrics"):
            return self.out({"open_reports": 8, "reunions_30d": 3, "median_days": 4.5})
        if self.path.startswith("/rest/v1/rpc/start_conversation"):
            return self.out(json.dumps(CONV_ID).encode())
        if self.path.startswith("/rest/v1/reports"):
            return self.out({"id": REPORTS[0]["id"]})
        if self.path.startswith("/storage/"):
            return self.out({"Key": "ok"})
        self.out([])

    def rest(self, table, q):
        rows = []
        if table == "profiles":
            rows = [{"id": ME, "display_name": "Rodrigo", "role": "admin", "email_alerts": True}]
        elif table == "reports":
            rows = REPORTS
            if q.get("id"):
                ids = q["id"]
                rows = [r for r in rows if r["id"] in ids]
            elif q.get("user_id"):
                rows = [r for r in rows if r["user_id"] == q["user_id"][3:]]
            elif "or" in q:
                rows = [r for r in rows if r["review_status"] == "pending"]
            else:
                rows = [r for r in rows if r["review_status"] == "approved"]
                if eq(q, "status"):
                    rows = [r for r in rows if r["status"] == eq(q, "status")]
                if eq(q, "kind"):
                    rows = [r for r in rows if r["kind"] == eq(q, "kind")]
                if eq(q, "species"):
                    rows = [r for r in rows if r["species"] == eq(q, "species")]
        elif table == "conversations":
            rows = [CONV]
            if q.get("asker_id") and q.get("report_id"):
                rows = []
            if q.get("report_id", "").startswith("in."):
                rows = [c for c in rows if c["report_id"] in q["report_id"]]
        elif table == "messages":
            rows = MSGS
        elif table == "handovers":
            rows = [HANDOVER]
        elif table == "notifications":
            rows = NOTICES
            if "not.in" in q.get("kind", ""):
                rows = [n for n in rows if n["kind"] != "message"]
            elif eq(q, "kind"):
                rows = [n for n in rows if n["kind"] == eq(q, "kind")]
            if q.get("report_id", "").startswith("in."):
                rows = [n for n in rows if n["report_id"] in q["report_id"]]
        elif table == "flags":
            rows = [FLAG]
        elif table == "matches":
            rows = [{"report_id": REPORTS[0]["id"], "other_report_id": REPORTS[1]["id"], "other": {"status": "open"}}]
        elif table == "area_alerts":
            rows = [{"id": "f1", "neighborhood": "Centro"}]
        total = len(rows)
        if "vnd.pgrst.object" in self.headers.get("Accept", ""):
            return self.out(rows[0] if rows else {})
        self.out(rows, extra={"Content-Range": f"0-{max(total - 1, 0)}/{total}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
