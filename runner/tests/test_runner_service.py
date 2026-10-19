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
    def test_runtime_health_is_independent_of_evaluation_trust(self) -> None:
        config = {"database": Path("vct.sqlite3"), "raw_root": Path("raw"),
                  "horizon_hours": 48, "base_url": "https://example.test"}
        result = {"ok": True, "status": "completed", "errors": [],
                  "challenger_evaluation": {"metric_integrity": {"status": "DEGRADED", "invalid_pairs": 1}}}
        with patch.object(runner_service, "Database", return_value=object()), patch.object(
            runner_service, "run_daily_automation", return_value=result
        ), patch.object(runner_service, "run_bridge", return_value={"ok": True, "status": "SUCCESS"}):
            self.assertTrue(runner_service.run_cycle(config))
        self.assertEqual(runner_service.STATE["runtimeStatus"], "healthy")
        self.assertEqual(runner_service.STATE["evaluationIntegrity"]["status"], "DEGRADED")

    def test_runtime_status_cannot_remain_healthy_after_failure(self) -> None:
        runner_service.update_state(status="healthy")
        runner_service.update_state(status="failed")
        self.assertEqual(runner_service.STATE["runtimeStatus"], "failed")

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

    @unittest.skipUnless((Path(__file__).parents[1] / "seed" / "vct.sqlite3").is_file(), "Private production seed excluded from public export")
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

    def test_storage_diagnostics_reports_database_wal_and_raw_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "vct.sqlite3"
            database.write_bytes(b"db")
            Path(f"{database}-wal").write_bytes(b"wal")
            raw_root = root / "raw" / "vlr" / "daily"
            raw_root.mkdir(parents=True)
            (raw_root / "one.html").write_bytes(b"1234")
            (raw_root / "two.html").write_bytes(b"56789")

            diagnostics = runner_service.storage_diagnostics(database, raw_root)

            self.assertEqual(diagnostics["databaseBytes"], 2)
            self.assertEqual(diagnostics["databaseWalBytes"], 3)
            self.assertEqual(diagnostics["rawSnapshotBytes"], 9)
            self.assertEqual(diagnostics["rawSnapshotFiles"], 2)
            self.assertGreater(diagnostics["volumeFreeBytes"], 0)

    def test_prepare_raw_root_resets_only_ephemeral_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "persistent" / "vct.sqlite3"
            persistent_raw = database.parent / "raw"
            ephemeral_raw = root / "ephemeral" / "raw"
            persistent_raw.mkdir(parents=True)
            ephemeral_raw.mkdir(parents=True)
            (persistent_raw / "keep.html").write_text("keep", encoding="utf-8")
            (ephemeral_raw / "drop.html").write_text("drop", encoding="utf-8")

            self.assertFalse(runner_service.prepare_raw_root(database, persistent_raw))
            self.assertTrue((persistent_raw / "keep.html").exists())
            self.assertTrue(runner_service.prepare_raw_root(database, ephemeral_raw))
            self.assertFalse((ephemeral_raw / "drop.html").exists())
            self.assertTrue(ephemeral_raw.is_dir())

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

    def test_degraded_public_sync_never_reports_healthy(self) -> None:
        config = {
            "database": Path("vct.sqlite3"), "raw_root": Path("raw"),
            "horizon_hours": 48, "base_url": "https://example.test",
        }
        with patch.object(runner_service, "Database", return_value=object()), patch.object(
            runner_service, "run_daily_automation",
            return_value={"ok": True, "status": "completed", "run_id": "run-1", "errors": []},
        ), patch.object(
            runner_service, "run_bridge",
            return_value={"ok": False, "status": "DEGRADED", "syncRunId": "sync-1", "failures": [{"id": "p1"}]},
        ):
            self.assertFalse(runner_service.run_cycle(config))
        self.assertEqual(runner_service.STATE["status"], "degraded")
        self.assertEqual(runner_service.STATE["lastRun"]["publicSync"]["syncRunId"], "sync-1")


if __name__ == "__main__":
    unittest.main()
