import json
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
from _jobs import normalize_place, notification_path, process_expiring, process_new_reports, process_photo_deletions, purge_old_reports, send_outbox  # noqa: E402
from share import share_page, share_title  # noqa: E402

NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)
DAY = date(2026, 11, 5).isoformat()


def report(**kw):
    base = dict(id="r1", user_id="u1", kind="lost", species="dog", custody=None, pet_name="Thor", sex="male", size="medium",
                colors=["caramelo"], neighborhood="Vila Nova", lat=-23.58, lng=-48.04, event_date=DAY, status="open", review_status="approved")
    base.update(kw)
    return base


class FakeDb:
    """Responde por tabela e registra as escritas."""

    def __init__(self, tables):
        self.tables = tables
        self.writes = []

    def __call__(self, path, method="GET", params=None, body=None, prefer=""):
        if method != "GET":
            self.writes.append((method, path, params, body))
            if method == "PATCH" and "notifications" in path:
                return [{}]
            if method == "DELETE" and path.endswith("reports"):
                return [{"id": "old"}]
            return None
        name = path.split("/")[-1]
        if path.startswith("/auth/"):
            return {"email": "pessoa@exemplo.com"}
        rows = self.tables.get(name, [])
        return rows(params) if callable(rows) else rows

    def written(self, table, method="POST"):
        return [w for w in self.writes if w[0] == method and w[1].endswith(table)]


class NewReportsTest(unittest.TestCase):
    def db(self, **extra):
        lost = report()
        found = report(id="r2", user_id="u2", kind="found", custody="with_finder", pet_name=None, neighborhood="Centro")

        def reports(params):
            return [lost] if params.get("matched_at") == "is.null" else [found]

        return FakeDb({"reports": reports, "matches": [], "match_feedback": [], "area_alerts": [], "notifications": [], **extra})

    def test_new_match_notifies_both_owners_and_marks_report(self):
        db = self.db()
        result = process_new_reports(db, NOW)
        self.assertEqual(result["notifications"], 2)
        [(_, _, _, notices)] = db.written("notifications")
        self.assertEqual({n["user_id"] for n in notices}, {"u1", "u2"})
        self.assertEqual(len(db.written("matches")[0][3]), 2)
        self.assertEqual(db.written("reports", "PATCH")[0][3], {"matched_at": NOW.isoformat()})

    def test_known_match_is_not_notified_again(self):
        db = self.db(matches=[{"other_report_id": "r2"}])
        self.assertEqual(process_new_reports(db, NOW)["notifications"], 0)

    def test_refused_match_is_not_notified(self):
        db = self.db(match_feedback=[{"report_id": "r2", "other_report_id": "r1"}])
        self.assertEqual(process_new_reports(db, NOW)["notifications"], 0)

    def test_area_alert_ignores_case_and_accents_and_the_author(self):
        db = self.db(area_alerts=[{"user_id": "u9", "neighborhood": "VILA  NÓVA"}, {"user_id": "u1", "neighborhood": "Vila Nova"}],
                     reports=lambda p: [report()] if p.get("matched_at") else [])
        process_new_reports(db, NOW)
        [(_, _, _, notices)] = db.written("notifications")
        self.assertEqual([(n["user_id"], n["kind"]) for n in notices], [("u9", "area_alert")])

    def test_batch_of_notices_shares_the_same_keys(self):
        db = self.db(area_alerts=[{"user_id": "u9", "neighborhood": "Vila Nova"}])
        process_new_reports(db, NOW)
        [(_, _, _, notices)] = db.written("notifications")
        self.assertEqual({n["kind"] for n in notices}, {"match", "area_alert"})
        self.assertEqual(len({frozenset(n) for n in notices}), 1)

    def test_area_alert_is_not_repeated_after_edit(self):
        db = self.db(area_alerts=[{"user_id": "u9", "neighborhood": "Vila Nova"}], notifications=[{"user_id": "u9"}],
                     reports=lambda p: [report()] if p.get("matched_at") else [])
        process_new_reports(db, NOW)
        self.assertEqual(db.written("notifications"), [])


