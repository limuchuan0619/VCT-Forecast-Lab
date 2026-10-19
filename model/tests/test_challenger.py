from __future__ import annotations

import json
import hashlib
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vct_prediction.challenger import (  # noqa: E402
    BASE_FEATURES,
    TrainPreprocessor,
    assign_chronological_splits,
    build_historical_dataset,
    champion_v1_replay_probability,
    fit_logistic,
    probability_metrics,
    select_eligible_matches,
    simple_elo_probabilities,
)
from vct_prediction.replay import open_read_only  # noqa: E402


DB_PATH = ROOT / "data" / "vct.sqlite3"
ARTIFACT_ROOT = ROOT / "artifacts" / "v1_4b_c1_20260903"


def synthetic_row(index: int, *, missing_adr: bool = False, imputed_kast: bool = False) -> dict:
    values = {feature: float(index + feature_index) for feature_index, feature in enumerate(BASE_FEATURES)}
    statuses = {feature: "observed" for feature in BASE_FEATURES}
    if missing_adr:
        values["adr_diff"] = None
        statuses["adr_diff"] = "feature_unavailable"
    if imputed_kast:
        statuses["kast_diff"] = "imputed_team_mean"
    return {
        "match_id": f"m{index:03d}",
        "played_at": f"2026-01-{index + 1:02d}T00:00:00+00:00",
        "target_a_win": index % 2,
        "features": values,
        "feature_status": statuses,
        "imputation_indicators": {
            feature: int(status == "imputed_team_mean") for feature, status in statuses.items()
        },
        "unavailable_indicators": {
            feature: int(status == "feature_unavailable") for feature, status in statuses.items()
        },
    }


class ChallengerMathTests(unittest.TestCase):
    def test_preprocessor_uses_train_mean_and_explicit_indicators(self) -> None:
        rows = [synthetic_row(index) for index in range(8)]
        rows[2] = synthetic_row(2, missing_adr=True)
        rows[4] = synthetic_row(4, imputed_kast=True)
        preprocessor = TrainPreprocessor.fit(rows)
        observed_adr = [row["features"]["adr_diff"] for row in rows if row["features"]["adr_diff"] is not None]
        expected_mean = sum(observed_adr) / len(observed_adr)
        self.assertAlmostEqual(preprocessor.feature_imputation["adr_diff"], expected_mean)
        self.assertIn("adr_diff__unavailable", preprocessor.columns)
        self.assertIn("kast_diff__imputed", preprocessor.columns)
        transformed = preprocessor.transform([rows[2]])[0]
        adr_index = preprocessor.columns.index("adr_diff")
        self.assertAlmostEqual(transformed[adr_index], 0.0)
        self.assertNotEqual(expected_mean, 0.0)

    def test_logistic_finds_expected_direction(self) -> None:
        matrix = [[-2.0], [-1.5], [-1.0], [1.0], [1.5], [2.0]]
        labels = [0, 0, 0, 1, 1, 1]
        model = fit_logistic(matrix, labels, l2_strength=0.1)
        self.assertTrue(model.converged)
        self.assertGreater(model.coefficients[0], 0)
        probabilities = model.predict([[-1.0], [1.0]])
        self.assertLess(probabilities[0], 0.5)
        self.assertGreater(probabilities[1], 0.5)

    def test_metrics_include_calibration_and_probability_distribution(self) -> None:
        metrics = probability_metrics([0, 0, 1, 1], [0.1, 0.4, 0.6, 0.9])
        self.assertAlmostEqual(metrics["accuracy"], 1.0)
        self.assertIn("ece_10_bin", metrics)
        self.assertEqual(metrics["probability_distribution"]["high_confidence_count"], 2)

    def test_simple_elo_batches_equal_time_matches(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            """CREATE TABLE matches(
                   match_id TEXT,played_at TEXT,team_a_id TEXT,team_b_id TEXT,winner_id TEXT
               )"""
        )
        connection.executemany(
            "INSERT INTO matches VALUES(?,?,?,?,?)",
            [
                ("m1", "2026-01-01T00:00:00+00:00", "A", "B", "A"),
                ("m2", "2026-01-01T00:00:00+00:00", "B", "C", "B"),
                ("m3", "2026-01-02T00:00:00+00:00", "A", "C", "A"),
            ],
        )
        probabilities = simple_elo_probabilities(connection, ["m1", "m2", "m3"])
        connection.close()
        self.assertAlmostEqual(probabilities["m1"], 0.5)
        self.assertAlmostEqual(probabilities["m2"], 0.5)
        self.assertGreater(probabilities["m3"], 0.5)


