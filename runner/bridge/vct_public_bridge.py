"""Read-only bridge from the VCT V1 SQLite model to the public Sites API.

The source database is never modified. Authentication is read from an environment
variable so the ingestion key is not stored in arguments, source, or logs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MAP_NAMES = {
    "abyss": "幽邃地窟",
    "ascent": "升天之境",
    "bind": "源工重镇",
    "breeze": "微风岛屿",
    "corrode": "盐海矿镇",
    "fracture": "裂变峡谷",
    "haven": "隐世修所",
    "icebox": "森寒冬港",
    "lotus": "莲华古城",
    "pearl": "深海明珠",
    "split": "霓虹町",
    "sunset": "日落之城",
}

FACTOR_LABELS = {
    "team_rating": "动态实力 Rating",
    "map_pool": "地图池与 BP",
    "recent_form": "近期状态",
    "player_form": "选手状态",
    "roster_continuity": "阵容连续性",
    "patch_fit": "Patch 适应",
    "international_experience": "国际赛经验",
    "series_adaptability": "系列赛适应",
    "tactical_matchup": "战术对位",
}


def iso(value: str | None) -> str | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def factor_detail(item: dict[str, Any]) -> str:
    left = item.get("team_a_value")
    right = item.get("team_b_value")
    unit = item.get("unit") or ""
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return f"A {left:.3f} / B {right:.3f} · {unit}".rstrip(" ·")
    return "赛前锁定的精确 Shapley 贡献"


def factors(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    explanation = snapshot.get("explanation") if isinstance(snapshot, dict) else None
    contributions = explanation.get("contributions", []) if isinstance(explanation, dict) else []
    result = []
    for item in contributions:
        key = str(item.get("key") or "")
        points = item.get("probability_points")
        share = item.get("absolute_share")
        if not key or not isinstance(points, (int, float)) or not isinstance(share, (int, float)):
            continue
        result.append({
            "key": key,
            "rank": int(item.get("rank") or len(result) + 1),
            "label": FACTOR_LABELS.get(key, key.replace("_", " ").title()),
            "detail": factor_detail(item),
            "probabilityPoints": float(points),
            "absoluteShare": float(share),
        })
    return sorted(result, key=lambda item: item["rank"])


def maps(value: str | None) -> list[dict[str, Any]]:
    result = []
    for item in load_json(value, []):
        map_id = str(item.get("map_id") or "").lower()
        raw_name = str(item.get("map") or "")
        name = MAP_NAMES.get(map_id) or (raw_name if "�" not in raw_name else map_id)
        probability_a = float(item.get("team_a_probability", 0.5))
        samples = item.get("samples")
        result.append({
            "map": name,
            "teamAProbability": probability_a,
            "teamBProbability": 1.0 - probability_a,
            **({"samples": [int(samples[0]), int(samples[1])]} if isinstance(samples, list) and len(samples) == 2 else {}),
        })
    return result


def prediction_payload(row: sqlite3.Row) -> dict[str, Any]:
    snapshot = load_json(row["factor_snapshot_json"], {})
    context = snapshot.get("prediction_context", {}) if isinstance(snapshot, dict) else {}
    source_url = context.get("source_url") or row["result_source_url"]
    locked_at = iso(row["locked_at"])
    source_snapshot_at = iso(context.get("source_fetched_at"))
    data_cutoff_at = locked_at
    temporal_note = None
    if source_snapshot_at and locked_at and source_snapshot_at <= locked_at:
        data_cutoff_at = source_snapshot_at
    elif source_snapshot_at:
        temporal_note = "source_snapshot_timestamp_after_lock_using_lock_as_cutoff"
    return {
        "id": row["prediction_id"],
        "source": row["source"],
        "modelVersion": row["model_version"],
        "lockedAt": locked_at,
        "scheduledAt": iso(row["scheduled_at"]),
        "event": row["event"],
        "region": row["region"],
        "patch": row["patch"],
        "seriesFormat": row["series_format"],
        "teamA": row["team_a_name"],
        "teamB": row["team_b_name"],
        "teamAProbability": float(row["team_a_win_probability"]),
        "predictedScore": row["predicted_score"],
        "status": "locked",
        "actualWinner": None,
        "actualScore": None,
        "resolvedAt": None,
        "dataCutoffAt": data_cutoff_at,
        "factors": factors(snapshot),
        "maps": maps(row["map_probabilities_json"]),
        "scoreDistribution": load_json(row["score_distribution_json"], {}),
        "evidence": {
            **({"sourceUrl": source_url} if source_url else {}),
            "sourceLabel": "VLR 社区赛事页" if source_url else "历史赛前预测档案",
            "patchProvenance": context.get("patch_provenance") or "历史记录未保存精确 Patch 来源",
            "qualityGate": context.get("quality_gate") or ("ready" if row["source"].startswith("system") else "historical_human_archive"),
            **({"sourceSnapshotAt": source_snapshot_at} if source_snapshot_at else {}),
            **({"temporalNote": temporal_note} if temporal_note else {}),
        },
    }


def resolved_payload(row: sqlite3.Row) -> dict[str, Any] | None:
    if row["status"] != "resolved" or not row["actual_winner_name"] or not row["actual_score"]:
        return None
    return {
        "predictionId": row["prediction_id"],
        "actualWinner": row["actual_winner_name"],
        "actualScore": row["actual_score"],
        "resolvedAt": iso(row["result_played_at"] or row["scheduled_at"]),
    }


def challenger_rows_from_database(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "challenger_predictions" not in tables:
        return []
    return list(connection.execute(
        """SELECT c.*,s.content_hash feature_snapshot_hash,s.feature_json,s.feature_status_json,s.evidence_json,
                  aw.name actual_winner_name
           FROM challenger_predictions c JOIN challenger_feature_snapshots s ON s.snapshot_id=c.feature_snapshot_id
           LEFT JOIN teams aw ON aw.team_id=c.actual_winner_id
           ORDER BY datetime(c.scheduled_at),c.shadow_prediction_id"""
    ))


def challenger_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["shadow_prediction_id"], "fixtureId": row["fixture_id"], "championPredictionId": row["champion_prediction_id"],
        "featureSnapshotId": row["feature_snapshot_id"], "featureSnapshotHash": row["feature_snapshot_hash"],
        "features": load_json(row["feature_json"], {}), "featureStatus": load_json(row["feature_status_json"], {}),
        "evidence": load_json(row["evidence_json"], {}), "frozenAt": iso(row["frozen_at"]), "scheduledAt": iso(row["scheduled_at"]),
        "championModelVersion": row["champion_model_version"], "championProbability": float(row["champion_probability"]),
        "challengerModelId": row["challenger_model_id"], "datasetVersion": row["dataset_version"], "artifactHash": row["artifact_hash"],
        "challengerProbability": float(row["challenger_probability"]), "probabilityDelta": float(row["probability_delta"]),
        "dataQualityState": row["data_quality_state"], "recordKind": row["record_kind"], "eligible": bool(row["eligible"]),
        "status": row["status"], "actualWinner": row["actual_winner_name"], "resolvedAt": iso(row["resolved_at"]),
        "championBrier": row["champion_brier"], "challengerBrier": row["challenger_brier"],
        "championLogLoss": row["champion_log_loss"], "challengerLogLoss": row["challenger_log_loss"],
        "championCorrect": None if row["champion_correct"] is None else bool(row["champion_correct"]),
        "challengerCorrect": None if row["challenger_correct"] is None else bool(row["challenger_correct"]),
    }


def metrics(rows: Iterable[sqlite3.Row]) -> dict[str, Any]:
    groups: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for row in rows:
        if row["status"] != "resolved" or not row["actual_winner_id"]:
            continue
        group = "system" if row["source"].startswith("system") else "human" if row["source"].startswith("human") else row["source"]
        groups[group].append((float(row["team_a_win_probability"]), int(row["actual_winner_id"] == row["team_a_id"])))
    result: dict[str, Any] = {}
    for name, values in groups.items():
        accuracy = sum(int((probability >= 0.5) == bool(actual)) for probability, actual in values) / len(values)
        brier = sum((probability - actual) ** 2 for probability, actual in values) / len(values)
        log_loss = -sum(actual * math.log(max(probability, 1e-15)) + (1 - actual) * math.log(max(1 - probability, 1e-15)) for probability, actual in values) / len(values)
        result[name] = {"samples": len(values), "accuracy": accuracy, "brierScore": brier, "logLoss": log_loss}
    return result


def automation_run_payload(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    error = row["error"]
    return {
        "id": str(row["run_id"]),
        "runType": str(row["run_type"]),
        "status": str(row["status"]),
        "startedAt": iso(row["started_at"]),
        "completedAt": iso(row["completed_at"]),
        "counters": load_json(row["counters_json"], {}),
        "errorCode": str(error)[:512] if error else None,
    }


def automation_schedule_payload() -> dict[str, Any]:
    interval_seconds = max(900, int(os.environ.get("VCT_RUN_INTERVAL_SECONDS", "7200")))
    horizon_hours = max(1, int(os.environ.get("VCT_HORIZON_HOURS", "48")))
    return {
        "intervalSeconds": interval_seconds,
        "horizonHours": horizon_hours,
        "executionEnvironment": "cloud",
    }


def rows_from_database(connection: sqlite3.Connection, source: str, limit: int | None) -> list[sqlite3.Row]:
    where = ""
    parameters: list[Any] = []
    if source == "system":
        where = "WHERE p.source LIKE 'system%'"
    elif source == "human":
        where = "WHERE p.source LIKE 'human%'"
    sql = f"""SELECT p.*, ta.name AS team_a_name, tb.name AS team_b_name,
      aw.name AS actual_winner_name, m.played_at AS result_played_at, m.source_url AS result_source_url
      FROM predictions p
      JOIN teams ta ON ta.team_id=p.team_a_id
      JOIN teams tb ON tb.team_id=p.team_b_id
      LEFT JOIN teams aw ON aw.team_id=p.actual_winner_id
      LEFT JOIN matches m ON m.match_id=p.resolved_match_id
      {where}
      ORDER BY datetime(p.scheduled_at), p.prediction_id"""
    if limit is not None:
        sql += " LIMIT ?"
        parameters.append(limit)
    return list(connection.execute(sql, parameters))


def state_payload(connection: sqlite3.Connection, rows: list[sqlite3.Row]) -> dict[str, Any]:
    matches = int(connection.execute("SELECT COUNT(*) FROM matches").fetchone()[0])
    teams = int(connection.execute("SELECT COUNT(*) FROM teams").fetchone()[0])
    cutoff = connection.execute("SELECT MAX(played_at) FROM matches").fetchone()[0]
    resolved = sum(1 for row in rows if row["status"] == "resolved")
    system_versions = [str(row["model_version"]) for row in rows if row["source"].startswith("system")]
    version = system_versions[-1] if system_versions else "v1.0.0"
    latest_run = connection.execute(
        """SELECT run_id, run_type, status, started_at, completed_at, counters_json, error
           FROM automation_runs ORDER BY datetime(started_at) DESC LIMIT 1"""
    ).fetchone()
    learning = connection.execute(
        """SELECT COUNT(*) snapshots, COUNT(DISTINCT fixture_id) fixtures,
           SUM(CASE WHEN quality_status IN ('ready','locked') THEN 1 ELSE 0 END) ready,
           SUM(CASE WHEN quality_status NOT IN ('ready','locked') THEN 1 ELSE 0 END) blocked,
           COUNT(DISTINCT CASE WHEN outcome_status='resolved' THEN fixture_id END) labeled,
           COUNT(DISTINCT CASE WHEN outcome_status='pending' THEN fixture_id END) pending,
           COUNT(DISTINCT CASE WHEN outcome_status='resolved' AND quality_status IN ('ready','locked') THEN fixture_id END) eligible,
           MIN(observed_at) started_at FROM prospective_snapshots"""
    ).fetchone()
    shadow_rows = challenger_rows_from_database(connection)
    eligible_shadow = [row for row in shadow_rows if row["status"] == "resolved" and row["eligible"] and row["record_kind"] == "real_prospective"]
    shadow_count = len(eligible_shadow)
    shadow_phase = "ACCUMULATING" if shadow_count < 30 else "PRELIMINARY" if shadow_count < 50 else "EVALUATING" if shadow_count < 100 else "GATE_READY"
    return {
        "coverage": {
            "matches": matches,
            "teams": teams,
            "predictions": len(rows),
            "regions": 4,
            "cutoffAt": iso(cutoff),
        },
        "model": {
            "version": version,
            "role": "champion",
            "status": "frozen",
            "parentVersion": None,
            "trainingCutoff": iso(cutoff),
            "minimumSampleGate": 100,
            "observedSamples": resolved,
            "metrics": metrics(rows),
            "constraints": {
                "globalWeightsFrozen": True,
                "directLlmPromotion": False,
                "minimumOverallSamples": 100,
                "minimumRegionSamples": 20,
            },
        },
        "run": automation_run_payload(latest_run),
        "schedule": automation_schedule_payload(),
        "learning": {
            "mode": "prospective_gold",
            "startedAt": iso(learning["started_at"]) if learning["started_at"] else None,
            "snapshots": int(learning["snapshots"] or 0),
            "fixtures": int(learning["fixtures"] or 0),
            "ready": int(learning["ready"] or 0),
            "blocked": int(learning["blocked"] or 0),
            "labeled": int(learning["labeled"] or 0),
            "pending": int(learning["pending"] or 0),
            "trainingEligible": int(learning["eligible"] or 0),
            "trainingGate": 100,
        },
        "challenger": {
            "modelId": "logistic_c1_v1.4b_20260903", "status": "SHADOW", "phase": shadow_phase,
            "eligibleResolvedMatches": shadow_count, "gate": 100,
            "promotionStatus": "EVALUATING" if shadow_count < 100 else "GATE_READY", "promotionEnabled": False,
            "historicalEvaluationIncluded": False,
        },
    }


def post_json(
    base_url: str,
    path: str,
    key: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json", "x-automation-key": key, "user-agent": "vct-public-bridge/1.0"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {path}: {body}") from error
    except URLError as error:
        raise RuntimeError(f"network_error {path}: {error.reason}") from error


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="将 VCT V1 赛前快照与赛果幂等同步到公网 D1")
    result.add_argument("--database", required=True, type=Path)
    result.add_argument("--base-url", default="http://127.0.0.1:3000")
    result.add_argument("--source", choices=("all", "system", "human"), default="all")
    result.add_argument("--limit", type=int)
    result.add_argument("--dry-run", action="store_true")
    result.add_argument("--key-env", default="VCT_AUTOMATION_KEY")
    result.add_argument(
        "--ai-timeout",
        type=int,
        default=int(os.environ.get("VCT_AI_REQUEST_TIMEOUT_SECONDS", "240")),
        help="DeepSeek-backed prediction/result request timeout in seconds (30-600)",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not 30 <= args.ai_timeout <= 600:
        raise SystemExit("--ai-timeout 必须在 30 到 600 秒之间")
    if not args.database.is_file():
        raise SystemExit(f"数据库不存在：{args.database}")
    connection = sqlite3.connect(f"file:{args.database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = rows_from_database(connection, args.source, args.limit)
    challenger_rows = challenger_rows_from_database(connection)
    state = state_payload(connection, rows)
    if args.dry_run:
        sample = prediction_payload(rows[-1]) if rows else None
        print(json.dumps({"ok": True, "dryRun": True, "rows": len(rows), "state": state, "latestSample": sample}, ensure_ascii=False, indent=2))
        return 0
    key = os.environ.get(args.key_env)
    if not key:
        raise SystemExit(f"缺少环境变量：{args.key_env}")
    post_json(args.base_url, "/api/automation/state", key, state)
    counters = {"state": 1, "predictions": 0, "challengers": 0, "results": 0}
    challengers = {row["champion_prediction_id"]: row for row in challenger_rows}
    for row in rows:
        post_json(
            args.base_url,
            "/api/automation/predictions",
            key,
            {"prediction": prediction_payload(row)},
            timeout_seconds=args.ai_timeout,
        )
        counters["predictions"] += 1
        challenger = challengers.get(row["prediction_id"])
        if challenger:
            post_json(args.base_url, "/api/automation/challengers", key, {"challenger": challenger_payload(challenger)})
            counters["challengers"] += 1
        result = resolved_payload(row)
        if result:
            post_json(
                args.base_url,
                "/api/automation/results",
                key,
                result,
                timeout_seconds=args.ai_timeout,
            )
            counters["results"] += 1
    print(json.dumps({"ok": True, "baseUrl": args.base_url, "source": args.source, **counters}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from error
