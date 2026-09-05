from __future__ import annotations

import json
import random
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vct_prediction.replay import (  # noqa: E402
    DEFAULT_EVENT,
    HistoricalReplayBuilder,
    open_read_only,
    poison_future_test,
)


DB_PATH = ROOT / "data" / "vct.sqlite3"


@unittest.skipUnless(DB_PATH.exists(), "formal historical database is unavailable")
class HistoricalReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = json.loads((ROOT / "config" / "default.json").read_text(encoding="utf-8"))
        cls.connection = open_read_only(DB_PATH)
        cls.builder = HistoricalReplayBuilder(cls.connection, cls.config)
        cls.sample = cls.builder.select_cn_sample(event=DEFAULT_EVENT, min_prior_matches=5, limit=30)
        cls.records = [cls.builder.build(row["match_id"]) for row in cls.sample]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()

    def test_full_event_sample_is_bounded_and_has_history(self) -> None:
        self.assertEqual(len(self.sample), 30)
        self.assertEqual({row["event"] for row in self.sample}, {DEFAULT_EVENT})
        self.assertGreaterEqual(min(min(row["prior_a"], row["prior_b"]) for row in self.sample), 5)
        self.assertEqual(self.sample[0]["played_at"], "2026-01-22T04:00:00+00:00")
        self.assertEqual(self.sample[-1]["played_at"], "2026-02-09T04:00:00+00:00")

    def test_formal_database_connection_is_query_only(self) -> None:
        with self.assertRaises(sqlite3.OperationalError):
            self.connection.execute("CREATE TABLE replay_write_probe(value TEXT)")

    def test_every_source_is_strictly_before_target(self) -> None:
        for record in self.records:
            with self.subTest(match_id=record["match_id"]):
                self.assertLess(record["max_source_match_time"], record["match_time"])
                all_ids = {
                    item for values in record["source_match_ids_by_feature"].values() for item in values
                }
                self.assertNotIn(record["match_id"], all_ids)
                for detail in (record["player_form_detail_a"], record["player_form_detail_b"]):
                    for player in detail["players"]:
                        if player["observed_at"] is not None:
                            self.assertLess(player["observed_at"], record["match_time"])

    def test_current_state_is_not_used(self) -> None:
        target = self.records[0]
        clone = sqlite3.connect(":memory:")
        clone.row_factory = sqlite3.Row
        self.connection.backup(clone)
        clone.execute(
            """UPDATE teams SET rating=9999,player_form=1,roster_continuity=0,patch_fit=1
               WHERE team_id IN (?,?)""",
            (target["team_a_id"], target["team_b_id"]),
        )
        clone.execute(
            "UPDATE team_map_ratings SET rating=9999,matches_played=999 WHERE team_id IN (?,?)",
            (target["team_a_id"], target["team_b_id"]),
        )
        clone.commit()
        rebuilt = HistoricalReplayBuilder(clone, self.config).build(target["match_id"])
        clone.close()
        self.assertEqual(target, rebuilt)

    def test_missing_values_are_explicit_and_gap_targets_are_retained(self) -> None:
        target_gaps = self.connection.execute(
            """SELECT COUNT(DISTINCT m.match_id)
               FROM matches m JOIN match_player_stats s ON s.match_id=m.match_id
               WHERE m.event=? AND (s.acs IS NULL OR s.adr IS NULL OR s.kast IS NULL
                    OR s.rating IS NULL OR s.first_kills IS NULL OR s.first_deaths IS NULL)""",
            (DEFAULT_EVENT,),
        ).fetchone()[0]
        self.assertGreater(target_gaps, 0)
        valid = {"observed", "imputed_team_mean", "feature_unavailable"}
        for record in self.records:
            for side in ("player_stats_a", "player_stats_b"):
                for metric in ("acs", "adr", "kast", "rating", "fk_fd"):
                    detail = record[side][metric]
                    self.assertIn(detail["status"], valid)
                    if detail["status"] == "feature_unavailable":
                        self.assertIsNone(detail["value"])
                    if detail["status"] == "imputed_team_mean":
                        self.assertTrue(detail["missing_player_ids"])
                        self.assertIsNotNone(detail["imputation_value"])

    def test_poison_future_does_not_change_past_features(self) -> None:
        ids = random.Random(1401).sample([row["match_id"] for row in self.sample], 5)
        result = poison_future_test(self.connection, self.config, ids)
        self.assertTrue(result["passed"], result["changed_fields_by_match"])
        self.assertEqual(result["changed_fields_by_match"], {})


if __name__ == "__main__":
    unittest.main()
