"""GET /api/config — chaves públicas do Supabase lidas das variáveis de ambiente da Vercel.

A anon key é pública por design (o acesso é limitado pelas políticas RLS), mas
servir por aqui evita commitar chaves no repositório e trocar de projeto sem
mexer no código.
"""

import json
import os
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_ANON_KEY")
        if not url or not key:
            status, body, cache = 500, {"error": "SUPABASE_URL e SUPABASE_ANON_KEY não configuradas."}, "no-store"
        else:
            status, body, cache = 200, {"supabaseUrl": url, "supabaseAnonKey": key}, "public, s-maxage=3600"
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(payload)
