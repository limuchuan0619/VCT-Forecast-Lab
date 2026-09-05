"""Long-running cloud scheduler for the VCT mathematical prediction engine."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from vct_prediction.automation import run_daily_automation
from vct_prediction.db import Database


STOP = threading.Event()
STATE_LOCK = threading.Lock()
STATE: dict[str, Any] = {
    "status": "starting",
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "lastRun": None,
    "nextRunAt": None,
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def positive_int(name: str, default: int, minimum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def settings() -> dict[str, Any]:
    base_url = os.getenv("VCT_PUBLIC_BASE_URL", "").rstrip("/")
    if not base_url.startswith("https://"):
        raise RuntimeError("VCT_PUBLIC_BASE_URL must be an https URL")
    if not os.getenv("VCT_AUTOMATION_KEY"):
        raise RuntimeError("VCT_AUTOMATION_KEY is required")
    return {
        "base_url": base_url,
        "database": Path(os.getenv("VCT_DB_PATH", "/data/vct.sqlite3")),
        "raw_root": Path(os.getenv("VCT_RAW_ROOT", "/data/raw/vlr/daily")),
        "interval": positive_int("VCT_RUN_INTERVAL_SECONDS", 7200, 900),
        "failure_retry": positive_int("VCT_FAILURE_RETRY_SECONDS", 900, 300),
        "horizon_hours": positive_int("VCT_HORIZON_HOURS", 48, 1),
        "port": positive_int("PORT", 8080, 1),
    }


def ensure_database(database: Path) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    if database.exists():
        return
    seed = Path(__file__).resolve().parent / "seed" / "vct.sqlite3"
    if not seed.is_file():
        raise RuntimeError("seed database missing")
    temporary = database.with_suffix(".initializing")
    shutil.copy2(seed, temporary)
    temporary.replace(database)


def update_state(**values: Any) -> None:
    with STATE_LOCK:
        STATE.update(values)


def run_bridge(database: Path, base_url: str) -> dict[str, Any]:
    command = [
        sys.executable,
        str(Path(__file__).resolve().parent / "bridge" / "vct_public_bridge.py"),
        "--database", str(database),
        "--base-url", base_url,
        "--source", "system",
    ]
    completed = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8", timeout=1200)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or f"bridge exit {completed.returncode}"
        raise RuntimeError(message[-2000:])
    return json.loads(completed.stdout)


def run_cycle(config: dict[str, Any]) -> bool:
    started_at = now()
    update_state(status="running", lastRun={"startedAt": started_at, "status": "running"})
    try:
        database = Database(config["database"])
        result = run_daily_automation(
            database,
            config["raw_root"],
            horizon_hours=config["horizon_hours"],
            trigger_type="scheduled_task",
        )
        sync = run_bridge(config["database"], config["base_url"])
        completed_at = now()
        success = bool(result.get("ok"))
        update_state(
            status="healthy" if success else "degraded",
            lastRun={
                "startedAt": started_at,
                "completedAt": completed_at,
                "status": result.get("status", "unknown"),
                "runId": result.get("run_id"),
                "counters": {key: value for key, value in result.items() if key not in {"errors"}},
                "errors": result.get("errors", []),
                "publicSync": sync,
            },
        )
        print(json.dumps({"event": "cycle_complete", "at": completed_at, "result": result, "sync": sync}, ensure_ascii=False), flush=True)
        return success
    except Exception as error:
        failed_at = now()
        update_state(status="failed", lastRun={"startedAt": started_at, "completedAt": failed_at, "status": "failed", "error": str(error)})
        print(json.dumps({"event": "cycle_failed", "at": failed_at, "error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return False


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/", "/healthz"}:
            self.send_error(404)
            return
        with STATE_LOCK:
            payload = json.dumps(STATE, ensure_ascii=False).encode("utf-8")
            status = 200 if STATE.get("status") not in {"failed"} else 503
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format_string: str, *args: Any) -> None:
        return


def serve_health(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    threading.Thread(target=server.serve_forever, name="health-server", daemon=True).start()
    return server


def stop(_signal_number: int, _frame: Any) -> None:
    STOP.set()


def main() -> int:
    config = settings()
    ensure_database(config["database"])
    server = serve_health(config["port"])
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    update_state(status="ready")
    try:
        while not STOP.is_set():
            success = run_cycle(config)
            delay = config["interval"] if success else config["failure_retry"]
            next_run = datetime.fromtimestamp(time.time() + delay, tz=timezone.utc).isoformat()
            update_state(nextRunAt=next_run)
            STOP.wait(delay)
    finally:
        update_state(status="stopping")
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
