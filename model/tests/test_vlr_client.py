from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vct_prediction.sources.vlr import VlrClient


class _SequenceClient:
    def __init__(self, values):
        self.values = list(values)

    def get(self, _url):
        value = self.values.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    def close(self):
        return None


class VlrRetryTests(unittest.TestCase):
    def test_transient_transport_failure_is_retried_and_logged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = VlrClient(directory, delay_seconds=0, retry_delays=(0, 0))
            client.client.close()
            request = client.httpx.Request("GET", "https://www.vlr.gg/test")
            response = client.httpx.Response(200, request=request, content=b"<html>ok</html>")
            client.client = _SequenceClient([
                client.httpx.ConnectTimeout("timeout", request=request),
                response,
            ])
            result = client.fetch("https://www.vlr.gg/test")
            self.assertEqual(result.text, "<html>ok</html>")
            self.assertEqual(client.retry_count, 1)
            self.assertEqual(client.retry_log[0]["error_type"], "ConnectTimeout")
            self.assertTrue(Path(result.raw_path).exists())
            client.close()


if __name__ == "__main__":
    unittest.main()
