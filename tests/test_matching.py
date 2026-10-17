import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
from _matching import rank, score_pair  # noqa: E402

TODAY = date(2026, 10, 10)


def make(**kw):
    base = dict(id="x", kind="lost", species="dog", sex="male", size="medium", colors=["caramelo", "branco"],
                lat=-23.5872, lng=-48.0418, event_date=TODAY.isoformat(), status="open")
    base.update(kw)
    return base


class FixedImage:
    def __init__(self, value):
        self.value = value

    def compare(self, a, b):
        return self.value


class MatchingTest(unittest.TestCase):
    def setUp(self):
        self.lost = make(id="lost")

    def test_close_similar_found_scores_high(self):
        found = make(id="f1", kind="found", lat=-23.5913, lng=-48.0485, event_date=(TODAY + timedelta(days=2)).isoformat())
        [m] = rank(self.lost, [found])
        self.assertGreater(m["score"], 0.8)
        self.assertIn("Mesmo porte", m["reasons"])

    def test_hard_filters(self):
        cands = [
            make(id="same-kind"),
            make(id="cat", kind="found", species="cat"),
            make(id="female", kind="found", sex="female"),
            make(id="closed", kind="found", status="reunited"),
            make(id="before", kind="found", event_date=(TODAY - timedelta(days=10)).isoformat()),
            make(id="lost", kind="found"),
            make(id="pending", kind="found", review_status="pending"),
        ]
        self.assertEqual(rank(self.lost, cands), [])

    def test_ranking_order_prefers_nearer_and_same_colors(self):
        near = make(id="near", kind="found", lat=-23.588, lng=-48.042)
        far = make(id="far", kind="found", lat=-23.70, lng=-48.20, colors=["preto"])
        result = rank(self.lost, [far, near], min_score=0)
        self.assertEqual([r["report"]["id"] for r in result], ["near", "far"])

    def test_image_similarity_is_pluggable(self):
        found = make(id="f", kind="found", lat=-23.62, lng=-48.08)
        base = score_pair(self.lost, found)["score"]
        boosted = score_pair(self.lost, found, FixedImage(1.0))
        lowered = score_pair(self.lost, found, FixedImage(0.0))["score"]
        self.assertGreater(boosted["score"], base)
        self.assertLess(lowered, base)
        self.assertIn("image", boosted["breakdown"])

    def test_symmetric(self):
        found = make(id="f", kind="found", lat=-23.60, lng=-48.05, event_date=(TODAY + timedelta(days=5)).isoformat())
        self.assertEqual(score_pair(self.lost, found)["score"], score_pair(found, self.lost)["score"])


if __name__ == "__main__":
    unittest.main()