@unittest.skipUnless(DB_PATH.exists(), "formal historical database is unavailable")
class ChallengerReplayIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = json.loads((ROOT / "config" / "default.json").read_text(encoding="utf-8"))
        cls.connection = open_read_only(DB_PATH)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.connection.close()

    def test_eligible_selector_is_result_independent_and_bounded(self) -> None:
        selected, raw_count, eligible_count = select_eligible_matches(self.connection, limit=1000)
        # The formal database is append-only and continues to grow after the
        # V1.4B evaluation freeze.  Guard the frozen historical prefix instead
        # of treating healthy prospective accumulation as a regression.
        self.assertGreaterEqual(raw_count, 1512)
        self.assertGreaterEqual(eligible_count, 1285)
        self.assertEqual(len(selected), 1000)
        selected_times = [row["played_at"] for row in selected]
        self.assertEqual(selected_times, sorted(selected_times))
        self.assertLess(selected_times[0], selected_times[-1])

    def test_small_dataset_preserves_statuses_and_strict_cutoff(self) -> None:
        rows, _ = build_historical_dataset(self.connection, self.config, limit=30)
        split = assign_chronological_splits(rows)
        self.assertEqual(sum(split[name] for name in ("train", "validation", "test")), 30)
        for row in rows:
            self.assertLess(row["replay_audit"]["max_source_match_time"], row["played_at"])
            self.assertEqual(set(row["features"]), set(BASE_FEATURES))
            self.assertTrue(set(row["feature_status"].values()) <= {
                "observed", "imputed_team_mean", "feature_unavailable"
            })
            if row["feature_status"]["adr_diff"] == "feature_unavailable":
                self.assertIsNone(row["features"]["adr_diff"])

    def test_champion_replay_proxy_is_a_probability(self) -> None:
        rows, _ = build_historical_dataset(self.connection, self.config, limit=1)
        probability = champion_v1_replay_probability(rows[0], self.config)
        self.assertGreater(probability, 0.0)
        self.assertLess(probability, 1.0)


@unittest.skipUnless((ARTIFACT_ROOT / "evaluation.json").exists(), "frozen V1.4B artifacts are unavailable")
class FrozenChallengerArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((ARTIFACT_ROOT / "manifest.json").read_text(encoding="utf-8"))
        cls.evaluation = json.loads((ARTIFACT_ROOT / "evaluation.json").read_text(encoding="utf-8"))
        cls.dataset_bytes = (ARTIFACT_ROOT / "dataset.jsonl").read_bytes()
        cls.rows = [json.loads(line) for line in cls.dataset_bytes.decode("utf-8").splitlines()]

    def test_dataset_hash_and_splits_are_frozen(self) -> None:
        self.assertEqual(hashlib.sha256(self.dataset_bytes).hexdigest(), self.manifest["dataset_sha256"])
        self.assertEqual(len(self.rows), 1000)
        self.assertEqual(sum(row["split"] == "train" for row in self.rows), 650)
        self.assertEqual(sum(row["split"] == "validation" for row in self.rows), 150)
        self.assertEqual(sum(row["split"] == "test" for row in self.rows), 200)

    def test_all_frozen_rows_pass_temporal_and_forbidden_input_checks(self) -> None:
        for row in self.rows:
            self.assertLess(row["replay_audit"]["max_source_match_time"], row["played_at"])
            self.assertFalse(row["replay_audit"]["current_team_state_used"])
            self.assertFalse(row["replay_audit"]["current_team_map_rating_used"])
            self.assertFalse(row["replay_audit"]["target_map_or_veto_used"])

    def test_evaluation_is_one_time_and_poison_validated(self) -> None:
        self.assertTrue(self.evaluation["test_evaluated_once_after_protocol_freeze"])
        self.assertTrue(self.manifest["poison_future_test"]["passed"])
        self.assertEqual(len(self.manifest["poison_future_test"]["tested_match_ids"]), 20)
        self.assertEqual({metrics["n"] for metrics in self.evaluation["test_metrics"].values()}, {200})
        self.assertIn(self.evaluation["verdict"], {
            "CHALLENGER_HISTORICALLY_BETTER", "CHALLENGER_NOT_BETTER", "INCONCLUSIVE"
        })


if __name__ == "__main__":
    unittest.main()
