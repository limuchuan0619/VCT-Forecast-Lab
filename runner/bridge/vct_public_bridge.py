"""Read-only bridge from the VCT V1 SQLite model to the public Sites API.

The source database is never modified. Authentication is read from an environment
variable so the ingestion key is not stored in arguments, source, or logs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from vct_prediction.sources.vlr import _complete_competitive_map_score


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
    "summit": "天枢云阙",
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
            **({"teamAMapRating": float(item["team_a_map_rating"])} if isinstance(item.get("team_a_map_rating"), (int, float)) else {}),
            **({"teamBMapRating": float(item["team_b_map_rating"])} if isinstance(item.get("team_b_map_rating"), (int, float)) else {}),
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


def prematch_reader_context(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any] | None:
    """Small explanatory context, separate from the immutable prediction payload.

    Reuse only the frozen recent-form match IDs and facts already inserted and
    source-observed strictly before the lock. Never fetch or write anything.
    Existing public AI jobs ignore this auxiliary field and retain their packet.
    """
    if row["status"] != "locked":
        return None
    snapshot = load_json(row["factor_snapshot_json"], {})
    cutoff = iso(row["locked_at"])
    recent = []
    try:
        for side in ("team_a", "team_b"):
            ids = [item.get("match_id") for item in snapshot.get("recent_form", {}).get(side, {}).get("components", [])]
            ids = list(dict.fromkeys(item for item in ids if isinstance(item, str) and re.fullmatch(r"vlr_match_\d+", item)))[:30]
            if not ids:
                continue
            team_id = row[f"{side}_id"]
            values = connection.execute(f"""SELECT m.*, ta.name AS name_a,tb.name AS name_b,
                sr.fetched_at AS known_source_at,sr.source_url AS known_source_url
                FROM matches m JOIN teams ta ON ta.team_id=m.team_a_id JOIN teams tb ON tb.team_id=m.team_b_id
                JOIN source_records sr ON sr.canonical_id=m.match_id AND sr.source_id='vlr' AND sr.entity_type='match'
                WHERE m.match_id IN ({','.join('?' for _ in ids)}) AND (m.team_a_id=? OR m.team_b_id=?)
                  AND julianday(m.played_at)<julianday(?) AND julianday(m.inserted_at)<julianday(?)
                  AND julianday(sr.fetched_at)<julianday(?) AND m.processed=1
                ORDER BY julianday(m.played_at) DESC LIMIT 3""", (*ids,team_id,team_id,cutoff,cutoff,cutoff)).fetchall()
            for match in values:
                is_a = match["team_a_id"] == team_id
                recent.append({
                    "reference": f"history:{side}:{match['match_id']}", "matchId": match["match_id"],
                    "team": row[f"{side}_name"], "opponent": match["name_b"] if is_a else match["name_a"],
                    "teamScore": int(match["team_a_maps"] if is_a else match["team_b_maps"]),
                    "opponentScore": int(match["team_b_maps"] if is_a else match["team_a_maps"]),
                    "playedAt": iso(match["played_at"]),
                    "knownAt": max(iso(match["inserted_at"]),iso(match["known_source_at"])),
                    "sourceUrl": match["known_source_url"],
                })
    except (sqlite3.Error, KeyError, TypeError, ValueError):
        return None  # Optional explanation data cannot prevent formal sync.
    return {"schemaVersion": "prematch-reader-evidence-v1", "cutoffAt": cutoff, "recentMatches": recent,
            "limits": ["个人状态未证明对应最近观察的五人，不用于解释当前阵容。", "真实游戏版本、官方首发和实际选图未核实。"]} if recent else None


def resolved_payload(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any] | None:
    if row["status"] != "resolved" or not row["actual_winner_name"] or not row["actual_score"]:
        return None
    map_rows = connection.execute(
        """SELECT map_order,map_id,team_a_rounds,team_b_rounds
           FROM map_results WHERE match_id=? ORDER BY map_order""",
        (row["resolved_match_id"],),
    ).fetchall() if row["resolved_match_id"] else []
    # Old production databases can contain maps captured while a match page was
    # still live.  Never redeliver those partial scores as immutable evidence.
    # New collection already rejects them at parse time; this is a read-only
    # compatibility guard for rows created before that fix.
    if any(
        not _complete_competitive_map_score(
            int(item["team_a_rounds"]), int(item["team_b_rounds"])
        )
        for item in map_rows
    ):
        return None
    score_match = re.match(r"^(\d+)-(\d+)$", str(row["actual_score"]))
    if not map_rows or not score_match:
        return None
    expected_series = (int(score_match.group(1)), int(score_match.group(2)))
    reconstructed_series = (
        sum(int(item["team_a_rounds"]) > int(item["team_b_rounds"]) for item in map_rows),
        sum(int(item["team_b_rounds"]) > int(item["team_a_rounds"]) for item in map_rows),
    )
    if reconstructed_series != expected_series:
        return None
    player_rows = connection.execute(
        """SELECT map_order,player_id,player_name,team_id,agent,rating,acs,kills,deaths,assists,kast,adr,hs_pct,first_kills,first_deaths
           FROM match_player_stats WHERE match_id=? ORDER BY map_order,team_id,player_id""",
        (row["resolved_match_id"],),
    ).fetchall() if row["resolved_match_id"] else []
    # The source result insertion timestamp is immutable. Review generation can
    # occur again on every cycle and must never drift the frozen evidence hash.
    captured_at = iso(row["result_inserted_at"] or row["review_generated_at"]) or iso(datetime.now(timezone.utc).isoformat())
    if captured_at and captured_at < iso(row["scheduled_at"]):
        captured_at = iso(datetime.now(timezone.utc).isoformat())
    actual_maps = []
    for item in map_rows:
        score_a, score_b = int(item["team_a_rounds"]), int(item["team_b_rounds"])
        map_id = str(item["map_id"]).lower()
        actual_maps.append({
            "order": int(item["map_order"]),
            "map": MAP_NAMES.get(map_id, str(item["map_id"])),
            "teamAScore": score_a,
            "teamBScore": score_b,
            "winner": row["team_a_name"] if score_a > score_b else row["team_b_name"],
            "sourceUrl": row["result_source_url"],
            "missingFields": ["attack_defense"],
        })
    player_stats = [
        {
            "mapOrder": int(item["map_order"]), "playerId": item["player_id"], "player": item["player_name"],
            "teamId": item["team_id"], "agent": item["agent"], "rating": item["rating"], "acs": item["acs"],
            "kills": item["kills"], "deaths": item["deaths"], "assists": item["assists"], "kast": item["kast"],
            "adr": item["adr"], "hsPct": item["hs_pct"], "firstKills": item["first_kills"], "firstDeaths": item["first_deaths"],
        }
        for item in player_rows
    ] or None
    return {
        "predictionId": row["prediction_id"],
        "actualWinner": row["actual_winner_name"],
        "actualScore": row["actual_score"],
        # Settlement time is when the completed result was observed, not the source's
        # match-start timestamp.  The latter can legitimately predate a rescheduled fixture.
        "resolvedAt": captured_at,
        "resultEvidence": {
            "schemaVersion": "v1.4c-r1-result-evidence-v1",
            "source": {
                "sourceId": "vlr", "sourceUrl": row["result_source_url"],
                "sourceMatchId": row["resolved_match_id"], "capturedAt": captured_at,
            },
            "series": {
                "actualWinner": row["actual_winner_name"], "actualScore": row["actual_score"],
                "scheduledAt": iso(row["scheduled_at"]), "playedAt": iso(row["result_played_at"]),
                "seriesFormat": row["series_format"],
            },
            "maps": actual_maps,
            "playerStats": player_stats,
            "missing": {
                "maps": not bool(actual_maps), "playerStats": player_stats is None,
                "attackDefense": True, "veto": True,
            },
        },
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
      aw.name AS actual_winner_name, m.played_at AS result_played_at, m.source_url AS result_source_url,
      m.inserted_at AS result_inserted_at, p.resolved_match_id,
      (SELECT generated_at FROM prediction_reviews r WHERE r.prediction_id=p.prediction_id LIMIT 1) AS review_generated_at
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
    counters = json.loads(latest_run["counters_json"] or "{}") if latest_run else {}
    learning = connection.execute(
        """SELECT COUNT(*) snapshots, COUNT(DISTINCT fixture_id) fixtures,
           SUM(CASE WHEN quality_status IN ('ready','locked') THEN 1 ELSE 0 END) ready,
           SUM(CASE WHEN quality_status NOT IN ('ready','locked') THEN 1 ELSE 0 END) blocked,
           COUNT(DISTINCT CASE WHEN outcome_status='resolved' THEN fixture_id END) labeled,
           COUNT(DISTINCT CASE WHEN outcome_status='pending' THEN fixture_id END) pending,
           COUNT(DISTINCT CASE WHEN outcome_status='resolved' AND quality_status IN ('ready','locked')
             AND COALESCE(json_extract(snapshot_json,'$.classification'),'regional') IN ('regional','international') THEN fixture_id END) eligible,
           MIN(observed_at) started_at FROM prospective_snapshots"""
    ).fetchone()
    shadow_rows = challenger_rows_from_database(connection)
    eligible_shadow = [row for row in shadow_rows if row["status"] == "resolved" and row["eligible"] and row["record_kind"] == "real_prospective"]
    shadow_count = int(counters.get("challenger_evaluation", {}).get("eligible_resolved_matches", len(eligible_shadow)))
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
            "snapshotObservations": int(learning["snapshots"] or 0),
            "fixtureCoverage": int(learning["fixtures"] or 0),
            "ready": int(learning["ready"] or 0),
            "blocked": int(learning["blocked"] or 0),
            "labeled": int(learning["labeled"] or 0),
            "pending": int(learning["pending"] or 0),
            "trainingEligible": int(learning["eligible"] or 0),
            "trainingGate": 100,
            "primaryCompetitionOnly": True,
            "competitionCoverage": counters.get("fixtures_by_competition", {}),
        },
        "challenger": {
            "modelId": "logistic_c1_v1.4b_20260903", "status": "SHADOW", "phase": shadow_phase,
            "eligibleResolvedMatches": shadow_count, "gate": 100,
            "promotionStatus": "EVALUATING" if shadow_count < 100 else "GATE_READY", "promotionEnabled": False,
            "historicalEvaluationIncluded": False,
            "metricIntegrity": counters.get("challenger_evaluation", {}).get("metric_integrity", {"status": "UNVERIFIED"}),
            "metrics": counters.get("challenger_evaluation", {}).get("metrics"),
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


def synchronize(
    connection: sqlite3.Connection,
    *,
    base_url: str,
    key: str,
    source: str,
    limit: int | None,
    ai_timeout: int,
    poster: Any = post_json,
    sync_run_id: str | None = None,
) -> dict[str, Any]:
    rows = rows_from_database(connection, source, limit)
    challenger_rows = challenger_rows_from_database(connection)
    state = state_payload(connection, rows)
    sync_run_id = sync_run_id or f"public-sync-{uuid.uuid4().hex}"
    started_at = iso(datetime.now(timezone.utc).isoformat())
    runner_run_id = state.get("run", {}).get("id") if state.get("run") else None
    poster(base_url, "/api/automation/sync-runs", key, {
        "syncRunId": sync_run_id, "runnerRunId": runner_run_id,
        "status": "RUNNING", "startedAt": started_at,
    })
    counters: dict[str, dict[str, int]] = {
        name: {"attempted": 0, "succeeded": 0, "failed": 0}
        for name in ("predictions", "challengers", "results", "ai_jobs", "state")
    }
    failures: list[dict[str, str]] = []

    def attempt(kind: str, item_id: str, path: str, payload: dict[str, Any], timeout_seconds: int = 30) -> None:
        counters[kind]["attempted"] += 1
        try:
            poster(base_url, path, key, {**payload, "syncRunId": sync_run_id}, timeout_seconds=timeout_seconds)
            counters[kind]["succeeded"] += 1
        except Exception as exc:
            counters[kind]["failed"] += 1
            failures.append({"type": kind, "id": item_id, "error": f"{type(exc).__name__}:{exc}"[:512]})

    def attempt_result(item_id: str, payload: dict[str, Any]) -> None:
        counters["results"]["attempted"] += 1
        try:
            poster(base_url, "/api/automation/results", key, {**payload, "syncRunId": sync_run_id}, timeout_seconds=ai_timeout)
            counters["results"]["succeeded"] += 1
        except Exception as exc:
            message = f"{type(exc).__name__}:{exc}"
            if "HTTP 409" in message and ("result_conflict" in message or "result_evidence_conflict" in message):
                try:
                    poster(base_url, "/api/automation/result-corrections", key, {
                        **payload, "syncRunId": sync_run_id,
                        "reason": "SOURCE_PAGE_STABILIZED_AFTER_PREMATURE_CAPTURE",
                    }, timeout_seconds=ai_timeout)
                    counters["results"]["succeeded"] += 1
                    return
                except Exception as correction_error:
                    message = f"{type(correction_error).__name__}:{correction_error}"
            counters["results"]["failed"] += 1
            failures.append({"type": "results", "id": item_id, "error": message[:512]})

    challengers = {row["champion_prediction_id"]: row for row in challenger_rows}
    for row in rows:
        prediction_id = str(row["prediction_id"])
        attempt(
            "predictions", prediction_id, "/api/automation/predictions",
            {"prediction": prediction_payload(row), "prematchContext": prematch_reader_context(connection,row)}, ai_timeout,
        )
        challenger = challengers.get(row["prediction_id"])
        if challenger:
            attempt(
                "challengers", str(challenger["shadow_prediction_id"]), "/api/automation/challengers",
                {"challenger": challenger_payload(challenger)},
            )
        result = resolved_payload(connection, row)
        if result:
            attempt_result(prediction_id, result)
    # Bounded batches keep every request under the provider timeout while allowing
    # an initial deployment to reconcile all existing settled predictions. Empty
    # follow-up batches are cheap and future cycles normally find no due work.
    for batch in range(1, 4):
        attempt("ai_jobs", f"postmatch-{batch}", "/api/automation/ai/jobs", {"limit": 3}, ai_timeout)
    attempt("state", "current", "/api/automation/state", state)

    total_succeeded = sum(value["succeeded"] for value in counters.values())
    total_failed = sum(value["failed"] for value in counters.values())
    status = "SUCCESS" if total_failed == 0 else "FAILED" if total_succeeded == 0 else "DEGRADED"
    completed_at = iso(datetime.now(timezone.utc).isoformat())
    poster(base_url, "/api/automation/sync-runs", key, {
        "syncRunId": sync_run_id, "runnerRunId": runner_run_id, "status": status,
        "startedAt": started_at, "completedAt": completed_at, "counters": counters,
        "failures": failures[:200], "errorCode": failures[0]["error"] if failures else None,
    })
    return {
        "ok": status == "SUCCESS", "status": status, "syncRunId": sync_run_id,
        "baseUrl": base_url, "source": source, "counters": counters,
        "failures": failures[:200],
        "predictions": counters["predictions"]["succeeded"],
        "challengers": counters["challengers"]["succeeded"],
        "results": counters["results"]["succeeded"],
        "state": counters["state"]["succeeded"],
    }


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not 30 <= args.ai_timeout <= 600:
        raise SystemExit("--ai-timeout 必须在 30 到 600 秒之间")
    if not args.database.is_file():
        raise SystemExit(f"数据库不存在：{args.database}")
    connection = sqlite3.connect(f"file:{args.database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = rows_from_database(connection, args.source, args.limit)
    state = state_payload(connection, rows)
    if args.dry_run:
        sample = prediction_payload(rows[-1]) if rows else None
        print(json.dumps({"ok": True, "dryRun": True, "rows": len(rows), "state": state, "latestSample": sample}, ensure_ascii=False, indent=2))
        return 0
    key = os.environ.get(args.key_env)
    if not key:
        raise SystemExit(f"缺少环境变量：{args.key_env}")
    result = synchronize(
        connection, base_url=args.base_url, key=key, source=args.source,
        limit=args.limit, ai_timeout=args.ai_timeout,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from error
