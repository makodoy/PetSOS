"""GET /api/matches?id=<uuid> — anúncios do tipo oposto que podem ser o mesmo animal."""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _matching import FIELDS, candidate_params, image_matcher_from_env, rank  # noqa: E402
from _supabase import rest  # noqa: E402

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def find_matches(report_id: str, token: str = "") -> dict:
    rows = rest("reports", {"select": FIELDS, "id": f"eq.{report_id}", "limit": "1"}, token)
    if not rows:
        return {"status": 404, "body": {"error": "Anúncio não encontrado."}}
    report = rows[0]
    if report["status"] != "open":
        return {"status": 200, "body": {"report_id": report_id, "matches": []}}

    now = datetime.now(timezone.utc).isoformat()
    candidates = rest("reports", candidate_params(report, now), token)
    matches = rank(report, candidates, image=image_matcher_from_env())
    return {"status": 200, "body": {"report_id": report_id, "matches": matches}}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        report_id = (query.get("id") or [""])[0]
        if not UUID_RE.match(report_id):
            return self._send(400, {"error": "Parâmetro id inválido."})
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        try:
            result = find_matches(report_id, token)
        except KeyError:
            return self._send(500, {"error": "SUPABASE_URL e SUPABASE_ANON_KEY não configuradas."})
        except urllib.error.HTTPError as err:
            if err.code == 401:
                return self._send(401, {"error": "Sessão expirada. Entre de novo."})
            return self._send(502, {"error": "Banco de dados indisponível. Tente de novo em instantes."})
        except (urllib.error.URLError, TimeoutError):
            return self._send(502, {"error": "Banco de dados indisponível. Tente de novo em instantes."})
        self._send(result["status"], result["body"], cache=result["status"] == 200 and not token)

    def _send(self, status: int, body: dict, cache: bool = False):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, s-maxage=30" if cache else "no-store")
        self.end_headers()
        self.wfile.write(payload)
