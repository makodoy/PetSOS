"""GET /a/<uuid> — página curta com prévia de link (foto e título) para grupos e redes; leva ao anúncio."""

import html
import os
import re
import sys
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _supabase import public_photo_url, rest  # noqa: E402

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
FIELDS = "id,kind,species,custody,pet_name,neighborhood,description,photo_path,status"
SPECIES = {"dog": "Cão", "cat": "Gato", "other": "Animal"}


def share_title(r: dict) -> str:
    if r["kind"] == "lost":
        word = "Perdido"
    else:
        word = "Avistado" if r.get("custody") == "sighted" else "Encontrado"
    name = r.get("pet_name") or SPECIES.get(r["species"], "Animal")
    return f"{word}: {name}, {r['neighborhood']}"


def share_page(r: dict) -> str:
    target = f"/anuncio?id={r['id']}"
    title = html.escape(share_title(r), quote=True)
    desc = html.escape((r.get("description") or "Ajude a reunir este animal com a família. Anúncio em Itapetininga e região.")[:160], quote=True)
    image = ""
    if r.get("photo_path"):
        url = html.escape(public_photo_url(r["photo_path"]), quote=True)
        image = f'<meta property="og:image" content="{url}"><meta name="twitter:card" content="summary_large_image">'
    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} | PetSOS</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="article"><meta property="og:site_name" content="PetSOS"><meta property="og:locale" content="pt_BR">
<meta property="og:title" content="{title}"><meta property="og:description" content="{desc}">{image}
<meta http-equiv="refresh" content="0;url={target}">
</head><body><p><a href="{target}">Abrir o anúncio no PetSOS</a></p></body></html>"""


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        report_id = (query.get("id") or [""])[0]
        rows = []
        if UUID_RE.match(report_id):
            try:
                rows = rest("reports", {"select": FIELDS, "id": f"eq.{report_id}", "limit": "1"})
            except (KeyError, urllib.error.URLError, TimeoutError):
                # Sem o banco, o link continua funcionando; só a prévia fica sem dados.
                return self._redirect(f"/anuncio?id={report_id}")
        if not rows:
            return self._redirect("/")
        payload = share_page(rows[0]).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "public, s-maxage=300")
        self.end_headers()
        self.wfile.write(payload)

    def _redirect(self, target):
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
