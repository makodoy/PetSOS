"""Acesso ao Supabase só com a biblioteca padrão."""

import json
import os
import urllib.parse
import urllib.request

TIMEOUT = 8


def request(path: str, method: str = "GET", params: dict | None = None, body=None, token: str = "", service: bool = False,
            prefer: str = ""):
    """Sem token, vale como visitante; com token, as regras RLS valem como se fosse o usuário (o dono vê o próprio
    anúncio pendente). `service=True` usa a service role: só para as tarefas de api/notify, nunca para pedidos de usuário."""
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"] if service else os.environ["SUPABASE_ANON_KEY"]
    url = f"{base}{path}"
    if params:
        url += f"?{urllib.parse.urlencode(params)}"
    headers = {"apikey": key, "Authorization": f"Bearer {token or key}", "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def rest(table: str, params: dict, token: str = "") -> list:
    return request(f"/rest/v1/{table}", params=params, token=token)


def public_photo_url(path: str) -> str:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    return f"{base}/storage/v1/object/public/pet-photos/{urllib.parse.quote(path)}"
