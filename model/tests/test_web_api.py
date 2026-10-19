from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "backend"))

if not (ROOT / "web" / "backend" / "vct_web").is_dir():
    raise unittest.SkipTest("Local desktop API is outside this curated public export")

from fastapi.testclient import TestClient

from vct_prediction.db import Database
from vct_prediction.ingest import load_teams
from vct_web.app import app


class WebApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.db_path = self.base / "web.sqlite3"
        db = Database(self.db_path)
        db.initialize()
        teams_path = self.base / "teams.json"
        teams_path.write_text(json.dumps({"teams": [
            {"team_id": "a", "name": "A Team", "region": "CN"},
            {"team_id": "b", "name": "B Team", "region": "PACIFIC"},
        ]}), encoding="utf-8")
        load_teams(db, teams_path)
        os.environ["VCT_DB_PATH"] = str(self.db_path)
        self.client = TestClient(app)
        self.payload = {
            "team_a_id": "a",
            "team_b_id": "b",
            "scheduled_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            "event": "Web API Test",
            "region": "CN",
            "patch": "13.04",
            "series_format": "bo3",
            "map_pool": ["亚海悬城", "源工重镇", "隐世修所"],
            "known_maps": None,
            "is_international": True,
            "tactical_matchup_a": 0.0,
        }

    def tearDown(self) -> None:
        os.environ.pop("VCT_DB_PATH", None)
        self.temp.cleanup()

    def test_health_overview_and_model(self) -> None:
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.json()["ok"])
        self.assertIn("service_uptime_seconds", health.json())
        overview = self.client.get("/api/overview")
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.json()["counts"]["teams"], 2)
        model = self.client.get("/api/model")
        self.assertEqual(model.status_code, 200)
        self.assertIn("天枢云阙", [item["name"] for item in model.json()["maps"]])
        data_status = self.client.get("/api/data/status")
        self.assertEqual(data_status.status_code, 200, data_status.text)
        self.assertEqual(data_status.json()["summary"]["teams"], 2)
        self.assertIn("sample_out", data_status.json()["boundaries"])
        today = self.client.get("/api/today?hours=48")
        self.assertEqual(today.status_code, 200, today.text)
        self.assertEqual(today.json()["policy"]["mode"], "unattended")
        self.assertIn("health", today.json())
        reviews = self.client.get("/api/reviews")
        self.assertEqual(reviews.status_code, 200, reviews.text)
        self.assertEqual(reviews.json(), [])

    def test_preview_does_not_write_and_lock_does(self) -> None:
        preview = self.client.post("/api/predict/preview", json=self.payload)
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertAlmostEqual(preview.json()["team_a"]["win_probability"], 0.5)
        with Database(self.db_path).connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 0)

        locked = self.client.post("/api/predictions/lock", json=self.payload)
        self.assertEqual(locked.status_code, 200, locked.text)
        with Database(self.db_path).connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 1)
        detail = self.client.get(f"/api/predictions/{locked.json()['prediction_id']}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertTrue(detail.json()["explanation"]["available"])

    def test_prediction_explanation_reconciles_to_final_probability(self) -> None:
        payload = {**self.payload, "tactical_matchup_a": 0.4}
        response = self.client.post("/api/predict/preview", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        explanation = result["explanation"]
        self.assertEqual(explanation["method"], "exact_shapley_probability_points")
        self.assertAlmostEqual(explanation["final_probability_a"], result["team_a"]["win_probability"], places=6)
        self.assertAlmostEqual(
            sum(item["probability_points"] for item in explanation["contributions"]),
            explanation["total_shift_probability_points"],
            places=4,
        )
        self.assertAlmostEqual(
            sum(item["absolute_share"] for item in explanation["contributions"]),
            1.0,
            places=5,
        )
        tactical = next(item for item in explanation["contributions"] if item["key"] == "tactical_matchup")
        self.assertGreater(tactical["probability_points"], 0)

    def test_rejects_same_team(self) -> None:
        payload = {**self.payload, "team_b_id": "a"}
        response = self.client.post("/api/predict/preview", json=payload)
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
