"""POST ou GET /api/notify — roda as tarefas de segundo plano. Chamada por webhooks do Supabase e pelo cron diário da Vercel.
Exige `Authorization: Bearer $CRON_SECRET`."""

import hmac
import json
import os
import sys
import urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _jobs import resend_mailer, run_all  # noqa: E402
from _supabase import request  # noqa: E402


def _db(path, method="GET", params=None, body=None, prefer=""):
    return request(path, method=method, params=params, body=body, prefer=prefer, service=True)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._run()

    def do_POST(self):
        self._run()

    def _run(self):
        secret = os.environ.get("CRON_SECRET", "")
        given = self.headers.get("Authorization", "")
        if not secret or not hmac.compare_digest(given, f"Bearer {secret}"):
            return self._send(401, {"error": "Não autorizado."})
        if not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
            return self._send(500, {"error": "SUPABASE_SERVICE_ROLE_KEY não configurada."})
        site = os.environ.get("SITE_URL", "").rstrip("/")
        try:
            result = run_all(_db, resend_mailer(), site, datetime.now(timezone.utc))
        except (urllib.error.URLError, TimeoutError) as err:
            print(f"notify falhou: {err}")
            return self._send(502, {"error": "Serviço indisponível; a próxima execução continua de onde parou."})
        self._send(200, result)

    def _send(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)
