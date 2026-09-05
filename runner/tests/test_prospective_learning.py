from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from bridge.vct_public_bridge import state_payload
from vct_prediction.automation import _prospective_stats, _record_prospective_snapshot
from vct_prediction.db import Database


class ProspectiveLearningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name) / "vct.sqlite3")
        self.database.initialize()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO data_sources(source_id, name, base_url, source_type, authority_level, enabled, created_at, updated_at)
                   VALUES('vlr', 'VLR.gg', 'https://www.vlr.gg', 'community_public_web', 'secondary', 1, ?, ?)""",
                ("2026-09-03T00:00:00+00:00", "2026-09-03T00:00:00+00:00"),
            )
            for team_id, name in (("team-a", "Team A"), ("team-b", "Team B")):
                connection.execute(
                    "INSERT INTO teams(team_id, name, region, matches_played, updated_at) VALUES(?, ?, 'CN', 5, ?)",
                    (team_id, name, "2026-09-03T00:00:00+00:00"),
                )
            connection.execute(
                """INSERT INTO fixtures(
                   fixture_id, source_id, external_match_id, external_event_id, event, region, classification,
                   scheduled_at, series_format, patch_provenance, team_a_id, team_b_id, team_a_name, team_b_name,
                   map_pool_json, map_pool_provenance, source_url, content_hash, fetched_at, status,
                   quality_status, blocker_json, created_at, updated_at
                ) VALUES('fixture-1', 'vlr', '100', 'event-1', 'VCT Test', 'CN', 'regional',
                   '2026-09-04T00:00:00+00:00', 'bo3', 'unavailable', 'team-a', 'team-b', 'Team A', 'Team B',
                   '[\"ascent\",\"bind\",\"haven\"]', 'observed', 'https://example.test/100', 'raw-hash',
                   '2026-09-03T00:00:00+00:00', 'scheduled', 'ready', '[]', ?, ?)""",
                ("2026-09-03T00:00:00+00:00", "2026-09-03T00:00:00+00:00"),
            )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def fixture(self) -> dict[str, object]:
        return {
            "fixture_id": "fixture-1", "scheduled_at": "2026-09-04T00:00:00+00:00",
            "fetched_at": "2026-09-03T00:00:00+00:00", "event": "VCT Test", "region": "CN",
            "classification": "regional", "stage": None, "series_format": "bo3", "patch": None,
            "patch_provenance": "unavailable", "team_a_id": "team-a", "team_b_id": "team-b",
            "map_pool": ["ascent", "bind", "haven"], "map_pool_provenance": "observed",
            "source_url": "https://example.test/100", "content_hash": "raw-hash", "raw_path": None,
        }

    def test_snapshot_is_append_only_and_idempotent(self) -> None:
        now = datetime(2026, 9, 3, tzinfo=timezone.utc)
        self.assertTrue(_record_prospective_snapshot(self.database, self.fixture(), "ready", [], now))
        self.assertFalse(_record_prospective_snapshot(self.database, self.fixture(), "ready", [], now))
        self.assertTrue(_record_prospective_snapshot(self.database, self.fixture(), "blocked", ["patch_missing"], now))
        stats = _prospective_stats(self.database)
        self.assertEqual(stats["gold_snapshot_total"], 2)
        self.assertEqual(stats["gold_fixture_total"], 1)
        with self.database.connect() as connection:
            snapshots = connection.execute("SELECT snapshot_json FROM prospective_snapshots ORDER BY created_at").fetchall()
        self.assertEqual(json.loads(snapshots[0]["snapshot_json"])["quality_status"], "ready")
        self.assertEqual(json.loads(snapshots[1]["snapshot_json"])["blockers"], ["patch_missing"])

    def test_bridge_exposes_zero_safe_learning_state(self) -> None:
        with self.database.connect() as connection:
            payload = state_payload(connection, [])
        self.assertEqual(payload["learning"]["mode"], "prospective_gold")
        self.assertEqual(payload["learning"]["snapshots"], 0)
        self.assertEqual(payload["learning"]["trainingGate"], 100)


if __name__ == "__main__":
    unittest.main()
