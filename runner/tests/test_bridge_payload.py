from __future__ import annotations

import unittest
import sqlite3
import shutil
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from bridge.vct_public_bridge import automation_run_payload, automation_schedule_payload, iso, post_json, resolved_payload, rows_from_database, synchronize
from vct_prediction.db import Database


SEED = Path(__file__).parents[1] / "seed" / "vct.sqlite3"


class BridgePayloadTests(unittest.TestCase):
    def test_automation_schedule_payload_reports_cloud_interval(self) -> None:
        with patch.dict(
            "os.environ",
            {"VCT_RUN_INTERVAL_SECONDS": "7200", "VCT_HORIZON_HOURS": "48"},
            clear=False,
        ):
            payload = automation_schedule_payload()

        self.assertEqual(payload["intervalSeconds"], 7200)
        self.assertEqual(payload["horizonHours"], 48)
        self.assertEqual(payload["executionEnvironment"], "cloud")

    def test_automation_run_payload_is_structured_and_bounded(self) -> None:
        payload = automation_run_payload({
            "run_id": "run-1",
            "run_type": "daily_vct_pipeline",
            "status": "completed",
            "started_at": "2026-09-02T07:00:00+00:00",
            "completed_at": "2026-09-02T07:00:25+00:00",
            "counters_json": '{"predictions_locked": 1}',
            "error": "x" * 800,
        })

        self.assertEqual(payload["id"], "run-1")
        self.assertEqual(payload["counters"], {"predictions_locked": 1})
        self.assertEqual(payload["startedAt"], "2026-09-02T07:00:00.000Z")
        self.assertEqual(len(payload["errorCode"]), 512)

    def test_automation_run_payload_accepts_missing_row(self) -> None:
        self.assertIsNone(automation_run_payload(None))

    def test_post_json_uses_explicit_ai_timeout(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"ok":true}'

        with patch("bridge.vct_public_bridge.urlopen", return_value=response) as mocked_open:
            result = post_json(
                "https://example.test",
                "/api/automation/predictions",
                "secret",
                {"prediction": {"id": "prediction-1"}},
                timeout_seconds=240,
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(mocked_open.call_args.kwargs["timeout"], 240)

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_partial_sync_continues_and_finalizes_one_degraded_run(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        calls: list[tuple[str, dict]] = []
        failed_once = False

        def poster(_base, path, _key, payload, **_kwargs):
            nonlocal failed_once
            calls.append((path, payload))
            if path == "/api/automation/results" and not failed_once:
                failed_once = True
                raise RuntimeError("synthetic_row_failure")
            return {"accepted": True}

        result = synchronize(
            connection, base_url="https://example.test", key="secret", source="system",
            limit=None, ai_timeout=240, poster=poster, sync_run_id="sync-test-1",
        )
        connection.close()
        temporary.cleanup()

        self.assertEqual(result["status"], "DEGRADED")
        self.assertGreater(result["counters"]["results"]["attempted"], 0)
        self.assertEqual(result["counters"]["results"]["failed"], 1)
        self.assertEqual(result["counters"]["state"]["succeeded"], 1)
        self.assertEqual(calls[0][0], "/api/automation/sync-runs")
        self.assertEqual(calls[0][1]["status"], "RUNNING")
        self.assertEqual(calls[-1][0], "/api/automation/sync-runs")
        self.assertEqual(calls[-1][1]["status"], "DEGRADED")
        payload_ids = {payload.get("syncRunId") for _, payload in calls}
        self.assertEqual(payload_ids, {"sync-test-1"})

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_transport_retry_resends_rows_without_creating_predictions(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        calls: list[tuple[str, dict]] = []

        def poster(_base, path, _key, payload, **_kwargs):
            calls.append((path, payload))
            return {"accepted": True}

        first = synchronize(connection, base_url="https://example.test", key="secret", source="system", limit=2,
                            ai_timeout=240, poster=poster, sync_run_id="sync-retry-1")
        second = synchronize(connection, base_url="https://example.test", key="secret", source="system", limit=2,
                             ai_timeout=240, poster=poster, sync_run_id="sync-retry-2")
        connection.close()
        temporary.cleanup()
        self.assertEqual(first["status"], "SUCCESS")
        self.assertEqual(second["status"], "SUCCESS")
        self.assertEqual(first["predictions"], second["predictions"])
        self.assertEqual(first["results"], second["results"])

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_result_uses_observation_time_and_explicit_missing_evidence(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        resolved = next(row for row in rows_from_database(connection, "system", None) if row["status"] == "resolved")
        payload = resolved_payload(connection, resolved)
        connection.close()
        temporary.cleanup()
        self.assertIsNotNone(payload)
        self.assertGreaterEqual(payload["resolvedAt"], payload["resultEvidence"]["series"]["scheduledAt"])
        self.assertEqual(payload["resolvedAt"], iso(resolved["result_inserted_at"]))
        self.assertEqual(payload["resultEvidence"]["schemaVersion"], "v1.4c-r1-result-evidence-v1")
        self.assertEqual(payload["resultEvidence"]["missing"]["playerStats"], payload["resultEvidence"]["playerStats"] is None)
        self.assertTrue(payload["resultEvidence"]["missing"]["attackDefense"])

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_partial_legacy_map_is_not_redelivered_as_final_evidence(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(database)
        connection.row_factory = sqlite3.Row
        resolved = next(row for row in rows_from_database(connection, "system", None) if row["status"] == "resolved")
        connection.execute(
            "UPDATE map_results SET team_a_rounds=5,team_b_rounds=11 WHERE match_id=? AND map_order=(SELECT MAX(map_order) FROM map_results WHERE match_id=?)",
            (resolved["resolved_match_id"], resolved["resolved_match_id"]),
        )
        connection.commit()

        payload = resolved_payload(connection, resolved)

        connection.close()
        temporary.cleanup()
        self.assertIsNone(payload)

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_terminal_maps_must_reconstruct_series_score(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(database)
        connection.row_factory = sqlite3.Row
        resolved = next(row for row in rows_from_database(connection, "system", None) if row["status"] == "resolved")
        last = connection.execute(
            "SELECT map_order,team_a_rounds,team_b_rounds FROM map_results WHERE match_id=? ORDER BY map_order DESC LIMIT 1",
            (resolved["resolved_match_id"],),
        ).fetchone()
        connection.execute(
            "UPDATE map_results SET team_a_rounds=?,team_b_rounds=? WHERE match_id=? AND map_order=?",
            (last["team_b_rounds"], last["team_a_rounds"], resolved["resolved_match_id"], last["map_order"]),
        )
        connection.commit()
        self.assertIsNone(resolved_payload(connection, resolved))
        connection.close()
        temporary.cleanup()

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_result_conflict_uses_versioned_correction_endpoint(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        calls: list[tuple[str, dict]] = []
        conflicted = False

        def poster(_base, path, _key, payload, **_kwargs):
            nonlocal conflicted
            calls.append((path, payload))
            if path == "/api/automation/results" and not conflicted:
                conflicted = True
                raise RuntimeError('HTTP 409 /api/automation/results: {"error":"result_conflict"}')
            return {"accepted": True}

        result = synchronize(
            connection, base_url="https://example.test", key="secret", source="system",
            limit=None, ai_timeout=240, poster=poster, sync_run_id="sync-correction",
        )
        connection.close()
        temporary.cleanup()
        correction = next(payload for path, payload in calls if path == "/api/automation/result-corrections")
        self.assertEqual(correction["reason"], "SOURCE_PAGE_STABILIZED_AFTER_PREMATURE_CAPTURE")
        self.assertEqual(result["counters"]["results"]["failed"], 0)

    @unittest.skipUnless(SEED.is_file(), "Private production seed excluded from public export")
    def test_postmatch_ai_jobs_run_in_three_bounded_batches_before_state(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        database = Path(temporary.name) / "vct.sqlite3"
        shutil.copy2(SEED, database)
        Database(database).initialize()
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        calls: list[tuple[str, dict, int]] = []

        def poster(_base, path, _key, payload, **kwargs):
            calls.append((path, payload, kwargs.get("timeout_seconds", 30)))
            return {"accepted": True}

        synchronize(
            connection, base_url="https://example.test", key="secret", source="system",
            limit=1, ai_timeout=240, poster=poster, sync_run_id="sync-ai-batches",
        )
        connection.close()
        temporary.cleanup()
        ai_calls = [item for item in calls if item[0] == "/api/automation/ai/jobs"]
        self.assertEqual(len(ai_calls), 3)
        self.assertTrue(all(item[1]["limit"] == 3 for item in ai_calls))
        self.assertTrue(all(item[1]["syncRunId"] == "sync-ai-batches" for item in ai_calls))
        self.assertTrue(all(item[2] == 240 for item in ai_calls))
        self.assertLess(
            max(index for index, item in enumerate(calls) if item[0] == "/api/automation/ai/jobs"),
            next(index for index, item in enumerate(calls) if item[0] == "/api/automation/state"),
        )


if __name__ == "__main__":
    unittest.main()
