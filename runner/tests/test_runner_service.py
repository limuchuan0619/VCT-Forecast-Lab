from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from urllib.request import urlopen
from unittest.mock import patch

import runner_service


class RunnerServiceTests(unittest.TestCase):
    def test_settings_require_secret(self) -> None:
        with patch.dict(
            os.environ,
            {"VCT_PUBLIC_BASE_URL": "https://example.test"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "VCT_AUTOMATION_KEY is required"):
                runner_service.settings()

    def test_settings_reject_insecure_public_url(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VCT_PUBLIC_BASE_URL": "http://example.test",
                "VCT_AUTOMATION_KEY": "test-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must be an https URL"):
                runner_service.settings()

    @unittest.skipUnless(
        (Path(__file__).parents[1] / "seed" / "vct.sqlite3").exists(),
        "production seed database is intentionally excluded from the portfolio",
    )
    def test_seed_database_is_copied_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "nested" / "vct.sqlite3"
            runner_service.ensure_database(database)
            first_size = database.stat().st_size
            database.write_bytes(b"persistent-state")
            runner_service.ensure_database(database)
            self.assertEqual(database.read_bytes(), b"persistent-state")
            self.assertGreater(first_size, 1_000_000)

    def test_health_endpoint_exposes_state_without_secret(self) -> None:
        server = runner_service.serve_health(0)
        try:
            port = server.server_address[1]
            with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                payload = json.load(response)
            self.assertIn("status", payload)
            self.assertNotIn("VCT_AUTOMATION_KEY", json.dumps(payload))
        finally:
            server.shutdown()
            server.server_close()

    def test_cycle_runs_model_then_public_sync(self) -> None:
        calls: list[str] = []
        config = {
            "database": Path("vct.sqlite3"),
            "raw_root": Path("raw"),
            "horizon_hours": 48,
            "base_url": "https://example.test",
        }

        def fake_model(*_args, **_kwargs):
            calls.append("model")
            return {"ok": True, "status": "completed", "run_id": "run-1", "errors": []}

        def fake_bridge(*_args, **_kwargs):
            calls.append("public-sync")
            return {"ok": True, "predictions": 15, "results": 15}

        with patch.object(runner_service, "Database", return_value=object()), patch.object(
            runner_service, "run_daily_automation", side_effect=fake_model
        ), patch.object(runner_service, "run_bridge", side_effect=fake_bridge):
            self.assertTrue(runner_service.run_cycle(config))

        self.assertEqual(calls, ["model", "public-sync"])
        self.assertEqual(runner_service.STATE["status"], "healthy")
        self.assertEqual(runner_service.STATE["lastRun"]["publicSync"]["results"], 15)

    def test_public_bridge_syncs_only_system_predictions(self) -> None:
        completed = type("Completed", (), {"returncode": 0, "stdout": '{"ok":true}', "stderr": ""})()
        with patch.object(runner_service.subprocess, "run", return_value=completed) as run:
            runner_service.run_bridge(Path("vct.sqlite3"), "https://example.test")
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--source") + 1], "system")


if __name__ == "__main__":
    unittest.main()
