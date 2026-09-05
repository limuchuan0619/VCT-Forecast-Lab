"""Time-ordered real-data calibration without future-result leakage."""

from __future__ import annotations

import copy
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .backtest import evaluate
from .constants import DEFAULT_CONFIG, SERIES_FORMATS
from .db import Database
from .ingest import record_match
from .predictor import predict_match
from .realdata import _team_regions
from .realdata import import_collection
from .history import import_prediction_archive


def _teams(collection: dict[str, Any]) -> dict[str, dict[str, str]]:
    regions = _team_regions(collection["matches"])
    teams: dict[str, dict[str, str]] = {}
    for record in collection["matches"]:
        for team in record["teams"]:
            teams[team["team_id"]] = {
                "team_id": team["team_id"],
                "name": team["name"],
                "region": regions.get(team["team_id"], "INTERNATIONAL"),
            }
    return teams


def rolling_evaluation(
    collection: dict[str, Any],
    config: dict[str, Any],
    *,
    evaluation_start: str,
    evaluation_end: str | None = None,
    work_root: str | Path | None = None,
) -> dict[str, Any]:
    work = Path(work_root) if work_root else Path(tempfile.gettempdir())
    work.mkdir(parents=True, exist_ok=True)
    temp = tempfile.NamedTemporaryFile(prefix="vct-calibration-", suffix=".sqlite3", dir=work, delete=False)
    temp.close()
    db_path = Path(temp.name)
    db = Database(db_path)
    try:
        db.initialize(config)
        now = datetime.now().astimezone().isoformat()
        with db.connect() as conn:
            for team in _teams(collection).values():
                conn.execute(
                    "INSERT INTO teams(team_id, name, region, updated_at) VALUES(?, ?, ?, ?)",
                    (team["team_id"], team["name"], team["region"], now),
                )
        predicted = 0
        skipped = 0
        evaluation_start_dt = datetime.fromisoformat(evaluation_start)
        evaluation_end_dt = datetime.fromisoformat(evaluation_end) if evaluation_end else None
        for record in sorted(collection["matches"], key=lambda item: (item["played_at"], item["match_id"])):
            played_at = record["played_at"]
            played_at_dt = datetime.fromisoformat(played_at)
            if evaluation_end_dt is not None and played_at_dt > evaluation_end_dt:
                break
            required = SERIES_FORMATS[record["series_format"]] * 2 - 1
            in_window = played_at_dt >= evaluation_start_dt and (evaluation_end_dt is None or played_at_dt <= evaluation_end_dt)
            if in_window and len(record.get("map_pool", [])) >= required:
                locked_at = (datetime.fromisoformat(played_at) - timedelta(seconds=1)).isoformat()
                try:
                    predict_match(
                        db,
                        team_a_id=record["team_a_id"],
                        team_b_id=record["team_b_id"],
                        scheduled_at=played_at,
                        event=record["event"],
                        region=record["region"],
                        patch=record.get("patch"),
                        series_format=record["series_format"],
                        map_pool=record["map_pool"],
                        is_international=bool(record.get("is_international")),
                        source="system_calibration",
                        locked_at=locked_at,
                        persist=True,
                    )
                    predicted += 1
                except ValueError:
                    skipped += 1
            clean_record = {
                key: value for key, value in record.items()
                if key not in {
                    "external_match_id", "event_id", "teams", "player_stats", "patch_provenance",
                    "fetched_at", "raw_path", "content_hash", "normalized_hash", "map_pool_provenance",
                }
            }
            record_match(db, clean_record, process=True)
        metrics = evaluate(db, "system_calibration")["overall"]
        return {"metrics": metrics, "predicted": predicted, "skipped": skipped}
    finally:
        try:
            db_path.unlink()
        except FileNotFoundError:
            pass


