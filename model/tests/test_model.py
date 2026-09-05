from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vct_prediction.backtest import evaluate
from vct_prediction.db import Database
from vct_prediction.ingest import load_teams, record_match, record_roster_event
from vct_prediction.maps import series_distribution
from vct_prediction.predictor import predict_match
from vct_prediction.ratings import calculate_update, score_quality
from vct_prediction.reviews import build_prediction_review, list_prediction_reviews


class RatingTests(unittest.TestCase):
    def test_score_quality_rewards_sweep(self) -> None:
        self.assertGreater(score_quality(2, 0, 12), score_quality(2, 1, 2))
        self.assertLess(score_quality(0, 2, -12), 0.5)

    def test_upset_moves_more_than_expected_win(self) -> None:
        upset = calculate_update(1400, 1600, 2, 0, 10)
        favorite = calculate_update(1600, 1400, 2, 0, 10)
        self.assertGreater(upset.delta_a, favorite.delta_a)


class SeriesTests(unittest.TestCase):
    def test_bo3_distribution_is_complete(self) -> None:
        distribution = series_distribution([0.5, 0.5, 0.5], "bo3")
        self.assertAlmostEqual(sum(distribution.values()), 1.0)
        self.assertAlmostEqual(distribution["2-0"], 0.25)
        self.assertAlmostEqual(distribution["0-2"], 0.25)

    def test_bo5_distribution_is_complete(self) -> None:
        distribution = series_distribution([0.55] * 5, "bo5")
        self.assertAlmostEqual(sum(distribution.values()), 1.0)
        self.assertEqual(set(distribution), {"0-3", "1-3", "2-3", "3-0", "3-1", "3-2"})


class EndToEndTests(unittest.TestCase):
    def test_initialize_preserves_explicit_calibrated_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "config.sqlite3")
            db.initialize()
            calibrated = {**db.config(), "series_k": 37.0}
            db.initialize(calibrated)
            db.initialize()
            self.assertEqual(db.config()["series_k"], 37.0)

    def test_team_context_does_not_leak_future_roster(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            db = Database(base / "roster.sqlite3")
            db.initialize()
            teams_path = base / "teams.json"
            teams_path.write_text(json.dumps({"teams": [{"team_id": "a", "name": "A", "region": "CN"}]}), encoding="utf-8")
            load_teams(db, teams_path)
            record_roster_event(db, team_id="a", effective_at="2026-01-01T00:00:00+00:00", roster_version="r1", changed_players=0, continuity=1.0)
            record_roster_event(db, team_id="a", effective_at="2026-07-01T00:00:00+00:00", roster_version="r2", changed_players=2, continuity=0.6)
            historical = db.team_context_as_of("a", "2026-04-01T00:00:00+00:00")
            current = db.team_context_as_of("a", "2026-08-01T00:00:00+00:00")
            self.assertEqual(historical["roster_version"], "r1")
            self.assertEqual(historical["roster_continuity"], 1.0)
            self.assertEqual(current["roster_version"], "r2")

    def test_lock_resolve_and_backtest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            db = Database(base / "test.sqlite3")
            db.initialize()
            teams_path = base / "teams.json"
            teams_path.write_text(json.dumps({"teams": [
                {"team_id": "a", "name": "A", "region": "CN"},
                {"team_id": "b", "name": "B", "region": "CN"},
            ]}), encoding="utf-8")
            load_teams(db, teams_path)
            prediction = predict_match(
                db,
                team_a_id="a",
                team_b_id="b",
                scheduled_at="2026-01-02T10:00:00+08:00",
                event="Test",
                region="CN",
                patch="12.01",
                series_format="bo3",
                map_pool=["亚海悬城", "源工重镇", "隐世修所", "霓虹町", "莲华古城", "日落之城", "盐海矿镇"],
                locked_at="2026-01-02T09:00:00+08:00",
            )
            self.assertAlmostEqual(prediction["team_a"]["win_probability"], 0.5)
            record_match(db, {
                "match_id": "m1",
                "event": "Test",
                "region": "CN",
                "played_at": "2026-01-02T10:00:00+08:00",
                "patch": "12.01",
                "series_format": "bo3",
                "team_a_id": "a",
                "team_b_id": "b",
                "maps": [
                    {"map": "亚海悬城", "team_a_rounds": 13, "team_b_rounds": 8},
                    {"map": "莲华古城", "team_a_rounds": 13, "team_b_rounds": 10},
                ],
            }, process=True)
            metrics = evaluate(db)
            self.assertEqual(metrics["overall"]["n"], 1)
            self.assertEqual(metrics["overall"]["accuracy"], 1.0)
            self.assertAlmostEqual(metrics["overall"]["brier_score"], 0.25)

    def test_resolved_system_prediction_generates_evidence_bound_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            db = Database(base / "review.sqlite3")
            db.initialize()
            teams_path = base / "teams.json"
            teams_path.write_text(json.dumps({"teams": [
                {"team_id": "a", "name": "A", "region": "CN"},
                {"team_id": "b", "name": "B", "region": "CN"},
            ]}), encoding="utf-8")
            load_teams(db, teams_path)
            prediction = predict_match(
                db,
                team_a_id="a",
                team_b_id="b",
                scheduled_at="2026-04-02T10:00:00+08:00",
                event="Review Test",
                region="CN",
                patch="12.05",
                series_format="bo3",
                map_pool=["亚海悬城", "源工重镇", "隐世修所", "霓虹町", "莲华古城", "日落之城", "盐海矿镇"],
                locked_at="2026-04-02T09:00:00+08:00",
                source="system_auto",
            )
            record_match(db, {
                "match_id": "review-m1",
                "event": "Review Test",
                "region": "CN",
                "played_at": "2026-04-02T10:00:00+08:00",
                "patch": "12.05",
                "series_format": "bo3",
                "team_a_id": "a",
                "team_b_id": "b",
                "maps": [
                    {"map": "亚海悬城", "team_a_rounds": 13, "team_b_rounds": 9},
                    {"map": "莲华古城", "team_a_rounds": 13, "team_b_rounds": 11},
                ],
            }, process=True)
            review = build_prediction_review(db, prediction["prediction_id"])
            self.assertTrue(review["winner_correct"])
            self.assertEqual(review["actual_maps"][0]["map"], "亚海悬城")
            self.assertEqual(review["brier_score"], 0.25)
            self.assertIn("interpretation_boundary", review["diagnostics"])
            self.assertEqual(len(list_prediction_reviews(db)), 1)

    def test_rejects_post_match_lock_and_naive_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            db = Database(base / "test.sqlite3")
            db.initialize()
            teams_path = base / "teams.json"
            teams_path.write_text(json.dumps({"teams": [
                {"team_id": "a", "name": "A", "region": "CN"},
                {"team_id": "b", "name": "B", "region": "CN"},
            ]}), encoding="utf-8")
            load_teams(db, teams_path)
            common = dict(
                db=db,
                team_a_id="a",
                team_b_id="b",
                event="Test",
                region="CN",
                patch="12.01",
                series_format="bo3",
                map_pool=["亚海悬城", "源工重镇", "隐世修所"],
            )
            with self.assertRaisesRegex(ValueError, "不能晚于"):
                predict_match(
                    **common,
                    scheduled_at="2026-01-02T10:00:00+08:00",
                    locked_at="2026-01-02T10:00:01+08:00",
                )
            with self.assertRaisesRegex(ValueError, "必须包含时区"):
                predict_match(
                    **common,
                    scheduled_at="2026-01-02T10:00:00",
                    locked_at="2026-01-02T09:00:00",
                )


if __name__ == "__main__":
    unittest.main()