class OutboxTest(unittest.TestCase):
    def notification(self, **kw):
        base = dict(id=1, user_id="u1", kind="message", report_id="r1", other_report_id=None, conversation_id="c1",
                    body="Nova mensagem", created_at=NOW.isoformat())
        base.update(kw)
        return base

    def test_sends_with_link_and_without_message_body(self):
        sent = []
        db = FakeDb({"notifications": [self.notification()], "profiles": [{"email_alerts": True}]})
        result = send_outbox(db, lambda to, subject, text: sent.append((to, subject, text)), "https://x.test", NOW)
        self.assertEqual(result["sent"], 1)
        self.assertIn("https://x.test/conversa?id=c1", sent[0][2])

    def test_respects_preference(self):
        sent = []
        db = FakeDb({"notifications": [self.notification()], "profiles": [{"email_alerts": False}]})
        send_outbox(db, lambda *a: sent.append(a), "https://x.test", NOW)
        self.assertEqual(sent, [])

    def test_old_backlog_is_not_sent(self):
        sent = []
        old = (NOW - timedelta(days=30)).isoformat()
        db = FakeDb({"notifications": [self.notification(created_at=old)], "profiles": [{"email_alerts": True}]})
        send_outbox(db, lambda *a: sent.append(a), "https://x.test", NOW)
        self.assertEqual(sent, [])

    def test_failure_releases_the_notification_for_retry(self):
        def fail(*a):
            raise OSError("fora do ar")
        db = FakeDb({"notifications": [self.notification()], "profiles": [{"email_alerts": True}]})
        result = send_outbox(db, fail, "https://x.test", NOW)
        self.assertEqual(result["sent"], 0)
        self.assertEqual(db.written("notifications", "PATCH")[-1][3], {"emailed_at": None})

    def test_without_provider_keeps_queue_untouched(self):
        db = FakeDb({"notifications": [self.notification()]})
        self.assertEqual(send_outbox(db, None, "https://x.test", NOW)["sent"], 0)
        self.assertEqual(db.writes, [])

    def test_links_by_kind(self):
        self.assertEqual(notification_path(dict(kind="match", report_id="a", other_report_id="b")), "/comparar?a=a&b=b")
        self.assertEqual(notification_path(dict(kind="moderation")), "/admin")
        self.assertEqual(notification_path(dict(kind="expiring", report_id="a")), "/anuncio?id=a")


class HousekeepingTest(unittest.TestCase):
    def test_expiring_warns_once(self):
        db = FakeDb({"reports": [dict(id="r1", user_id="u1", kind="lost", pet_name="Thor", neighborhood="Centro")]})
        self.assertEqual(process_expiring(db, NOW), 1)
        self.assertEqual(db.written("notifications")[0][3]["kind"], "expiring")
        self.assertIn("expiry_warned_at", db.written("reports", "PATCH")[0][3])

    def test_photo_queue_is_cleared_after_removal(self):
        db = FakeDb({"photo_deletions": [{"path": "u1/a.webp"}, {"path": "u1/a-thumb.webp"}]})
        self.assertEqual(process_photo_deletions(db), 2)
        self.assertEqual(db.writes[0][3], {"prefixes": ["u1/a.webp", "u1/a-thumb.webp"]})
        self.assertEqual(db.writes[1][2], {"path": 'in.("u1/a.webp","u1/a-thumb.webp")'})

    def test_purge_never_targets_open_valid_reports(self):
        db = FakeDb({})
        purge_old_reports(db, NOW)
        params = db.writes[0][2]
        self.assertIn("status.neq.open", params["or"])
        self.assertIn("expires_at.lt.", params["or"])

    def test_normalize_place(self):
        self.assertEqual(normalize_place("  Taboãozinho "), "taboaozinho")


class SharePageTest(unittest.TestCase):
    def test_title_and_escaping(self):
        os.environ["SUPABASE_URL"] = "https://x.supabase.co"
        r = dict(id="r1", kind="lost", species="dog", custody=None, pet_name='<b>"Thor"</b>', neighborhood="Centro",
                 description="<script>alert(1)</script>", photo_path="u1/a b.webp", status="open")
        page = share_page(r)
        self.assertNotIn("<script>", page)
        self.assertNotIn("<b>", page)
        self.assertIn("pet-photos/u1/a%20b.webp", page)
        self.assertEqual(share_title(dict(kind="found", custody="sighted", species="cat", pet_name=None, neighborhood="Centro")), "Avistado: Gato, Centro")


if __name__ == "__main__":
    unittest.main()
