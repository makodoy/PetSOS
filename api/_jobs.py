"""Tarefas em segundo plano de /api/notify: parecidos, alertas de bairro, expiração, e-mails, fotos órfãs e retenção.

Cada tarefa recebe `db`, com request(path, method, params, body, prefer), para ser testada sem rede.
"""

from __future__ import annotations

import json
import os
import unicodedata
import urllib.request
from datetime import datetime, timedelta, timezone

from _matching import FIELDS, candidate_params, rank

NOTIFY_MIN_SCORE = 0.60  # só avisa por e-mail o que é "Parecido" ou mais; o resto fica na página do anúncio
BATCH = 50
EXPIRY_NOTICE_DAYS = 7
RETENTION_DAYS = 365
STALE_EMAIL_DAYS = 7

KIND_SUBJECT = {
    "message": "Nova mensagem no PetSOS",
    "match": "Encontramos um animal parecido",
    "area_alert": "Novo anúncio no bairro que você acompanha",
    "report_rejected": "Seu anúncio precisa de ajustes",
    "expiring": "Seu anúncio está perto de vencer",
    "moderation": "Há itens na moderação do PetSOS",
    "handover": "Novidade na entrega do animal",
}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def normalize_place(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text or "")
    return " ".join("".join(c for c in plain if not unicodedata.combining(c)).casefold().split())


def report_label(r: dict) -> str:
    fallback = "animal perdido" if r["kind"] == "lost" else "animal encontrado"
    return f"{r.get('pet_name') or fallback} ({r['neighborhood']})"


def notification_path(n: dict) -> str:
    if n["kind"] in ("message", "handover") and n.get("conversation_id"):
        return f"/conversa?id={n['conversation_id']}"
    if n["kind"] == "match" and n.get("other_report_id"):
        return f"/comparar?a={n['report_id']}&b={n['other_report_id']}"
    if n["kind"] == "moderation":
        return "/admin"
    return f"/anuncio?id={n['report_id']}" if n.get("report_id") else "/"


def process_new_reports(db, now: datetime) -> dict:
    fields = FIELDS + ",user_id"
    reports = db("/rest/v1/reports", params={
        "select": fields, "review_status": "eq.approved", "status": "eq.open", "matched_at": "is.null",
        "order": "created_at", "limit": str(BATCH),
    })
    alerts = db("/rest/v1/area_alerts", params={"select": "user_id,neighborhood", "limit": "5000"}) if reports else []
    created = 0
    for report in reports:
        params = candidate_params(report, _iso(now))
        params["select"] = fields
        ranked = rank(report, db("/rest/v1/reports", params=params))
        known = {m["other_report_id"] for m in db("/rest/v1/matches", params={"select": "other_report_id", "report_id": f"eq.{report['id']}"})}
        refused = db("/rest/v1/match_feedback", params={
            "select": "report_id,other_report_id",
            "same_animal": "is.false",
            "or": f"(report_id.eq.{report['id']},other_report_id.eq.{report['id']})",
        })
        refused_pairs = {frozenset((f["report_id"], f["other_report_id"])) for f in refused}
        rows, notices = [], []
        for match in ranked:
            other = match["report"]
            rows.append({"report_id": report["id"], "other_report_id": other["id"], "score": match["score"]})
            rows.append({"report_id": other["id"], "other_report_id": report["id"], "score": match["score"]})
            if (other["id"] in known or match["score"] < NOTIFY_MIN_SCORE
                    or frozenset((report["id"], other["id"])) in refused_pairs
                    or report.get("user_id") == other.get("user_id")):
                continue
            for mine, theirs in ((report, other), (other, report)):
                if mine.get("user_id"):
                    notices.append({
                        "user_id": mine["user_id"], "kind": "match", "report_id": mine["id"], "other_report_id": theirs["id"],
                        "body": f"Pode ser o mesmo animal de {report_label(mine)}: {report_label(theirs)}",
                    })
        if rows:
            db("/rest/v1/matches", method="POST", body=rows, prefer="resolution=merge-duplicates,return=minimal")

        place = normalize_place(report["neighborhood"])
        already = {n["user_id"] for n in db("/rest/v1/notifications", params={
            "select": "user_id", "kind": "eq.area_alert", "report_id": f"eq.{report['id']}",
        })}
        for user_id in {a["user_id"] for a in alerts if normalize_place(a["neighborhood"]) == place}:
            if user_id != report.get("user_id") and user_id not in already:
                # Mesmas chaves dos avisos de parecido: o PostgREST recusa lote com objetos de chaves diferentes.
                notices.append({
                    "user_id": user_id, "kind": "area_alert", "report_id": report["id"], "other_report_id": None,
                    "body": f"Novo anúncio no bairro que você acompanha: {report_label(report)}",
                })
        if notices:
            db("/rest/v1/notifications", method="POST", body=notices, prefer="return=minimal")
        created += len(notices)
        db("/rest/v1/reports", method="PATCH", params={"id": f"eq.{report['id']}"}, body={"matched_at": _iso(now)}, prefer="return=minimal")
    return {"reports": len(reports), "notifications": created}


