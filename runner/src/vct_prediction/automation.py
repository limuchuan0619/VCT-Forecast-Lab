"""V1.1 unattended fixture discovery, prediction locking and result settlement."""

from __future__ import annotations

import json
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import MODEL_VERSION
from .constants import MAPS, SERIES_FORMATS
from .competition import COVERAGE_VERSION, can_predict, is_primary
from .db import Database
from .predictor import predict_match
from .realdata import import_collection
from .reviews import refresh_prediction_reviews
from .shadow import (
    FrozenLogisticC1,
    blocker_coverage,
    create_feature_snapshot,
    freeze_shadow_prediction,
    prospective_metrics,
    select_prematch_gold_snapshot,
    settle_shadow_predictions,
)
from .sources.vlr import BASE_URL, VlrClient


SOURCE = {
    "source_id": "vlr",
    "name": "VLR.gg",
    "base_url": BASE_URL,
    "source_type": "community_public_web",
    "authority_level": "secondary",
    "terms_note": "Community match index; not affiliated with Riot. Raw pages and URLs retained for audit.",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _external_id(href: str) -> str | None:
    match = re.match(r"/(\d+)/", href)
    return match.group(1) if match else None


def _ordered_fixture_links(
    links: list[str], known_times: dict[str, str], now: datetime, horizon_hours: int,
) -> list[str]:
    """Recover known imminent/results first; rotate unknowns on bounded retries."""
    if not links:
        return []
    offset = (int(now.timestamp() // 900) * 24) % len(links)
    ordered = links[offset:] + links[:offset]
    horizon = now + timedelta(hours=horizon_hours)

    def priority(href: str) -> tuple[int, float]:
        value = known_times.get(_external_id(href) or "")
        if value:
            try:
                scheduled = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if scheduled.tzinfo is not None:
                    return (0 if scheduled <= horizon else 2, scheduled.timestamp())
            except ValueError:
                pass
        return (1, 0.0)

    return sorted(ordered, key=priority)


def _result_candidate_facts(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "external_match_id": result["external_match_id"],
        "series_format": result["series_format"],
        "team_a_id": result["team_a_id"], "team_b_id": result["team_b_id"],
        "winner_id": result["winner_id"], "team_a_maps": result["team_a_maps"], "team_b_maps": result["team_b_maps"],
        "maps": [{
            "map_order": item["map_order"], "map": item["map"],
            "team_a_rounds": item["team_a_rounds"], "team_b_rounds": item["team_b_rounds"],
        } for item in result["maps"]],
    }


def observe_result_candidate(db: Database, result: dict[str, Any], observed_at: str | None = None) -> tuple[bool, str]:
    """Require two identical observations; revisions are quarantined and versioned."""
    now = observed_at or _now()
    facts = _result_candidate_facts(result)
    serialized = _json(facts)
    candidate_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    external_id = str(result["external_match_id"])
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM result_candidates WHERE source_id='vlr' AND external_match_id=?", (external_id,)
        ).fetchone()
        if row is None:
            conn.execute(
                """INSERT INTO result_candidates(source_id,external_match_id,candidate_hash,candidate_json,first_seen_at,last_seen_at,
                   confirmation_count,status,last_reason,revision_no) VALUES('vlr',?,?,?,?,?,1,'REVISION_PENDING','awaiting_second_confirmation',1)""",
                (external_id, candidate_hash, serialized, now, now),
            )
            return False, "REVISION_PENDING"
        if row["candidate_hash"] == candidate_hash:
            confirmations = int(row["confirmation_count"]) + 1
            status = "FINAL_CONFIRMED" if confirmations >= 2 else "REVISION_PENDING"
            conn.execute(
                """UPDATE result_candidates SET last_seen_at=?,confirmation_count=?,status=?,last_reason=?
                   WHERE source_id='vlr' AND external_match_id=?""",
                (now, confirmations, status, None if status == "FINAL_CONFIRMED" else "awaiting_second_confirmation", external_id),
            )
            return status == "FINAL_CONFIRMED", status
        revision_no = int(row["revision_no"]) + 1
        conn.execute(
            """INSERT INTO result_candidate_revisions(source_id,external_match_id,revision_no,previous_hash,previous_json,
               replacement_hash,replacement_json,reason,created_at) VALUES('vlr',?,?,?,?,?,?,?,?)""",
            (external_id, revision_no, row["candidate_hash"], row["candidate_json"], candidate_hash, serialized, "SOURCE_RESULT_REVISED", now),
        )
        conn.execute(
            """UPDATE result_candidates SET candidate_hash=?,candidate_json=?,first_seen_at=?,last_seen_at=?,confirmation_count=1,
               status='RESULT_INCONSISTENT',last_reason='candidate_changed_confirmation_reset',revision_no=?
               WHERE source_id='vlr' AND external_match_id=?""",
            (candidate_hash, serialized, now, now, revision_no, external_id),
        )
        return False, "RESULT_INCONSISTENT"


def _start_run(db: Database, run_type: str, trigger_type: str) -> str:
    run_id = uuid.uuid4().hex
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO automation_runs(
                   run_id, run_type, trigger_type, started_at, status,
                   counters_json, model_version, database_path
               ) VALUES(?, ?, ?, ?, 'running', '{}', ?, ?)""",
            (run_id, run_type, trigger_type, _now(), MODEL_VERSION, str(db.path)),
        )
    return run_id


def _finish_run(db: Database, run_id: str, status: str, counters: dict[str, Any], error: str | None = None) -> None:
    with db.connect() as conn:
        conn.execute(
            """UPDATE automation_runs SET completed_at=?, status=?, counters_json=?, error=?
               WHERE run_id=?""",
            (_now(), status, _json(counters), error, run_id),
        )


def _register_source(db: Database) -> None:
    now = _now()
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO data_sources(
                   source_id, name, base_url, source_type, authority_level,
                   terms_note, enabled, created_at, updated_at
               ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
                   name=excluded.name, base_url=excluded.base_url,
                   source_type=excluded.source_type, authority_level=excluded.authority_level,
                   terms_note=excluded.terms_note, enabled=1, updated_at=excluded.updated_at""",
            (
                SOURCE["source_id"], SOURCE["name"], SOURCE["base_url"],
                SOURCE["source_type"], SOURCE["authority_level"],
                SOURCE["terms_note"], now, now,
            ),
        )


def _event_map_pool(db: Database, fixture: dict[str, Any]) -> tuple[list[str], str]:
    """Use only maps observed before the scheduled match; never leak future results."""
    required = SERIES_FORMATS[fixture["series_format"]] * 2 - 1
    with db.connect() as conn:
        exact = [row[0] for row in conn.execute(
            """SELECT mr.map_id
               FROM map_results mr JOIN matches m ON m.match_id=mr.match_id
               WHERE m.event=? AND julianday(m.played_at) < julianday(?)
               GROUP BY mr.map_id ORDER BY MAX(julianday(m.played_at)) DESC""",
            (fixture["event"], fixture["scheduled_at"]),
        ).fetchall()]
        if len(exact) >= required:
            return exact, "event_observed_union_before_fixture"
        cohort = [row[0] for row in conn.execute(
            """SELECT mr.map_id
               FROM map_results mr JOIN matches m ON m.match_id=mr.match_id
               WHERE m.patch=? AND julianday(m.played_at) < julianday(?)
               GROUP BY mr.map_id ORDER BY MAX(julianday(m.played_at)) DESC""",
            (fixture["patch"], fixture["scheduled_at"]),
        ).fetchall()]
        if len(cohort) >= required:
            return cohort, "same_cohort_observed_union_before_fixture"
        recent = [row[0] for row in conn.execute(
            """SELECT mr.map_id
               FROM map_results mr JOIN matches m ON m.match_id=mr.match_id
               WHERE julianday(m.played_at) < julianday(?)
                 AND julianday(m.played_at) >= julianday(?, '-45 days')
               GROUP BY mr.map_id
               ORDER BY MAX(julianday(m.played_at)) DESC, COUNT(*) DESC""",
            (fixture["scheduled_at"], fixture["scheduled_at"]),
        ).fetchall()]
    return (recent, "recent_official_union_45d_before_fixture") if len(recent) >= required else ([], "unavailable")


def _ensure_team(db: Database, team: dict[str, str], region: str, observed_at: str) -> str | None:
    team_id = team.get("team_id") or None
    external_id = team.get("external_team_id") or None
    name = team.get("name") or "TBD"
    if not team_id or not external_id or name.upper() == "TBD":
        return None
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO teams(team_id, name, region, updated_at)
               VALUES(?, ?, ?, ?)
               ON CONFLICT(team_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at""",
            (team_id, name, region, observed_at),
        )
        conn.execute(
            """INSERT INTO team_aliases(
                   source_id, external_team_id, canonical_team_id, alias, first_seen_at, last_seen_at
               ) VALUES('vlr', ?, ?, ?, ?, ?)
               ON CONFLICT(source_id, external_team_id) DO UPDATE SET
                   canonical_team_id=excluded.canonical_team_id,
                   alias=excluded.alias, last_seen_at=excluded.last_seen_at""",
            (external_id, team_id, name, observed_at, observed_at),
        )
    return team_id


def _record_fixture_watch(db: Database, external_id: str, event: dict[str, Any], evidence: dict[str, Any], reason: str) -> None:
    """Persist source-backed attention without fabricating a kickoff/team/Gold row."""
    with db.connect() as conn:
        conn.execute("""INSERT INTO source_records(source_id,entity_type,external_id,canonical_id,source_url,
            content_hash,fetched_at,raw_path,data_quality) VALUES('vlr','fixture_watch',?,?,?,?,?,?,?)
            ON CONFLICT(source_id,entity_type,external_id) DO UPDATE SET source_url=excluded.source_url,
            content_hash=excluded.content_hash,fetched_at=excluded.fetched_at,raw_path=excluded.raw_path,data_quality=excluded.data_quality""",
            (external_id,f"vlr_fixture_{external_id}",evidence["source_url"],evidence["content_hash"],evidence["fetched_at"],
             evidence.get("raw_path"),f"watch:{event['classification']}:{reason}"[:250]))


def _competition_coverage(db: Database) -> dict[str, Any]:
    with db.connect() as conn:
        rows=conn.execute("""SELECT classification,region,COUNT(*) fixtures,
            SUM(CASE WHEN quality_status IN ('ready','locked') THEN 1 ELSE 0 END) ready,
            SUM(CASE WHEN prediction_id IS NOT NULL THEN 1 ELSE 0 END) predictions
            FROM fixtures GROUP BY classification,region""").fetchall()
        watch=conn.execute("""SELECT data_quality,COUNT(*) n FROM source_records r
            WHERE r.source_id='vlr' AND r.entity_type='fixture_watch'
            AND NOT EXISTS(SELECT 1 FROM fixtures f WHERE f.source_id=r.source_id AND f.external_match_id=r.external_id)
            GROUP BY data_quality""").fetchall()
    return {"fixtures":[dict(r) for r in rows], "observation_only_reasons":{r["data_quality"]:r["n"] for r in watch},
            "evaluation_policy":"primary_vct_only_for_existing_gold_and_c1_gate"}


def _quality(db: Database, fixture: dict[str, Any], now: datetime) -> tuple[str, list[str]]:
    blockers = list(fixture.get("blockers", []))
    if not can_predict(fixture.get("classification", "unclassified"), fixture.get("region", "OTHER")):
        blockers.append("competition_observation_only_or_region_unverified")
    scheduled = datetime.fromisoformat(fixture["scheduled_at"].replace("Z", "+00:00"))
    required = SERIES_FORMATS.get(fixture["series_format"], 0) * 2 - 1
    if scheduled <= now:
        blockers.append("scheduled_time_passed")
    if fixture["series_format"] not in SERIES_FORMATS:
        blockers.append("unsupported_series_format")
    if not fixture.get("team_a_id") or not fixture.get("team_b_id"):
        blockers.append("teams_unresolved_or_tbd")
    if len(fixture.get("map_pool", [])) < required:
        blockers.append("map_pool_insufficient")
    if fixture.get("team_a_id") and fixture.get("team_b_id"):
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT team_id, matches_played FROM teams WHERE team_id IN (?, ?)",
                (fixture["team_a_id"], fixture["team_b_id"]),
            ).fetchall()
        samples = {row["team_id"]: int(row["matches_played"]) for row in rows}
        if samples.get(fixture["team_a_id"], 0) < 3 or samples.get(fixture["team_b_id"], 0) < 3:
            blockers.append("team_history_below_three_series")
    blockers = list(dict.fromkeys(blockers))
    return ("ready", []) if not blockers else ("blocked", blockers)


def _upsert_fixture(db: Database, fixture: dict[str, Any], now: datetime) -> tuple[str, list[str]]:
    team_region = fixture["region"] if fixture["region"] != "INTERNATIONAL" else "INTERNATIONAL"
    fixture["team_a_id"] = _ensure_team(db, fixture["teams"][0], team_region, fixture["fetched_at"])
    fixture["team_b_id"] = _ensure_team(db, fixture["teams"][1], team_region, fixture["fetched_at"])
    fixture["team_a_name"] = fixture["teams"][0]["name"]
    fixture["team_b_name"] = fixture["teams"][1]["name"]
    fixture["map_pool"], fixture["map_pool_provenance"] = _event_map_pool(db, fixture)
    quality_status, blockers = _quality(db, fixture, now)
    created = _now()
    with db.connect() as conn:
        previous = conn.execute(
            "SELECT team_a_id, team_b_id, scheduled_at, prediction_id FROM fixtures WHERE fixture_id=?",
            (fixture["fixture_id"],),
        ).fetchone()
        if previous and previous["prediction_id"] and (
            previous["team_a_id"] != fixture["team_a_id"]
            or previous["team_b_id"] != fixture["team_b_id"]
            or previous["scheduled_at"] != fixture["scheduled_at"]
        ):
            quality_status = "changed_after_lock"
            blockers = list(dict.fromkeys([*blockers, "source_identity_changed_after_lock"]))
        conn.execute(
            """INSERT INTO fixtures(
                   fixture_id, source_id, external_match_id, external_event_id,
                   event, region, classification, stage, scheduled_at, series_format,
                   patch, patch_provenance, team_a_id, team_b_id, team_a_name, team_b_name,
                   map_pool_json, map_pool_provenance, source_url, raw_path, content_hash,
                   fetched_at, status, quality_status, blocker_json, created_at, updated_at
               ) VALUES(?, 'vlr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(fixture_id) DO UPDATE SET
                   event=excluded.event, region=excluded.region, classification=excluded.classification,
                   stage=excluded.stage, scheduled_at=excluded.scheduled_at,
                   series_format=excluded.series_format, patch=excluded.patch,
                   patch_provenance=excluded.patch_provenance,
                   team_a_id=excluded.team_a_id, team_b_id=excluded.team_b_id,
                   team_a_name=excluded.team_a_name, team_b_name=excluded.team_b_name,
                   map_pool_json=excluded.map_pool_json,
                   map_pool_provenance=excluded.map_pool_provenance,
                   source_url=excluded.source_url, raw_path=excluded.raw_path,
                   content_hash=excluded.content_hash, fetched_at=excluded.fetched_at,
                   status=excluded.status, quality_status=excluded.quality_status,
                   blocker_json=excluded.blocker_json, updated_at=excluded.updated_at""",
            (
                fixture["fixture_id"], fixture["external_match_id"], fixture["external_event_id"],
                fixture["event"], fixture["region"], fixture["classification"], fixture.get("stage"),
                fixture["scheduled_at"], fixture["series_format"], fixture.get("patch"),
                fixture["patch_provenance"], fixture["team_a_id"], fixture["team_b_id"],
                fixture["team_a_name"], fixture["team_b_name"], _json(fixture["map_pool"]),
                fixture["map_pool_provenance"], fixture["source_url"], fixture.get("raw_path"),
                fixture["content_hash"], fixture["fetched_at"], fixture["status"],
                quality_status, _json(blockers), created, created,
            ),
        )
        conn.execute(
            """INSERT INTO source_records(
                   source_id, entity_type, external_id, canonical_id, source_url,
                   content_hash, fetched_at, raw_path, data_quality
               ) VALUES('vlr', 'fixture', ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_id, entity_type, external_id) DO UPDATE SET
                   canonical_id=excluded.canonical_id, source_url=excluded.source_url,
                   content_hash=excluded.content_hash, fetched_at=excluded.fetched_at,
                   raw_path=excluded.raw_path, data_quality=excluded.data_quality""",
            (
                fixture["external_match_id"], fixture["fixture_id"], fixture["source_url"],
                fixture["content_hash"], fixture["fetched_at"], fixture.get("raw_path"),
                "scheduled_community_source" if quality_status == "ready" else "blocked_community_source",
            ),
        )
    return quality_status, blockers


def _prospective_checkpoint(fixture: dict[str, Any], now: datetime) -> str:
    scheduled = datetime.fromisoformat(fixture["scheduled_at"].replace("Z", "+00:00"))
    hours = max(0.0, (scheduled - now).total_seconds() / 3600)
    if hours <= 6:
        return "t6"
    if hours <= 24:
        return "t24"
    if hours <= 48:
        return "t48"
    return "discovery"


def _record_prospective_snapshot(
    db: Database,
    fixture: dict[str, Any],
    quality_status: str,
    blockers: list[str],
    now: datetime,
) -> bool:
    """Append an as-observed training row without inventing unavailable fields."""
    team_columns = """team_id, name, region, rating, matches_played, roster_version,
        roster_continuity, player_form, patch_fit, international_experience,
        bo3_adaptability, bo5_adaptability, last_patch"""
    with db.connect() as conn:
        teams = []
        for team_id in (fixture.get("team_a_id"), fixture.get("team_b_id")):
            row = conn.execute(f"SELECT {team_columns} FROM teams WHERE team_id=?", (team_id,)).fetchone() if team_id else None
            teams.append(dict(row) if row else None)
        prediction_row = conn.execute(
            "SELECT prediction_id FROM fixtures WHERE fixture_id=?", (fixture["fixture_id"],)
        ).fetchone()
    checkpoint = _prospective_checkpoint(fixture, now)
    snapshot = {
        "fixture_id": fixture["fixture_id"],
        "checkpoint": checkpoint,
        "scheduled_at": fixture["scheduled_at"],
        "event": fixture["event"],
        "region": fixture["region"],
        "classification": fixture["classification"],
        "evaluation_cohort": "primary_vct" if is_primary(fixture["classification"]) else fixture["classification"],
        "primary_training_eligible_competition": is_primary(fixture["classification"]),
        "stage": fixture.get("stage"),
        "series_format": fixture["series_format"],
        "patch": fixture.get("patch"),
        "patch_provenance": fixture["patch_provenance"],
        "teams": {"team_a": teams[0], "team_b": teams[1]},
        "map_pool": fixture["map_pool"],
        "map_pool_provenance": fixture["map_pool_provenance"],
        "quality_status": quality_status,
        "blockers": blockers,
        "source": {
            "url": fixture["source_url"],
            "content_hash": fixture["content_hash"],
        },
    }
    serialized = _json(snapshot)
    content_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    snapshot_id = f"gold:{fixture['fixture_id']}:{checkpoint}:{content_hash[:20]}"
    prediction_id = prediction_row["prediction_id"] if prediction_row else None
    with db.connect() as conn:
        cursor = conn.execute(
            """INSERT OR IGNORE INTO prospective_snapshots(
                   snapshot_id, fixture_id, observed_at, checkpoint, scheduled_at,
                   quality_status, blocker_json, snapshot_json, content_hash,
                   model_version, prediction_id, outcome_status, created_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (
                snapshot_id, fixture["fixture_id"], fixture["fetched_at"], checkpoint,
                fixture["scheduled_at"], quality_status, _json(blockers), serialized,
                content_hash, MODEL_VERSION, prediction_id, _now(),
            ),
        )
        return cursor.rowcount > 0


def _prospective_stats(db: Database) -> dict[str, int | str | None]:
    with db.connect() as conn:
        row = conn.execute(
            """SELECT COUNT(*) snapshots, COUNT(DISTINCT fixture_id) fixtures,
               SUM(CASE WHEN quality_status IN ('ready','locked') THEN 1 ELSE 0 END) ready,
               SUM(CASE WHEN quality_status NOT IN ('ready','locked') THEN 1 ELSE 0 END) blocked,
               COUNT(DISTINCT CASE WHEN outcome_status='resolved' THEN fixture_id END) labeled,
               COUNT(DISTINCT CASE WHEN outcome_status='pending' THEN fixture_id END) pending,
               COUNT(DISTINCT CASE WHEN outcome_status='resolved' AND quality_status IN ('ready','locked')
                 AND COALESCE(json_extract(snapshot_json,'$.classification'),'regional') IN ('regional','international') THEN fixture_id END) eligible,
               MIN(observed_at) started_at FROM prospective_snapshots"""
        ).fetchone()
    return {
        "gold_snapshot_total": int(row["snapshots"] or 0),
        "gold_fixture_total": int(row["fixtures"] or 0),
        "gold_ready": int(row["ready"] or 0),
        "gold_blocked": int(row["blocked"] or 0),
        "gold_labeled": int(row["labeled"] or 0),
        "gold_pending": int(row["pending"] or 0),
        "gold_training_eligible": int(row["eligible"] or 0),
        "gold_started_at": row["started_at"],
    }


def _pair_status(
    db: Database,
    fixture_id: str,
    *,
    status: str,
    champion_prediction_id: str | None,
    gold_snapshot: dict[str, Any] | None,
    feature_snapshot: dict[str, Any] | None,
    prediction_created_at: str | None,
    error_code: str | None = None,
) -> None:
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO prediction_pairs(
                   fixture_id,champion_prediction_id,gold_snapshot_id,feature_snapshot_id,
                   gold_observed_at,feature_cutoff_at,prediction_created_at,status,error_code,updated_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(fixture_id) DO UPDATE SET
                   champion_prediction_id=excluded.champion_prediction_id,
                   gold_snapshot_id=COALESCE(excluded.gold_snapshot_id,prediction_pairs.gold_snapshot_id),
                   feature_snapshot_id=COALESCE(excluded.feature_snapshot_id,prediction_pairs.feature_snapshot_id),
                   gold_observed_at=COALESCE(excluded.gold_observed_at,prediction_pairs.gold_observed_at),
                   feature_cutoff_at=COALESCE(excluded.feature_cutoff_at,prediction_pairs.feature_cutoff_at),
                   prediction_created_at=COALESCE(excluded.prediction_created_at,prediction_pairs.prediction_created_at),
                   status=excluded.status,error_code=excluded.error_code,updated_at=excluded.updated_at""",
            (
                fixture_id,
                champion_prediction_id,
                gold_snapshot["snapshot_id"] if gold_snapshot else None,
                feature_snapshot["snapshot_id"] if feature_snapshot else None,
                gold_snapshot["observed_at"] if gold_snapshot else None,
                feature_snapshot["feature_cutoff_at"] if feature_snapshot else None,
                prediction_created_at,
                status,
                error_code,
                _now(),
            ),
        )


def _prediction_context(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("factor_snapshot_json") or "{}"
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    context = payload.get("prediction_context") or payload.get("context") or {}
    return context if isinstance(context, dict) else {}


def _mark_expired_incomplete_pairs(db: Database, now: datetime) -> int:
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT f.fixture_id,f.prediction_id,p.locked_at,p.factor_snapshot_json
               FROM fixtures f JOIN predictions p ON p.prediction_id=f.prediction_id
               WHERE julianday(f.scheduled_at)<=julianday(?)
                 AND NOT EXISTS(SELECT 1 FROM challenger_predictions c WHERE c.fixture_id=f.fixture_id)""",
            (now.isoformat(),),
        ).fetchall()
    for raw in rows:
        row = dict(raw)
        context = _prediction_context(row)
        gold = None
        gold_id = context.get("gold_snapshot_id")
        if gold_id:
            with db.connect() as conn:
                found = conn.execute(
                    "SELECT snapshot_id,observed_at FROM prospective_snapshots WHERE snapshot_id=?",
                    (gold_id,),
                ).fetchone()
            gold = dict(found) if found else None
        _pair_status(
            db,
            row["fixture_id"],
            status="C1_MISSING_PREMATCH_FREEZE",
            champion_prediction_id=row["prediction_id"],
            gold_snapshot=gold,
            feature_snapshot=None,
            prediction_created_at=row["locked_at"],
            error_code="C1_MISSING_PREMATCH_FREEZE",
        )
    return len(rows)


def _lock_ready_predictions(
    db: Database,
    now: datetime,
    horizon_hours: int,
    *,
    max_fixture_age_hours: int = 12,
) -> dict[str, Any]:
    horizon = (now + timedelta(hours=horizon_hours)).isoformat()
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT * FROM fixtures
               WHERE status='scheduled' AND quality_status IN ('ready','locked')
                 AND julianday(scheduled_at) > julianday(?)
                 AND julianday(scheduled_at) <= julianday(?)
                 AND (prediction_id IS NULL OR NOT EXISTS(
                       SELECT 1 FROM challenger_predictions c WHERE c.fixture_id=fixtures.fixture_id))
               ORDER BY julianday(scheduled_at), fixture_id""",
            (now.isoformat(), horizon),
        ).fetchall()
    locked = 0
    failed = 0
    stale = 0
    shadow_frozen = 0
    shadow_failures = 0
    shadow_error_codes: list[str] = []
    recovered = 0
    pair_incomplete = 0
    expired_incomplete = _mark_expired_incomplete_pairs(db, now)
    try:
        shadow_model: FrozenLogisticC1 | None = FrozenLogisticC1()
    except Exception as exc:
        shadow_model = None
        shadow_error_codes.append(f"artifact_load:{type(exc).__name__}:{exc}"[:256])
    for raw in rows:
        fixture = dict(raw)
        existing_champion = None
        fetched_at = datetime.fromisoformat(fixture["fetched_at"].replace("Z", "+00:00"))
        if fixture.get("prediction_id") is None and now - fetched_at > timedelta(hours=max_fixture_age_hours):
            stale += 1
            with db.connect() as conn:
                blockers = json.loads(fixture["blocker_json"] or "[]")
                blockers = list(dict.fromkeys([*blockers, "fixture_snapshot_stale"]))
                conn.execute(
                    "UPDATE fixtures SET quality_status='blocked', blocker_json=?, updated_at=? WHERE fixture_id=?",
                    (_json(blockers), _now(), fixture["fixture_id"]),
                )
            continue
        try:
            map_pool = json.loads(fixture["map_pool_json"])
            if fixture.get("prediction_id"):
                with db.connect() as conn:
                    row = conn.execute(
                        "SELECT * FROM predictions WHERE prediction_id=?",
                        (fixture["prediction_id"],),
                    ).fetchone()
                existing_champion = dict(row) if row else None
            prediction_created_at = existing_champion["locked_at"] if existing_champion else None
            context = _prediction_context(existing_champion or {})
            bound_gold_id = context.get("gold_snapshot_id") if existing_champion else None
            if existing_champion and not bound_gold_id:
                raise ValueError("legacy_pair_missing_gold_snapshot_reference")
            gold_snapshot = select_prematch_gold_snapshot(
                db,
                fixture,
                prediction_created_at or fixture["scheduled_at"],
                gold_snapshot_id=bound_gold_id,
            )
            shadow_snapshot = None
            if shadow_model is not None:
                try:
                    shadow_snapshot = create_feature_snapshot(
                        db,
                        fixture,
                        prediction_created_at or fixture["scheduled_at"],
                        gold_snapshot_id=gold_snapshot["snapshot_id"],
                    )
                except Exception as exc:
                    shadow_failures += 1
                    shadow_error_codes.append(f"snapshot:{type(exc).__name__}:{exc}"[:256])
            if existing_champion:
                result = existing_champion
            else:
                observed_at = datetime.fromisoformat(gold_snapshot["observed_at"].replace("Z", "+00:00"))
                freeze_at = max(now, observed_at)
                if freeze_at >= datetime.fromisoformat(fixture["scheduled_at"].replace("Z", "+00:00")):
                    raise ValueError("prediction_freeze_not_before_match")
                result = predict_match(
                    db,
                    team_a_id=fixture["team_a_id"],
                    team_b_id=fixture["team_b_id"],
                    scheduled_at=fixture["scheduled_at"],
                    event=fixture["event"],
                    region=fixture["region"],
                    patch=fixture["patch"],
                    series_format=fixture["series_format"],
                    map_pool=map_pool,
                    is_international=fixture["classification"] == "international",
                    source="system_auto" if is_primary(fixture["classification"]) else f"system_auto_{fixture['classification']}",
                    locked_at=freeze_at.isoformat(),
                    fixture_id=fixture["fixture_id"],
                    lock_policy="unattended_causal_pair_v1.4c-r1",
                    prediction_context={
                        "automatic": True,
                        "source_url": fixture["source_url"],
                        "source_fetched_at": fixture["fetched_at"],
                        "map_pool_provenance": fixture["map_pool_provenance"],
                        "patch_provenance": fixture["patch_provenance"],
                        "quality_gate": "ready",
                        "competition_classification": fixture["classification"],
                        "evaluation_cohort": "primary_vct" if is_primary(fixture["classification"]) else fixture["classification"],
                        "gold_snapshot_id": gold_snapshot["snapshot_id"],
                        "gold_snapshot_observed_at": gold_snapshot["observed_at"],
                        "feature_cutoff_at": shadow_snapshot["feature_cutoff_at"] if shadow_snapshot else gold_snapshot["observed_at"],
                        "shared_prematch_snapshot_id": shadow_snapshot["snapshot_id"] if shadow_snapshot else None,
                        "shared_prematch_snapshot_hash": shadow_snapshot["content_hash"] if shadow_snapshot else None,
                    },
                    persist=True,
                )
            if shadow_model is not None and shadow_snapshot is not None:
                try:
                    freeze_shadow_prediction(db, fixture, result, shadow_snapshot, shadow_model)
                    shadow_frozen += 1
                    recovered += int(existing_champion is not None)
                    _pair_status(
                        db,
                        fixture["fixture_id"],
                        status="PAIRED",
                        champion_prediction_id=result["prediction_id"],
                        gold_snapshot=gold_snapshot,
                        feature_snapshot=shadow_snapshot,
                        prediction_created_at=result["locked_at"],
                    )
                except Exception as exc:
                    shadow_failures += 1
                    shadow_error_codes.append(f"freeze:{type(exc).__name__}:{exc}"[:256])
                    pair_incomplete += 1
                    _pair_status(
                        db,
                        fixture["fixture_id"],
                        status="PAIR_INCOMPLETE",
                        champion_prediction_id=result["prediction_id"],
                        gold_snapshot=gold_snapshot,
                        feature_snapshot=shadow_snapshot,
                        prediction_created_at=result["locked_at"],
                        error_code=f"freeze:{type(exc).__name__}"[:256],
                    )
            else:
                pair_incomplete += 1
                _pair_status(
                    db,
                    fixture["fixture_id"],
                    status="PAIR_INCOMPLETE",
                    champion_prediction_id=result["prediction_id"],
                    gold_snapshot=gold_snapshot,
                    feature_snapshot=shadow_snapshot,
                    prediction_created_at=result["locked_at"],
                    error_code="c1_artifact_or_feature_unavailable",
                )
            with db.connect() as conn:
                conn.execute(
                    "UPDATE fixtures SET prediction_id=?, quality_status='locked', updated_at=? WHERE fixture_id=?",
                    (result["prediction_id"], _now(), fixture["fixture_id"]),
                )
                conn.execute(
                    "UPDATE prospective_snapshots SET prediction_id=? WHERE fixture_id=? AND prediction_id IS NULL",
                    (result["prediction_id"], fixture["fixture_id"]),
                )
            locked += int(existing_champion is None)
        except Exception as exc:
            failed += 1
            error_code = f"prediction_error:{exc}"
            if existing_champion:
                pair_incomplete += 1
                _pair_status(
                    db,
                    fixture["fixture_id"],
                    status="PAIR_INCOMPLETE",
                    champion_prediction_id=existing_champion["prediction_id"],
                    gold_snapshot=None,
                    feature_snapshot=None,
                    prediction_created_at=existing_champion["locked_at"],
                    error_code=error_code[:256],
                )
            else:
                with db.connect() as conn:
                    blockers = json.loads(fixture["blocker_json"] or "[]")
                    blockers = list(dict.fromkeys([*blockers, error_code[:256]]))
                    conn.execute(
                        "UPDATE fixtures SET quality_status='blocked', blocker_json=?, updated_at=? WHERE fixture_id=?",
                        (_json(blockers), _now(), fixture["fixture_id"]),
                    )
    return {
        "predictions_locked": locked,
        "prediction_failures": failed,
        "stale_fixtures": stale,
        "challenger_predictions_frozen": shadow_frozen,
        "challenger_prediction_failures": shadow_failures,
        "challenger_pairs_recovered": recovered,
        "challenger_pairs_incomplete": pair_incomplete,
        "challenger_pairs_expired": expired_incomplete,
        "challenger_error_codes": shadow_error_codes[:20],
    }


def run_daily_automation(
    db: Database,
    raw_root: str | Path,
    *,
    horizon_hours: int = 48,
    trigger_type: str = "cli",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run the complete unattended V1.1 loop in one idempotent operation."""
    db.initialize()
    _register_source(db)
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    run_id = _start_run(db, "daily_full", trigger_type)
    counters: dict[str, Any] = {
        "coverage_schema_version": COVERAGE_VERSION,
        "events_scanned": 0,
        "fixtures_seen": 0,
        "fixtures_ready": 0,
        "fixtures_blocked": 0,
        "gold_snapshots_recorded": 0,
        "results_found": 0,
        "results_inserted": 0,
        "event_failures": 0,
        "fixture_failures": 0,
        "request_retries": 0,
        "used_cached_fixtures": False,
        "phases": {},
    }
    client = VlrClient(raw_root)
    errors: list[str] = []
    try:
        try:
            discovered = client.discover_live_events(now)
            counters["phases"]["discovery"] = {"status": "completed", "events": len(discovered)}
            counters["coverage"] = client.discovery_report
            if client.discovery_report.get("index_failures"):
                errors.append("部分赛事索引读取失败；覆盖仅为已验证来源，不视为全球无赛")
                counters["phases"]["discovery"]["status"] = "partial"
        except Exception as exc:
            discovered = []
            counters["used_cached_fixtures"] = True
            counters["phases"]["discovery"] = {"status": "failed", "error": str(exc)}
            errors.append(f"赛事发现失败：{exc}")
        # Watch all source classes; only recognized classes may reach the quality gate.
        # Existing unresolved fixtures also retain their result-recovery event path.
        with db.connect() as conn:
            pending = [dict(r) for r in conn.execute("""SELECT DISTINCT external_event_id,event,region,classification
                FROM fixtures WHERE status IN ('scheduled','result_pending') AND completed_match_id IS NULL""").fetchall()]
            known_fixture_ids = {r[0] for r in conn.execute("SELECT external_match_id FROM fixtures").fetchall()}
            known_fixture_times = {r[0]:r[1] for r in conn.execute("""SELECT external_match_id,scheduled_at
                FROM fixtures WHERE status IN ('scheduled','result_pending') AND completed_match_id IS NULL""").fetchall()}
            for event in discovered:
                conn.execute("""INSERT INTO event_catalog(source_id,external_event_id,name,region,classification,status,source_url,included,fetched_at)
                    VALUES('vlr',?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_event_id) DO UPDATE SET
                    name=excluded.name,region=excluded.region,classification=excluded.classification,status=excluded.status,
                    source_url=excluded.source_url,included=excluded.included,fetched_at=excluded.fetched_at""",
                    (event["external_event_id"],event["name"],event["region"],event["classification"],event["status"],event["source_url"],int(event["included"]),event["fetched_at"]))
        selected = [event for event in discovered if event.get("scan_matches")]
        selected_ids = {event["external_event_id"] for event in selected}
        for row in pending:
            if row["external_event_id"] not in selected_ids:
                selected.append({"external_event_id":row["external_event_id"],"slug":"pending-result","name":row["event"],
                    "region":row["region"],"classification":row["classification"],"included":can_predict(row["classification"],row["region"]),
                    "status":"known_pending","scan_matches":True})
                selected_ids.add(row["external_event_id"])
        # Existing result recovery and primary fixtures must not sit behind an
        # unrelated qualifier's large match list in the same region.
        pending_event_ids = {row["external_event_id"] for row in pending}
        selected.sort(key=lambda event: (
            event["region"] != "CN",
            not is_primary(event["classification"]),
            event["external_event_id"] not in pending_event_ids,
        ))
        counters["events_scanned"] = len(selected)
        counters["events_observed"] = len(discovered)
        counters["events_by_region"] = {region:sum(e["region"]==region for e in discovered) for region in ("CN","EMEA","AMERICAS","PACIFIC","INTERNATIONAL","OTHER")}
        counters["events_by_competition"] = {kind:sum(e["classification"]==kind for e in discovered) for kind in sorted({e["classification"] for e in discovered})}
        counters["fixtures_observed_only"] = 0
        counters["detail_budget_deferred"] = 0
        detail_reads = 0
        region_detail_reads: dict[str, int] = {}
        seen_external_ids: set[str] = set()
        with db.connect() as conn:
            known_matches = {
                row[0] for row in conn.execute(
                    "SELECT external_id FROM source_records WHERE source_id='vlr' AND entity_type='match'"
                ).fetchall()
            }
        parsed_fixtures: list[dict[str, Any]] = []
        completed: list[dict[str, Any]] = []
        issues: list[dict[str, Any]] = []
        for event in selected:
            try:
                links, list_result = client.event_match_links(event)
            except Exception as exc:
                counters["event_failures"] += 1
                errors.append(f"赛事页面失败 {event['name']}：{exc}")
                continue
            event["match_list_raw_path"] = list_result.raw_path
            event["match_list_hash"] = list_result.content_hash
            # A busy qualifier must not consume the other regions' detail budget.
            links = _ordered_fixture_links(links, known_fixture_times, now, horizon_hours)
            for href in links:
                external_id = _external_id(href)
                if not external_id or external_id in known_matches or external_id in seen_external_ids:
                    continue
                seen_external_ids.add(external_id)
                observation = client.link_observations.get(href,{})
                reason = None
                if not event["included"]:
                    reason = "competition_observe_only"
                elif not is_primary(event["classification"]) and external_id not in known_fixture_ids and observation.get("source_status") in {"completed","final"}:
                    reason = "completed_without_prior_fixture"
                elif observation.get("unresolved_teams"):
                    reason = "teams_unresolved_or_tbd"
                elif detail_reads >= 120 or region_detail_reads.get(event["region"],0) >= 24:
                    reason = "detail_budget_deferred"
                    counters["detail_budget_deferred"] += 1
                if reason:
                    _record_fixture_watch(db,external_id,event,observation or {"source_url":BASE_URL+href,"content_hash":list_result.content_hash,
                        "fetched_at":list_result.fetched_at,"raw_path":list_result.raw_path},reason)
                    counters["fixtures_observed_only"] += 1
                    continue
                detail_reads += 1
                region_detail_reads[event["region"]] = region_detail_reads.get(event["region"],0) + 1
                try:
                    fixture, issue = client.parse_fixture(href, event)
                except Exception as exc:
                    counters["fixture_failures"] += 1
                    issues.append({"external_id": external_id, "event": event["name"], "reason": str(exc)})
                    _record_fixture_watch(db,external_id,event,observation or {"source_url":BASE_URL+href,
                        "content_hash":list_result.content_hash,"fetched_at":list_result.fetched_at,"raw_path":list_result.raw_path},"fixture_parse_failed")
                    counters["fixtures_observed_only"] += 1
                    continue
                if not fixture:
                    issues.append({**issue, "event": event["name"]})
                    _record_fixture_watch(db,external_id,event,issue,issue.get("reason","fixture_information_missing"))
                    counters["fixtures_observed_only"] += 1
                    continue
                if fixture["status"] == "scheduled":
                    parsed_fixtures.append(fixture)
                    continue
                if not is_primary(event["classification"]) and external_id not in known_fixture_ids:
                    # Discovery expansion is not permission to backfill past secondary games.
                    _record_fixture_watch(db,external_id,event,issue,"completed_without_prior_fixture")
                    counters["fixtures_observed_only"] += 1
                    continue
                try:
                    result, result_issue = client.parse_match(href, event)
                except Exception as exc:
                    counters["fixture_failures"] += 1
                    issues.append({"external_id": external_id, "event": event["name"], "reason": str(exc)})
                    continue
                if result:
                    confirmed, confirmation_status = observe_result_candidate(db, result, result.get("fetched_at"))
                    if confirmed:
                        result["result_finality_status"] = "FINAL_CONFIRMED"
                        completed.append(result)
                        known_matches.add(external_id)
                    else:
                        issues.append({**result_issue, "event": event["name"], "reason": confirmation_status, "external_id": external_id})
                else:
                    issues.append({**result_issue, "event": event["name"]})
        counters["fixtures_seen"] = len(parsed_fixtures)
        counters["results_found"] = len(completed)
        counters["fixture_detail_reads"] = detail_reads
        counters["fixture_detail_reads_by_region"] = region_detail_reads
        if counters["detail_budget_deferred"]:
            errors.append("赛事详情达到本轮安全预算，部分关注比赛等待下一轮；覆盖不完整")
        counters["phases"]["source_scan"] = {
            "status": "partial" if counters["event_failures"] or counters["fixture_failures"] else "completed",
            "events": len(selected),
            "fixtures": len(parsed_fixtures),
            "results": len(completed),
        }
        if completed:
            collection = {
                "source": SOURCE,
                "scope": {"mode": "daily_live", "year": now.year},
                "collected_at": _now(),
                "events": selected,
                "matches": sorted(completed, key=lambda item: (item["played_at"], item["match_id"])),
                "issues": issues,
            }
            try:
                imported = import_collection(db, collection, snapshot_root=raw_root)
                counters["results_inserted"] = imported["records_inserted"]
                counters["result_conflicts"] = imported["conflicts"]
                counters["phases"]["result_import"] = {"status": "completed", **imported}
            except Exception as exc:
                errors.append(f"赛果导入失败：{exc}")
                counters["phases"]["result_import"] = {"status": "failed", "error": str(exc)}
        else:
            counters["phases"]["result_import"] = {"status": "completed", "records_inserted": 0}
        for fixture in parsed_fixtures:
            try:
                status, blockers = _upsert_fixture(db, fixture, now)
                if _record_prospective_snapshot(db, fixture, status, blockers, now):
                    counters["gold_snapshots_recorded"] += 1
                if status == "ready":
                    counters["fixtures_ready"] += 1
                else:
                    counters["fixtures_blocked"] += 1
            except Exception as exc:
                counters["fixture_failures"] += 1
                errors.append(f"赛程保存失败 {fixture.get('external_match_id')}：{exc}")
        counters["phases"]["fixture_upsert"] = {
            "status": "partial" if counters["fixture_failures"] else "completed",
            "ready": counters["fixtures_ready"],
            "blocked": counters["fixtures_blocked"],
        }
        with db.connect() as conn:
            for result in completed:
                conn.execute(
                    """UPDATE fixtures SET status='completed', completed_match_id=?, updated_at=?
                       WHERE source_id='vlr' AND external_match_id=?
                         AND EXISTS(SELECT 1 FROM matches WHERE match_id=?)""",
                    (result["match_id"], _now(), result["external_match_id"], result["match_id"]),
                )
                conn.execute(
                    """UPDATE prospective_snapshots
                       SET outcome_status='resolved', resolved_match_id=?
                       WHERE fixture_id IN (
                         SELECT fixture_id FROM fixtures WHERE source_id='vlr' AND external_match_id=?
                       )""",
                    (result["match_id"], result["external_match_id"]),
                )
        counters.update(_lock_ready_predictions(db, now, horizon_hours))
        counters["phases"]["prediction_lock"] = {
            "status": "completed" if not counters["prediction_failures"] else "partial",
            "locked": counters["predictions_locked"],
            "stale": counters["stale_fixtures"],
        }
        try:
            review_result = refresh_prediction_reviews(db)
            counters.update(review_result)
            counters["phases"]["prediction_review"] = {"status": "completed", **review_result}
        except Exception as exc:
            errors.append(f"预测复盘生成失败：{exc}")
            counters["phases"]["prediction_review"] = {"status": "failed", "error": str(exc)}
        try:
            settlement = settle_shadow_predictions(db)
            counters.update(settlement)
            counters["challenger_evaluation"] = prospective_metrics(db)
            counters["blocker_coverage"] = blocker_coverage(db)
            counters["phases"]["challenger_settlement"] = {"status": "completed", **settlement}
        except Exception as exc:
            errors.append(f"Challenger 独立结算失败：{exc}")
            counters["phases"]["challenger_settlement"] = {"status": "failed", "error": str(exc)}
        counters["request_retries"] = client.retry_count
        counters["retry_log"] = client.retry_log[-20:]
        counters.update(_prospective_stats(db))
        counters["fixtures_by_competition"] = _competition_coverage(db)
        status = "partial" if errors or counters["event_failures"] or counters["fixture_failures"] else "completed"
        error_text = "\n".join(errors) if errors else None
        _finish_run(db, run_id, status, counters, error_text)
        return {"ok": status == "completed", "status": status, "run_id": run_id, "errors": errors, **counters}
    except Exception as exc:
        _finish_run(db, run_id, "failed", counters, str(exc))
        raise
    finally:
        client.close()


def today_predictions(db: Database, *, hours: int = 48) -> dict[str, Any]:
    db.initialize()
    now = datetime.now(timezone.utc)
    horizon = (now + timedelta(hours=hours)).isoformat()
    with db.connect() as conn:
        fixtures = [dict(row) for row in conn.execute(
            """SELECT f.*, p.team_a_win_probability, p.team_b_win_probability,
                      p.predicted_winner_id, p.predicted_score, p.score_distribution_json,
                      p.locked_at, p.model_version, p.source AS prediction_source,
                      ta.name AS predicted_winner_name
               FROM fixtures f
               LEFT JOIN predictions p ON p.prediction_id=f.prediction_id
               LEFT JOIN teams ta ON ta.team_id=p.predicted_winner_id
               WHERE julianday(f.scheduled_at) >= julianday('now', '-6 hours')
                 AND julianday(f.scheduled_at) <= julianday(?)
               ORDER BY julianday(f.scheduled_at), f.fixture_id""",
            (horizon,),
        ).fetchall()]
        runs = [dict(row) for row in conn.execute(
            """SELECT run_id, run_type, trigger_type, started_at, completed_at,
                      status, counters_json, error, model_version
               FROM automation_runs ORDER BY julianday(started_at) DESC LIMIT 10"""
        ).fetchall()]
    for fixture in fixtures:
        fixture["map_pool"] = [MAPS.get(item, item) for item in json.loads(fixture.pop("map_pool_json"))]
        fixture["blockers"] = json.loads(fixture.pop("blocker_json"))
        fixture["score_distribution"] = (
            json.loads(fixture.pop("score_distribution_json"))
            if fixture.get("score_distribution_json") else None
        )
    for run in runs:
        run["counters"] = json.loads(run.pop("counters_json"))
    return {
        "generated_at": _now(),
        "window_hours": hours,
        "fixtures": fixtures,
        "runs": runs,
        "health": automation_health(db),
        "policy": {
            "mode": "unattended",
            "lock": "hard_gate_then_lock_without_manual_review",
            "model_weights": "v1.0.0_frozen",
            "minimum_team_history": 3,
            "source_boundary": "VLR community pages with raw snapshot and hash",
        },
    }


def automation_health(db: Database, *, expected_interval_hours: int = 24) -> dict[str, Any]:
    db.initialize()
    now = datetime.now(timezone.utc)
    with db.connect() as conn:
        rows = [dict(row) for row in conn.execute(
            """SELECT run_id, started_at, completed_at, status, trigger_type, error, counters_json
               FROM automation_runs ORDER BY julianday(started_at) DESC LIMIT 24"""
        ).fetchall()]
        newest_fixture = conn.execute("SELECT MAX(fetched_at) FROM fixtures").fetchone()[0]
    last_success = next((row for row in rows if row["status"] == "completed"), None)
    last_failure = next((row for row in rows if row["status"] in {"failed", "partial"}), None)
    consecutive_successes = 0
    consecutive_failures = 0
    for row in rows:
        if row["status"] == "completed" and consecutive_failures == 0:
            consecutive_successes += 1
        elif row["status"] in {"failed", "partial"} and consecutive_successes == 0:
            consecutive_failures += 1
        else:
            break
    latest = rows[0] if rows else None
    last_started = datetime.fromisoformat(latest["started_at"].replace("Z", "+00:00")) if latest else None
    age_hours = (now - last_started).total_seconds() / 3600 if last_started else None
    next_expected = last_started + timedelta(hours=expected_interval_hours) if last_started else None
    fixture_time = datetime.fromisoformat(newest_fixture.replace("Z", "+00:00")) if newest_fixture else None
    fixture_age = (now - fixture_time).total_seconds() / 3600 if fixture_time else None
    if not latest:
        status = "not_started"
    elif latest["status"] == "running":
        status = "running"
    elif age_hours is not None and age_hours > expected_interval_hours * 2:
        status = "stale"
    elif latest["status"] == "failed":
        status = "failed"
    elif latest["status"] == "partial":
        status = "degraded"
    else:
        status = "healthy"
    for row in rows:
        row["counters"] = json.loads(row.pop("counters_json"))
    completed_count = sum(row["status"] == "completed" for row in rows)
    return {
        "status": status,
        "checked_at": now.isoformat(),
        "last_run": latest,
        "last_success": last_success,
        "last_failure": last_failure,
        "consecutive_successes": consecutive_successes,
        "consecutive_failures": consecutive_failures,
        "success_rate_24_runs": round(completed_count / len(rows), 4) if rows else None,
        "run_age_hours": round(age_hours, 2) if age_hours is not None else None,
        "next_expected_at": next_expected.isoformat() if next_expected else None,
        "fixture_snapshot_age_hours": round(fixture_age, 2) if fixture_age is not None else None,
        "fixture_snapshot_fresh": fixture_age is not None and fixture_age <= 12,
        "expected_interval_hours": expected_interval_hours,
    }
