from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from bridge.vct_public_bridge import automation_run_payload, automation_schedule_payload, post_json


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


if __name__ == "__main__":
    unittest.main()
