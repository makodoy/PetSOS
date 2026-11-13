"""POST /api/log — erros de JavaScript vão para os logs da Vercel. Só mensagem e página, sem dados pessoais."""

import json
from http.server import BaseHTTPRequestHandler

MAX_BODY = 2000


def clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = min(int(self.headers.get("Content-Length") or 0), MAX_BODY)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
            print(f"erro-cliente pagina={clean(data.get('page'), 80)} msg={clean(data.get('message'), 300)}")
        except (ValueError, AttributeError):
            pass
        self.send_response(204)
        self.end_headers()