def process_expiring(db, now: datetime) -> int:
    limit = now + timedelta(days=EXPIRY_NOTICE_DAYS)
    rows = db("/rest/v1/reports", params={
        "select": "id,user_id,kind,pet_name,neighborhood", "status": "eq.open", "review_status": "eq.approved",
        "expires_at": f"lt.{_iso(limit)}", "expiry_warned_at": "is.null", "user_id": "not.is.null", "limit": str(BATCH),
    })
    for r in rows:
        db("/rest/v1/notifications", method="POST", prefer="return=minimal", body={
            "user_id": r["user_id"], "kind": "expiring", "report_id": r["id"],
            "body": f"Seu anúncio vence em breve: {report_label(r)}. Renove se o caso continua aberto.",
        })
        db("/rest/v1/reports", method="PATCH", params={"id": f"eq.{r['id']}"}, body={"expiry_warned_at": _iso(now)}, prefer="return=minimal")
    return len(rows)


def resend_mailer():
    """E-mail por HTTP (Resend). Sem as variáveis, não envia nada: os avisos continuam visíveis dentro do site."""
    key, sender = os.environ.get("RESEND_API_KEY"), os.environ.get("EMAIL_FROM")
    if not key or not sender:
        return None

    def send(to: str, subject: str, text: str) -> None:
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=json.dumps({"from": sender, "to": [to], "subject": subject, "text": text}).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "PetSOS/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8):
            pass

    return send


def send_outbox(db, mailer, site_url: str, now: datetime) -> dict:
    if mailer is None:
        return {"sent": 0, "skipped": "e-mail não configurado"}
    rows = db("/rest/v1/notifications", params={
        "select": "id,user_id,kind,report_id,other_report_id,conversation_id,body,created_at",
        "emailed_at": "is.null", "read_at": "is.null", "order": "created_at", "limit": str(BATCH),
    })
    stale_before = now - timedelta(days=STALE_EMAIL_DAYS)
    sent = 0
    for n in rows:
        # Marca antes de enviar: duas execuções ao mesmo tempo não mandam o mesmo e-mail.
        claimed = db("/rest/v1/notifications", method="PATCH", params={"id": f"eq.{n['id']}", "emailed_at": "is.null"},
                     body={"emailed_at": _iso(now)}, prefer="return=representation")
        if not claimed or datetime.fromisoformat(n["created_at"]) < stale_before:
            continue
        profile = db("/rest/v1/profiles", params={"select": "email_alerts", "id": f"eq.{n['user_id']}"})
        if not profile or not profile[0]["email_alerts"]:
            continue
        user = db(f"/auth/v1/admin/users/{n['user_id']}")
        text = f"{n['body']}\n\nAbrir: {site_url}{notification_path(n)}\n\nPara deixar de receber estes e-mails, acesse {site_url}/conta."
        try:
            mailer(user["email"], KIND_SUBJECT[n["kind"]], text)
            sent += 1
        except OSError:
            db("/rest/v1/notifications", method="PATCH", params={"id": f"eq.{n['id']}"}, body={"emailed_at": None}, prefer="return=minimal")
            break  # provedor fora do ar: tenta o restante na próxima execução
    return {"sent": sent}


def process_photo_deletions(db) -> int:
    rows = db("/rest/v1/photo_deletions", params={"select": "path", "limit": "100"})
    if not rows:
        return 0
    paths = [r["path"] for r in rows]
    db("/storage/v1/object/pet-photos", method="DELETE", body={"prefixes": paths})
    quoted = ",".join('"' + p.replace('"', "") + '"' for p in paths)
    db("/rest/v1/photo_deletions", method="DELETE", params={"path": f"in.({quoted})"}, prefer="return=minimal")
    return len(paths)


def purge_old_reports(db, now: datetime) -> int:
    """Retenção prevista na política de privacidade: anúncios encerrados ou vencidos há mais de 12 meses."""
    before = _iso(now - timedelta(days=RETENTION_DAYS))
    # As colunas do "or" precisam estar no select: o PostgREST 12 recusa DELETE com select=id e filtro em outra coluna.
    rows = db("/rest/v1/reports", method="DELETE", prefer="return=representation", params={
        "select": "id,status,expires_at", "updated_at": f"lt.{before}", "or": f"(status.neq.open,expires_at.lt.{before})",
    })
    return len(rows or [])


def run_all(db, mailer, site_url: str, now: datetime) -> dict:
    return {
        "matches": process_new_reports(db, now),
        "expiring": process_expiring(db, now),
        "email": send_outbox(db, mailer, site_url, now),
        "photos": process_photo_deletions(db),
        "purged": purge_old_reports(db, now),
    }
