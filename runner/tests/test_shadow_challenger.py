from __future__ import annotations

import tempfile
import unittest
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from vct_prediction.db import Database
from vct_prediction.automation import _lock_ready_predictions
from vct_prediction.constants import MAPS
from vct_prediction.shadow import (
    FrozenLogisticC1,
    ProspectiveFeatureBuilder,
    create_feature_snapshot,
    freeze_shadow_prediction,
    prospective_metrics,
    settle_shadow_predictions,
)


ARTIFACT = Path(__file__).parents[1] / "artifacts" / "logistic_c1_v1_4b_20260903"


class ShadowChallengerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temporary.name) / "vct.sqlite3")
        self.db.initialize()
        with self.db.connect() as conn:
            conn.execute("INSERT INTO data_sources(source_id,name,base_url,source_type,authority_level,enabled,created_at,updated_at) VALUES('vlr','VLR','https://www.vlr.gg','community','secondary',1,?,?)", ("2026-09-03T00:00:00+00:00",)*2)
            for team_id in ("team-a", "team-b"):
                conn.execute("INSERT INTO teams(team_id,name,region,updated_at) VALUES(?,?, 'CN',?)", (team_id, team_id, "2026-09-03T00:00:00+00:00"))
            conn.execute(
                """INSERT INTO fixtures(fixture_id,source_id,external_match_id,external_event_id,event,region,classification,
                   scheduled_at,series_format,patch_provenance,team_a_id,team_b_id,team_a_name,team_b_name,map_pool_json,
                   map_pool_provenance,source_url,content_hash,fetched_at,status,quality_status,blocker_json,created_at,updated_at)
                   VALUES('fixture-1','vlr','100','event-1','Test','CN','regional','2026-09-04T00:00:00+00:00','bo3',
                   'unavailable','team-a','team-b','A','B','[]','unavailable','https://example.test','hash',
                   '2026-09-03T00:00:00+00:00','scheduled','ready','[]',?,?)""", ("2026-09-03T00:00:00+00:00",)*2,
            )
            conn.execute(
                """INSERT INTO prospective_snapshots(snapshot_id,fixture_id,observed_at,checkpoint,scheduled_at,quality_status,
                   blocker_json,snapshot_json,content_hash,model_version,outcome_status,created_at)
                   VALUES('gold-1','fixture-1','2026-09-03T00:00:00+00:00','T-24h','2026-09-04T00:00:00+00:00',
                   'ready','[]','{}','gold-hash','v1.0.0','pending','2026-09-03T00:00:00+00:00')"""
            )
            conn.execute(
                """INSERT INTO predictions(prediction_id,source,model_version,locked_at,scheduled_at,event,region,series_format,
                   team_a_id,team_b_id,predicted_winner_id,team_a_win_probability,team_b_win_probability,predicted_score,
                   score_distribution_json,map_probabilities_json,factor_snapshot_json,bp_plan_json,status,fixture_id,lock_policy)
                   VALUES('champion-1','system_auto','v1.0.0','2026-09-03T12:00:00+00:00','2026-09-04T00:00:00+00:00',
                   'Test','CN','bo3','team-a','team-b','team-a',0.6,0.4,'2-1','{}','[]','{}','{}','locked','fixture-1','test')"""
            )
        self.fixture = {
            "fixture_id": "fixture-1", "source_id": "vlr", "scheduled_at": "2026-09-04T00:00:00+00:00",
            "team_a_id": "team-a", "team_b_id": "team-b", "quality_status": "ready",
        }
        self.champion = {
            "prediction_id": "champion-1", "locked_at": "2026-09-03T12:00:00+00:00",
            "model_version": "v1.0.0", "team_a_win_probability": 0.6,
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_frozen_artifact_loads_without_training_api(self) -> None:
        model = FrozenLogisticC1(ARTIFACT)
        self.assertEqual(model.model_id, "logistic_c1_v1.4b_20260903")
        self.assertEqual(model.dataset_version, "v1.4b-c1-20260903")
        self.assertEqual(len(model.artifact_hash), 64)
        self.assertFalse(hasattr(model, "fit"))

    def test_future_fact_cannot_change_cutoff_features(self) -> None:
        cutoff = "2026-09-03T12:00:00+00:00"
        with self.db.connect() as conn:
            before = ProspectiveFeatureBuilder(conn, self.db.config()).build(self.fixture, cutoff)
            conn.execute(
                """INSERT INTO matches(match_id,event,region,played_at,series_format,team_a_id,team_b_id,winner_id,
                   team_a_maps,team_b_maps,inserted_at) VALUES('future','Poison','CN','2026-09-03T18:00:00+00:00','bo3',
                   'team-a','team-b','team-a',2,0,'2026-09-03T18:00:00+00:00')"""
            )
            after = ProspectiveFeatureBuilder(conn, self.db.config()).build(self.fixture, cutoff)
        self.assertEqual(before, after)

    def test_freeze_is_immutable_and_isolated_test_never_counts(self) -> None:
        model = FrozenLogisticC1(ARTIFACT)
        snapshot = create_feature_snapshot(self.db, self.fixture, self.champion["locked_at"])
        frozen = freeze_shadow_prediction(self.db, self.fixture, self.champion, snapshot, model, record_kind="isolated_test")
        self.assertEqual(frozen["status"], "locked")
        self.assertEqual(frozen["eligible"], 0)
        with self.assertRaises(Exception):
            with self.db.connect() as conn:
                conn.execute("UPDATE challenger_predictions SET challenger_probability=0.99 WHERE shadow_prediction_id=?", (frozen["shadow_prediction_id"],))
        with self.db.connect() as conn:
            conn.execute(
                """INSERT INTO matches(match_id,event,region,played_at,series_format,team_a_id,team_b_id,winner_id,
                   team_a_maps,team_b_maps,inserted_at) VALUES('result-1','Test','CN','2026-09-04T00:00:00+00:00','bo3',
                   'team-a','team-b','team-b',1,2,'2026-09-04T02:00:00+00:00')"""
            )
            conn.execute("UPDATE predictions SET status='resolved',actual_winner_id='team-b',actual_score='1-2',resolved_match_id='result-1' WHERE prediction_id='champion-1'")
        self.assertEqual(settle_shadow_predictions(self.db)["challenger_settled"], 1)
        self.assertEqual(settle_shadow_predictions(self.db)["challenger_settled"], 0)
        metrics = prospective_metrics(self.db)
        self.assertEqual(metrics["eligible_resolved_matches"], 0)
        self.assertEqual(metrics["phase"], "ACCUMULATING")

    def test_automation_freezes_both_models_against_same_snapshot(self) -> None:
        with self.db.connect() as conn:
            conn.execute("DELETE FROM predictions WHERE prediction_id='champion-1'")
            conn.execute("UPDATE fixtures SET prediction_id=NULL,quality_status='ready',map_pool_json=? WHERE fixture_id='fixture-1'", (json.dumps(list(MAPS)),))
        result = _lock_ready_predictions(self.db, datetime(2026, 9, 3, 12, tzinfo=timezone.utc), 48)
        self.assertEqual(result["predictions_locked"], 1)
        self.assertEqual(result["challenger_predictions_frozen"], 1, result)
        with self.db.connect() as conn:
            champion = conn.execute("SELECT prediction_id,factor_snapshot_json FROM predictions WHERE fixture_id='fixture-1'").fetchone()
            shadow = conn.execute("SELECT * FROM challenger_predictions WHERE fixture_id='fixture-1'").fetchone()
            snapshot = conn.execute("SELECT content_hash,gold_snapshot_id,feature_cutoff_at FROM challenger_feature_snapshots WHERE snapshot_id=?", (shadow["feature_snapshot_id"],)).fetchone()
            pair = conn.execute("SELECT * FROM prediction_pairs WHERE fixture_id='fixture-1'").fetchone()
        context = json.loads(champion["factor_snapshot_json"])["prediction_context"]
        self.assertEqual(context["shared_prematch_snapshot_id"], shadow["feature_snapshot_id"])
        self.assertEqual(context["shared_prematch_snapshot_hash"], snapshot["content_hash"])
        self.assertEqual(context["gold_snapshot_id"], snapshot["gold_snapshot_id"])
        self.assertEqual(context["feature_cutoff_at"], snapshot["feature_cutoff_at"])
        self.assertEqual(pair["status"], "PAIRED")
        self.assertLess(shadow["frozen_at"], shadow["scheduled_at"])

    def _resolve_pair(self, winner: str = "team-a") -> str:
        model = FrozenLogisticC1(ARTIFACT)
        snapshot = create_feature_snapshot(self.db, self.fixture, self.champion["locked_at"])
        frozen = freeze_shadow_prediction(self.db, self.fixture, self.champion, snapshot, model)
        with self.db.connect() as conn:
            conn.execute("""INSERT INTO matches(match_id,event,region,played_at,series_format,team_a_id,team_b_id,winner_id,
                team_a_maps,team_b_maps,inserted_at) VALUES('result-1','Test','CN','2026-09-04T00:00:00+00:00','bo3',
                'team-a','team-b',?,2,0,'2026-09-04T02:00:00+00:00')""", (winner,))
            conn.execute("UPDATE predictions SET status='resolved',actual_winner_id=?,actual_score='2-0',resolved_match_id='result-1' WHERE prediction_id='champion-1'", (winner,))
        return frozen["shadow_prediction_id"]

    def test_team_a_and_team_b_settlement_use_canonical_aliased_winner(self) -> None:
        for winner in ("team-a", "team-b"):
            with self.subTest(winner=winner):
                if winner == "team-b":
                    self.tearDown()
                    self.setUp()
                shadow_id = self._resolve_pair(winner)
                result = settle_shadow_predictions(self.db)
                self.assertEqual(result["challenger_settled"], 1)
                with self.db.connect() as conn:
                    row = conn.execute("SELECT * FROM challenger_predictions WHERE shadow_prediction_id=?", (shadow_id,)).fetchone()
                self.assertEqual(row["actual_winner_id"], winner)
                self.assertEqual(row["resolved_match_id"], "result-1")
                self.assertAlmostEqual(row["champion_brier"], .16 if winner == "team-a" else .36)
                self.assertAlmostEqual(row["champion_log_loss"], -math.log(.6 if winner == "team-a" else .4))
                self.assertEqual(row["champion_correct"], int(winner == "team-a"))
                metrics = prospective_metrics(self.db)
                self.assertEqual(metrics["eligible_resolved_matches"], 1)
                self.assertEqual(metrics["metric_integrity"]["status"], "TRUSTED")
                self.assertAlmostEqual(metrics["metrics"]["champion"]["accuracy"], int(winner == "team-a"))
                self.assertEqual(settle_shadow_predictions(self.db)["challenger_settled"], 0)

    def test_legacy_null_winner_repair_is_audited_idempotent_and_preserves_freeze(self) -> None:
        shadow_id = self._resolve_pair()
        with self.db.connect() as conn:
            conn.execute("""UPDATE challenger_predictions SET status='resolved',actual_winner_id=NULL,resolved_match_id=NULL,
                champion_brier=.36,challenger_brier=.25,champion_log_loss=?,challenger_log_loss=?,champion_correct=0,
                challenger_correct=0,resolved_at='2026-09-04T03:00:00+00:00' WHERE shadow_prediction_id=?""", (-math.log(.4), -math.log(.5), shadow_id))
            before = dict(conn.execute("SELECT * FROM challenger_predictions WHERE shadow_prediction_id=?", (shadow_id,)).fetchone())
        untrusted = prospective_metrics(self.db)
        self.assertEqual(untrusted["metric_integrity"]["status"], "DEGRADED")
        self.assertIsNone(untrusted["metrics"])
        self.assertEqual(settle_shadow_predictions(self.db)["challenger_metrics_repaired"], 1)
        self.assertEqual(settle_shadow_predictions(self.db)["challenger_metrics_repaired"], 0)
        with self.db.connect() as conn:
            after = dict(conn.execute("SELECT * FROM challenger_predictions WHERE shadow_prediction_id=?", (shadow_id,)).fetchone())
            revisions = conn.execute("SELECT * FROM challenger_settlement_revisions").fetchall()
        for field in ("created_at", "frozen_at", "feature_snapshot_id", "artifact_hash", "champion_probability", "challenger_probability", "resolved_at"):
            self.assertEqual(before[field], after[field])
        self.assertEqual(len(revisions), 1)
        self.assertIsNone(json.loads(revisions[0]["previous_json"])["actual_winner_id"])
        self.assertEqual(json.loads(revisions[0]["corrected_json"])["actual_winner_id"], "team-a")
        with self.assertRaises(Exception):
            with self.db.connect() as conn:
                conn.execute("DELETE FROM challenger_settlement_revisions")
        self.assertEqual(prospective_metrics(self.db)["metric_integrity"]["status"], "TRUSTED")

    def test_result_revision_repairs_metrics_without_new_prospective_sample(self) -> None:
        self._resolve_pair()
        settle_shadow_predictions(self.db)
        with self.db.connect() as conn:
            conn.execute("UPDATE predictions SET actual_winner_id='team-b',actual_score='0-2' WHERE prediction_id='champion-1'")
        self.assertEqual(prospective_metrics(self.db)["metric_integrity"]["status"], "DEGRADED")
        self.assertEqual(settle_shadow_predictions(self.db)["challenger_metrics_repaired"], 1)
        metrics = prospective_metrics(self.db)
        self.assertEqual(metrics["eligible_resolved_matches"], 1)
        self.assertEqual(metrics["metrics"]["champion"]["accuracy"], 0)

    def test_snapshot_observed_after_cycle_start_becomes_the_effective_cutoff(self) -> None:
        observed_at = "2026-09-03T12:00:05+00:00"
        with self.db.connect() as conn:
            conn.execute("DELETE FROM predictions WHERE prediction_id='champion-1'")
            conn.execute(
                "UPDATE fixtures SET prediction_id=NULL,quality_status='ready',map_pool_json=?,fetched_at=? WHERE fixture_id='fixture-1'",
                (json.dumps(list(MAPS)), observed_at),
            )
            conn.execute(
                "UPDATE prospective_snapshots SET observed_at=?,created_at=? WHERE snapshot_id='gold-1'",
                (observed_at, observed_at),
            )
        result = _lock_ready_predictions(
            self.db, datetime(2026, 9, 3, 12, tzinfo=timezone.utc), 48
        )
        self.assertEqual(result["predictions_locked"], 1, result)
        self.assertEqual(result["challenger_predictions_frozen"], 1, result)
        with self.db.connect() as conn:
            champion = conn.execute(
                "SELECT locked_at,factor_snapshot_json FROM predictions WHERE fixture_id='fixture-1'"
            ).fetchone()
            feature = conn.execute(
                "SELECT feature_cutoff_at,gold_snapshot_id FROM challenger_feature_snapshots WHERE fixture_id='fixture-1'"
            ).fetchone()
        context = json.loads(champion["factor_snapshot_json"])["prediction_context"]
        self.assertEqual(champion["locked_at"], observed_at)
        self.assertEqual(feature["feature_cutoff_at"], observed_at)
        self.assertEqual(context["gold_snapshot_id"], "gold-1")
        self.assertEqual(context["feature_cutoff_at"], observed_at)

    def test_incomplete_pair_retries_only_from_its_bound_gold_snapshot(self) -> None:
        context = {
            "prediction_context": {
                "gold_snapshot_id": "gold-1",
                "gold_snapshot_observed_at": "2026-09-03T00:00:00+00:00",
            }
        }
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE predictions SET factor_snapshot_json=? WHERE prediction_id='champion-1'",
                (json.dumps(context),),
            )
            conn.execute(
                "UPDATE fixtures SET prediction_id='champion-1',quality_status='locked' WHERE fixture_id='fixture-1'"
            )
        result = _lock_ready_predictions(
            self.db, datetime(2026, 9, 3, 13, tzinfo=timezone.utc), 48
        )
        self.assertEqual(result["predictions_locked"], 0, result)
        self.assertEqual(result["challenger_predictions_frozen"], 1, result)
        self.assertEqual(result["challenger_pairs_recovered"], 1, result)
        with self.db.connect() as conn:
            pair = conn.execute("SELECT * FROM prediction_pairs WHERE fixture_id='fixture-1'").fetchone()
            shadow = conn.execute("SELECT * FROM challenger_predictions WHERE fixture_id='fixture-1'").fetchone()
            feature = conn.execute("SELECT * FROM challenger_feature_snapshots WHERE fixture_id='fixture-1'").fetchone()
        self.assertEqual(pair["status"], "PAIRED")
        self.assertEqual(feature["gold_snapshot_id"], "gold-1")
        self.assertEqual(shadow["champion_prediction_id"], "champion-1")

    def test_missing_shadow_is_never_backfilled_after_scheduled_time_or_result(self) -> None:
        context = {"prediction_context": {"gold_snapshot_id": "gold-1"}}
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE predictions SET factor_snapshot_json=? WHERE prediction_id='champion-1'",
                (json.dumps(context),),
            )
            conn.execute(
                "UPDATE fixtures SET prediction_id='champion-1',quality_status='locked' WHERE fixture_id='fixture-1'"
            )
        after_start = _lock_ready_predictions(
            self.db, datetime(2026, 9, 4, 0, 0, 1, tzinfo=timezone.utc), 48
        )
        self.assertEqual(after_start["challenger_predictions_frozen"], 0)
        self.assertEqual(after_start["challenger_pairs_expired"], 1)
        with self.db.connect() as conn:
            pair = conn.execute("SELECT * FROM prediction_pairs WHERE fixture_id='fixture-1'").fetchone()
            shadow_count = conn.execute("SELECT COUNT(*) FROM challenger_predictions").fetchone()[0]
            conn.execute("UPDATE fixtures SET status='completed' WHERE fixture_id='fixture-1'")
        self.assertEqual(pair["status"], "C1_MISSING_PREMATCH_FREEZE")
        self.assertEqual(shadow_count, 0)
        after_result = _lock_ready_predictions(
            self.db, datetime(2026, 9, 4, 3, tzinfo=timezone.utc), 48
        )
        self.assertEqual(after_result["challenger_predictions_frozen"], 0)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM challenger_predictions").fetchone()[0], 0)

    def test_gold_snapshot_at_or_after_kickoff_cannot_lock_either_model(self) -> None:
        with self.db.connect() as conn:
            conn.execute("DELETE FROM predictions WHERE prediction_id='champion-1'")
            conn.execute(
                "UPDATE fixtures SET prediction_id=NULL,quality_status='ready',map_pool_json=? WHERE fixture_id='fixture-1'",
                (json.dumps(list(MAPS)),),
            )
            conn.execute(
                "UPDATE prospective_snapshots SET observed_at='2026-09-04T00:00:00+00:00' WHERE snapshot_id='gold-1'"
            )
        result = _lock_ready_predictions(
            self.db, datetime(2026, 9, 3, 12, tzinfo=timezone.utc), 48
        )
        self.assertEqual(result["predictions_locked"], 0, result)
        self.assertEqual(result["challenger_predictions_frozen"], 0, result)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM challenger_predictions").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
