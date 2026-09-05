from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vct_prediction.automation import (
    _lock_ready_predictions,
    _register_source,
    _upsert_fixture,
    today_predictions,
)
from vct_prediction.db import Database
from vct_prediction.ingest import load_teams


class AutomationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.db = Database(self.base / "auto.sqlite3")
        self.db.initialize()
        teams_path = self.base / "teams.json"
        teams_path.write_text(json.dumps({"teams": [
            {"team_id": "vlr_team_1", "name": "Alpha", "region": "CN"},
            {"team_id": "vlr_team_2", "name": "Beta", "region": "CN"},
        ]}), encoding="utf-8")
        load_teams(self.db, teams_path)
        _register_source(self.db)
        now = datetime.now(timezone.utc)
        with self.db.connect() as conn:
            conn.execute("UPDATE teams SET matches_played=3")
            for index, map_id in enumerate(("ascent", "bind", "haven"), 1):
                match_id = f"history-{index}"
                played_at = (now - timedelta(days=10 - index)).isoformat()
                conn.execute(
                    """INSERT INTO matches(
                           match_id, event, region, played_at, patch, series_format,
                           team_a_id, team_b_id, winner_id, team_a_maps, team_b_maps,
                           processed, inserted_at
                       ) VALUES(?, 'VCT 2026: China Stage 2', 'CN', ?, 'cohort:2026-stage2',
                                'bo3', 'vlr_team_1', 'vlr_team_2', 'vlr_team_1', 2, 0, 1, ?)""",
                    (match_id, played_at, played_at),
                )
                conn.execute(
                    "INSERT INTO map_results(match_id, map_order, map_id, team_a_rounds, team_b_rounds) VALUES(?, 1, ?, 13, 8)",
                    (match_id, map_id),
                )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def fixture(self, scheduled_at: str) -> dict:
        return {
            "fixture_id": "vlr_fixture_99",
            "external_match_id": "99",
            "external_event_id": "20",
            "event": "VCT 2026: China Stage 2",
            "region": "CN",
            "classification": "regional",
            "stage": "Playoffs",
            "scheduled_at": scheduled_at,
            "series_format": "bo3",
            "patch": "cohort:2026-stage2",
            "patch_provenance": "event_cohort_inferred_exact_patch_unavailable",
            "teams": [
                {"external_team_id": "1", "team_id": "vlr_team_1", "name": "Alpha"},
                {"external_team_id": "2", "team_id": "vlr_team_2", "name": "Beta"},
            ],
            "source_url": "https://www.vlr.gg/99/test",
            "raw_path": str(self.base / "raw.html"),
            "content_hash": "abc",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "status": "scheduled",
            "blockers": [],
        }

    def test_ready_fixture_locks_once_without_manual_review(self) -> None:
        now = datetime.now(timezone.utc)
        status, blockers = _upsert_fixture(self.db, self.fixture((now + timedelta(hours=6)).isoformat()), now)
        self.assertEqual(status, "ready")
        self.assertEqual(blockers, [])
        first = _lock_ready_predictions(self.db, now, 48)
        second = _lock_ready_predictions(self.db, now, 48)
        self.assertEqual(first["predictions_locked"], 1)
        self.assertEqual(second["predictions_locked"], 0)
        with self.db.connect() as conn:
            row = conn.execute("SELECT source, lock_policy, fixture_id FROM predictions").fetchone()
        self.assertEqual(row["source"], "system_auto")
        self.assertEqual(row["lock_policy"], "unattended_hard_gate_v1.1")
        self.assertEqual(row["fixture_id"], "vlr_fixture_99")
        today = today_predictions(self.db, hours=48)
        self.assertEqual(today["fixtures"][0]["quality_status"], "locked")
        self.assertTrue(today["fixtures"][0]["prediction_id"])

    def test_past_fixture_is_blocked(self) -> None:
        now = datetime.now(timezone.utc)
        status, blockers = _upsert_fixture(self.db, self.fixture((now - timedelta(minutes=1)).isoformat()), now)
        self.assertEqual(status, "blocked")
        self.assertIn("scheduled_time_passed", blockers)
        result = _lock_ready_predictions(self.db, now, 48)
        self.assertEqual(result["predictions_locked"], 0)


if __name__ == "__main__":
    unittest.main()