def calibrate_collection(
    collection: dict[str, Any],
    *,
    evaluation_start: str,
    evaluation_end: str | None = None,
    holdout_start: str | None = None,
    holdout_end: str | None = None,
    work_root: str | Path | None = None,
    progress=None,
) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_CONFIG)
    candidates = {
        "series_k": [25.0, 35.0, 45.0],
        "map_k": [18.0, 26.0, 34.0],
        "form_half_life_days": [30.0, 50.0, 70.0],
        "map_prior_matches": [5.0, 9.0, 13.0],
        "weights.recent_form": [0.45, 0.70, 0.90],
    }
    cache: dict[str, dict[str, Any]] = {}

    def run(config: dict[str, Any]) -> dict[str, Any]:
        key = json.dumps(config, sort_keys=True)
        if key not in cache:
            cache[key] = rolling_evaluation(
                collection,
                config,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                work_root=work_root,
            )
        return cache[key]

    default_result = run(base)
    best = copy.deepcopy(base)
    best_result = default_result
    trace: list[dict[str, Any]] = []
    for pass_index in range(1):
        improved = False
        for parameter, values in candidates.items():
            local_best = best
            local_result = best_result
            for value in values:
                trial = copy.deepcopy(best)
                if parameter.startswith("weights."):
                    trial["weights"][parameter.split(".", 1)[1]] = value
                else:
                    trial[parameter] = value
                result = run(trial)
                metric = result["metrics"]
                objective = (
                    float(metric["brier_score"]) + 0.05 * float(metric["log_loss"])
                    if metric["n"] else float("inf")
                )
                best_metric = local_result["metrics"]
                best_objective = (
                    float(best_metric["brier_score"]) + 0.05 * float(best_metric["log_loss"])
                    if best_metric["n"] else float("inf")
                )
                trace.append({
                    "pass": pass_index + 1,
                    "parameter": parameter,
                    "value": value,
                    "objective": round(objective, 8),
                    "metrics": metric,
                })
                if progress:
                    progress(trace[-1])
                if objective < best_objective - 1e-10:
                    local_best = trial
                    local_result = result
            if local_best is not best:
                improved = True
            best = copy.deepcopy(local_best)
            best_result = local_result
        if not improved:
            break
    holdout_result = (
        rolling_evaluation(
            collection,
            best,
            evaluation_start=holdout_start,
            evaluation_end=holdout_end,
            work_root=work_root,
        )
        if holdout_start else None
    )
    return {
        "evaluation_start": evaluation_start,
        "evaluation_end": evaluation_end,
        "objective": "Brier Score + 0.05 * Log Loss",
        "default_config": base,
        "default_result": default_result,
        "best_config": best,
        "best_result": best_result,
        "holdout_start": holdout_start,
        "holdout_end": holdout_end,
        "holdout_result": holdout_result,
        "evaluations": len(cache),
        "trace": trace,
    }


def freeze_database(
    target_path: str | Path,
    collection: dict[str, Any],
    calibration: dict[str, Any],
    *,
    archive_path: str | Path,
    snapshot_root: str | Path,
    model_version: str = "v1.0.0",
    training_cutoff: str,
    validation_start: str,
    validation_end: str,
) -> dict[str, Any]:
    target = Path(target_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(f"{target.stem}.staging-{datetime.now().strftime('%Y%m%dT%H%M%S')}{target.suffix}")
    backup = target.with_name(f"{target.stem}.pre-{model_version}-{datetime.now().strftime('%Y%m%dT%H%M%S')}{target.suffix}")
    config = calibration["best_config"]
    db = Database(staging)
    imported = import_collection(
        db,
        collection,
        snapshot_root=snapshot_root,
        config=config,
    )
    history = import_prediction_archive(db, archive_path)
    metrics = evaluate(db, "human_archive")
    data_checksum = collection.get("manifest_checksum") or hashlib_sha(collection["matches"])
    frozen_at = datetime.now().astimezone().isoformat()
    with db.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES('model_version', ?)",
            (model_version,),
        )
        conn.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES('frozen_at', ?)",
            (frozen_at,),
        )
        conn.execute(
            """INSERT INTO model_freezes(
                   model_version, frozen_at, training_cutoff, validation_start,
                   validation_end, config_json, data_checksum, metrics_json,
                   status, notes
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?)""",
            (
                model_version, frozen_at, training_cutoff, validation_start, validation_end,
                json.dumps(config, ensure_ascii=False, sort_keys=True), data_checksum,
                json.dumps({
                    "system_validation": calibration["best_result"],
                    "system_holdout": calibration.get("holdout_result"),
                    "system_default": calibration["default_result"],
                    "human_archive": metrics,
                }, ensure_ascii=False, sort_keys=True),
                "Frozen before Valorant Champions 2026; future Champions results are sample-out only.",
            ),
        )
    if target.exists():
        shutil.copy2(target, backup)
    os.replace(staging, target)
    return {
        "model_version": model_version,
        "database": str(target),
        "backup": str(backup) if backup.exists() else None,
        "frozen_at": frozen_at,
        "data_checksum": data_checksum,
        "import": imported,
        "history": history,
        "human_metrics": metrics,
        "system_tuning": calibration["best_result"],
        "system_holdout": calibration.get("holdout_result"),
    }


def hashlib_sha(value: Any) -> str:
    import hashlib
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
