"""Auditable import pipeline for real VCT match data."""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import Database
from .ingest import process_pending, record_match
from .math_utils import clamp


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def save_collection(collection: dict[str, Any], output_root: str | Path) -> dict[str, str]:
    root = Path(output_root)
    root.mkdir(parents=True, exist_ok=True)
    events_path = root / "events.json"
    matches_path = root / "matches.jsonl"
    issues_path = root / "issues.json"
    manifest_path = root / "manifest.json"
    events_path.write_text(json.dumps(collection["events"], ensure_ascii=False, indent=2), encoding="utf-8")
    with matches_path.open("w", encoding="utf-8") as handle:
        for record in collection["matches"]:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    issues_path.write_text(json.dumps(collection["issues"], ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = {
        "source": collection["source"],
        "scope": collection["scope"],
        "collected_at": collection["collected_at"],
        "events": len(collection["events"]),
        "matches": len(collection["matches"]),
        "issues": len(collection["issues"]),
        "matches_checksum": _checksum(collection["matches"]),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "root": str(root),
        "manifest": str(manifest_path),
        "events": str(events_path),
        "matches": str(matches_path),
        "issues": str(issues_path),
    }


def load_collection(root: str | Path) -> dict[str, Any]:
    base = Path(root)
    manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    events = json.loads((base / "events.json").read_text(encoding="utf-8"))
    issues = json.loads((base / "issues.json").read_text(encoding="utf-8"))
    matches = [
        json.loads(line)
        for line in (base / "matches.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if _checksum(matches) != manifest["matches_checksum"]:
        raise ValueError("标准化比赛快照校验失败")
    return {
        "source": manifest["source"],
        "scope": manifest["scope"],
        "collected_at": manifest["collected_at"],
        "events": events,
        "matches": matches,
        "issues": issues,
    }


def _team_regions(matches: list[dict[str, Any]]) -> dict[str, str]:
    counters: dict[str, Counter[str]] = defaultdict(Counter)
    for record in matches:
        if record["region"] in {"CN", "EMEA", "AMERICAS", "PACIFIC"}:
            counters[record["team_a_id"]][record["region"]] += 1
            counters[record["team_b_id"]][record["region"]] += 1
    return {
        team_id: values.most_common(1)[0][0]
        for team_id, values in counters.items()
        if values
    }


def _lineup(record: dict[str, Any], team_id: str) -> list[dict[str, str]]:
    counts: Counter[str] = Counter()
    names: dict[str, str] = {}
    for stat in record.get("player_stats", []):
        if stat["team_id"] != team_id:
            continue
        counts[stat["player_id"]] += 1
        names[stat["player_id"]] = stat["player_name"]
    return [
        {"player_id": player_id, "player_name": names[player_id]}
        for player_id, _ in counts.most_common(5)
    ]


def _roster_version(lineup: list[dict[str, str]]) -> str:
    fingerprint = ",".join(sorted(item["player_id"] for item in lineup))
    return "vlr-" + hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:10]


def _form_score(stats: list[dict[str, Any]]) -> tuple[float, float]:
    ratings = [item["rating"] for item in stats if item.get("rating") is not None]
    acs = [item["acs"] for item in stats if item.get("acs") is not None]
    adr = [item["adr"] for item in stats if item.get("adr") is not None]
    kills = sum(item.get("kills") or 0 for item in stats)
    deaths = sum(item.get("deaths") or 0 for item in stats)
    first_kills = sum(item.get("first_kills") or 0 for item in stats)
    first_deaths = sum(item.get("first_deaths") or 0 for item in stats)
    rating = sum(ratings) / len(ratings) if ratings else 1.0
    acs_value = sum(acs) / len(acs) if acs else 200.0
    adr_value = sum(adr) / len(adr) if adr else 130.0
    kd = kills / max(deaths, 1)
    score = (
        0.35 * math.tanh((rating - 1.0) / 0.25)
        + 0.25 * math.tanh((acs_value - 200.0) / 80.0)
        + 0.20 * math.tanh((kd - 1.0) / 0.50)
        + 0.10 * math.tanh((adr_value - 130.0) / 60.0)
        + 0.10 * math.tanh((first_kills - first_deaths) / 5.0)
    )
    reliability = clamp(0.25 + 0.25 * len(stats), 0.25, 1.0)
    return clamp(score, -1.0, 1.0), reliability


def _register_source(conn, source: dict[str, Any]) -> None:
    now = _now()
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
            source["source_id"], source["name"], source["base_url"], source["source_type"],
            source["authority_level"], source.get("terms_note"), now, now,
        ),
    )


def import_collection(
    db: Database,
    collection: dict[str, Any],
    *,
    snapshot_root: str | Path,
    batch_id: str | None = None,
    process: bool = True,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    db.initialize(config)
    batch_id = batch_id or f"vlr-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    source = collection["source"]
    source_id = source["source_id"]
    started_at = _now()
    with db.connect() as conn:
        _register_source(conn, source)
        conn.execute(
            """INSERT INTO import_batches(
                   batch_id, source_id, started_at, status, scope_json, snapshot_root
               ) VALUES(?, ?, ?, 'running', ?, ?)""",
            (batch_id, source_id, started_at, _json(collection["scope"]), str(snapshot_root)),
        )
        for event in collection["events"]:
            conn.execute(
                """INSERT INTO event_catalog(
                       source_id, external_event_id, name, region, classification,
                       status, source_url, included, fetched_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_id, external_event_id) DO UPDATE SET
                       name=excluded.name, region=excluded.region,
                       classification=excluded.classification, status=excluded.status,
                       source_url=excluded.source_url, included=excluded.included,
                       fetched_at=excluded.fetched_at""",
                (
                    source_id, event["external_event_id"], event["name"], event["region"],
                    event["classification"], event.get("status"), event["source_url"],
                    int(event["included"]), event["fetched_at"],
                ),
            )

    regions = _team_regions(collection["matches"])
    team_names: dict[str, str] = {}
    external_ids: dict[str, str] = {}
    for record in collection["matches"]:
        for team in record["teams"]:
            team_names[team["team_id"]] = team["name"]
            external_ids[team["team_id"]] = team["external_team_id"]
    with db.connect() as conn:
        now = _now()
        for team_id, name in sorted(team_names.items()):
            region = regions.get(team_id, "INTERNATIONAL")
            conn.execute(
                """INSERT INTO teams(team_id, name, region, updated_at)
                   VALUES(?, ?, ?, ?)
                   ON CONFLICT(team_id) DO UPDATE SET
                       name=excluded.name, region=excluded.region, updated_at=excluded.updated_at""",
                (team_id, name, region, now),
            )
            conn.execute(
                """INSERT INTO team_aliases(
                       source_id, external_team_id, canonical_team_id, alias,
                       first_seen_at, last_seen_at
                   ) VALUES(?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_id, external_team_id) DO UPDATE SET
                       canonical_team_id=excluded.canonical_team_id,
                       alias=excluded.alias, last_seen_at=excluded.last_seen_at""",
                (source_id, external_ids[team_id], team_id, name, now, now),
            )

    inserted = 0
    skipped = 0
    conflicts = 0
    current_lineups: dict[str, set[str]] = {}
    current_versions: dict[str, str] = {}
    current_player_team: dict[str, tuple[str, int]] = {}
    with db.connect() as conn:
        for row in conn.execute(
            """SELECT team_id, roster_version FROM teams WHERE roster_version <> 'unknown'"""
        ):
            current_versions[row["team_id"]] = row["roster_version"]
        for row in conn.execute(
            """SELECT membership_id, player_id, team_id FROM player_team_history
               WHERE effective_to IS NULL ORDER BY membership_id"""
        ):
            current_player_team[row["player_id"]] = (row["team_id"], row["membership_id"])
            current_lineups.setdefault(row["team_id"], set()).add(row["player_id"])

    for record in sorted(collection["matches"], key=lambda item: (item["played_at"], item["match_id"])):
        external_id = record["external_match_id"]
        with db.connect() as conn:
            existing_source = conn.execute(
                """SELECT content_hash, canonical_id FROM source_records
                   WHERE source_id=? AND entity_type='match' AND external_id=?""",
                (source_id, external_id),
            ).fetchone()
            existing_match = conn.execute(
                "SELECT match_id, processed FROM matches WHERE match_id=?",
                (record["match_id"],),
            ).fetchone()
            if existing_source and existing_source["content_hash"] == record["normalized_hash"] and existing_match:
                skipped += 1
                continue
            if existing_match:
                conflicts += 1
                conn.execute(
                    """INSERT INTO import_conflicts(
                           batch_id, entity_type, external_id, reason,
                           existing_json, incoming_json, created_at
                       ) VALUES(?, 'match', ?, 'processed_match_changed', ?, ?, ?)""",
                    (
                        batch_id, external_id, _json(dict(existing_match)),
                        _json(record), _now(),
                    ),
                )
                continue

        for team_key in ("team_a_id", "team_b_id"):
            team_id = record[team_key]
            lineup = _lineup(record, team_id)
            if not lineup:
                continue
            lineup_ids = {item["player_id"] for item in lineup}
            version = _roster_version(lineup)
            previous = current_lineups.get(team_id, set())
            changed_players = len(lineup_ids - previous) if previous else 0
            continuity = len(lineup_ids & previous) / max(len(lineup_ids), 1) if previous else 1.0
            if current_versions.get(team_id) != version:
                with db.connect() as conn:
                    conn.execute(
                        """INSERT OR IGNORE INTO roster_events(
                               team_id, effective_at, roster_version, changed_players, continuity, note
                           ) VALUES(?, ?, ?, ?, ?, ?)""",
                        (
                            team_id, record["played_at"], version, changed_players,
                            continuity, f"Observed match lineup from {record['source_url']}",
                        ),
                    )
                    conn.execute(
                        """UPDATE teams SET roster_version=?, roster_continuity=?, updated_at=?
                           WHERE team_id=?""",
                        (version, continuity, record["played_at"], team_id),
                    )
                current_versions[team_id] = version
            current_lineups[team_id] = lineup_ids
            record[f"{team_key.removesuffix('_id')}_roster_version"] = version
            for player in lineup:
                player_id = player["player_id"]
                with db.connect() as conn:
                    conn.execute(
                        """INSERT INTO players(player_id, name, team_id, active)
                           VALUES(?, ?, ?, 1)
                           ON CONFLICT(player_id) DO UPDATE SET
                               name=excluded.name, team_id=excluded.team_id, active=1""",
                        (player_id, player["player_name"], team_id),
                    )
                    current = current_player_team.get(player_id)
                    if not current or current[0] != team_id:
                        if current:
                            conn.execute(
                                "UPDATE player_team_history SET effective_to=? WHERE membership_id=?",
                                (record["played_at"], current[1]),
                            )
                        cursor = conn.execute(
                            """INSERT INTO player_team_history(
                                   player_id, team_id, effective_from, roster_version, source_url
                               ) VALUES(?, ?, ?, ?, ?)""",
                            (player_id, team_id, record["played_at"], version, record["source_url"]),
                        )
                        current_player_team[player_id] = (team_id, cursor.lastrowid)

        clean_record = {
            key: value for key, value in record.items()
            if key not in {
                "external_match_id", "event_id", "teams", "player_stats", "patch_provenance",
                "fetched_at", "raw_path", "content_hash", "normalized_hash", "map_pool_provenance",
            }
        }
        try:
            record_match(db, clean_record, process=False)
        except (ValueError, KeyError) as exc:
            conflicts += 1
            with db.connect() as conn:
                conn.execute(
                    """INSERT INTO import_conflicts(
                           batch_id, entity_type, external_id, reason, incoming_json, created_at
                       ) VALUES(?, 'match', ?, ?, ?, ?)""",
                    (batch_id, external_id, f"validation_error:{exc}", _json(record), _now()),
                )
            continue

        with db.connect() as conn:
            for stat in record.get("player_stats", []):
                conn.execute(
                    """INSERT OR REPLACE INTO match_player_stats(
                           match_id, map_order, player_id, player_name, team_id, agent,
                           rating, acs, kills, deaths, assists, kast, adr, hs_pct,
                           first_kills, first_deaths
                       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        stat["match_id"], stat["map_order"], stat["player_id"], stat["player_name"],
                        stat["team_id"], stat.get("agent"), stat.get("rating"), stat.get("acs"),
                        stat.get("kills"), stat.get("deaths"), stat.get("assists"), stat.get("kast"),
                        stat.get("adr"), stat.get("hs_pct"), stat.get("first_kills"), stat.get("first_deaths"),
                    ),
                )
            stats_by_player: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for stat in record.get("player_stats", []):
                stats_by_player[stat["player_id"]].append(stat)
            for player_id, stats in stats_by_player.items():
                form_score, reliability = _form_score(stats)
                conn.execute(
                    """INSERT INTO player_form_snapshots(
                           player_id, observed_at, form_score, reliability, note
                       ) VALUES(?, ?, ?, ?, ?)
                       ON CONFLICT(player_id, observed_at) DO UPDATE SET
                           form_score=excluded.form_score, reliability=excluded.reliability,
                           note=excluded.note""",
                    (
                        player_id, record["played_at"], form_score, reliability,
                        f"Derived from public series statistics: {record['source_url']}",
                    ),
                )
            conn.execute(
                """INSERT INTO source_records(
                       source_id, entity_type, external_id, canonical_id, source_url,
                       content_hash, fetched_at, batch_id, raw_path, data_quality
                   ) VALUES(?, 'match', ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    source_id, external_id, record["match_id"], record["source_url"],
                    record["normalized_hash"], record["fetched_at"], batch_id,
                    record["raw_path"], record["data_quality"],
                ),
            )
        if process:
            process_pending(db, match_id=record["match_id"])
        inserted += 1

    refresh_derived_team_factors(db)
    completed_at = _now()
    checksum = _checksum([record["normalized_hash"] for record in collection["matches"]])
    with db.connect() as conn:
        conn.execute(
            """UPDATE import_batches SET completed_at=?, status='completed',
                   records_seen=?, records_inserted=?, records_skipped=?, conflicts=?,
                   checksum=?, notes=? WHERE batch_id=?""",
            (
                completed_at, len(collection["matches"]), inserted, skipped, conflicts,
                checksum, f"Collector issues: {len(collection['issues'])}", batch_id,
            ),
        )
    return {
        "batch_id": batch_id,
        "status": "completed",
        "records_seen": len(collection["matches"]),
        "records_inserted": inserted,
        "records_skipped": skipped,
        "conflicts": conflicts,
        "collector_issues": len(collection["issues"]),
        "checksum": checksum,
    }


def refresh_derived_team_factors(db: Database) -> None:
    with db.connect() as conn:
        team_ids = [row[0] for row in conn.execute("SELECT team_id FROM teams")]
        for team_id in team_ids:
            rows = conn.execute(
                """SELECT m.series_format, m.is_international, m.winner_id,
                          rh.expected_score, rh.actual_quality_score, m.patch, m.played_at
                   FROM matches m
                   JOIN rating_history rh ON rh.match_id=m.match_id AND rh.team_id=?
                   WHERE m.processed=1 AND (m.team_a_id=? OR m.team_b_id=?)
                   ORDER BY julianday(m.played_at)""",
                (team_id, team_id, team_id),
            ).fetchall()
            def adaptability(series_format: str) -> float:
                subset = [row for row in rows if row["series_format"] == series_format]
                wins = sum(row["winner_id"] == team_id for row in subset)
                return (wins + 3.0) / (len(subset) + 6.0)
            international_matches = sum(int(row["is_international"]) for row in rows)
            international_experience = 1.0 - math.exp(-international_matches / 8.0)
            latest_patch = rows[-1]["patch"] if rows else None
            patch_rows = [row for row in rows[-8:] if row["patch"] == latest_patch]
            patch_residual = (
                sum(float(row["actual_quality_score"]) - float(row["expected_score"]) for row in patch_rows)
                / len(patch_rows)
                if patch_rows else 0.0
            )
            patch_fit = clamp(patch_residual * 2.0, -1.0, 1.0)
            forms = conn.execute(
                """SELECT s.form_score, s.reliability FROM player_form_snapshots s
                   JOIN player_team_history h ON h.player_id=s.player_id
                   WHERE h.team_id=? AND h.effective_to IS NULL
                     AND s.observed_at=(SELECT MAX(s2.observed_at)
                                       FROM player_form_snapshots s2
                                       WHERE s2.player_id=s.player_id)""",
                (team_id,),
            ).fetchall()
            total_reliability = sum(float(row["reliability"]) for row in forms)
            player_form = (
                sum(float(row["form_score"]) * float(row["reliability"]) for row in forms) / total_reliability
                if total_reliability else 0.0
            )
            conn.execute(
                """UPDATE teams SET player_form=?, patch_fit=?, international_experience=?,
                       bo3_adaptability=?, bo5_adaptability=?, last_patch=?, updated_at=?
                   WHERE team_id=?""",
                (
                    player_form, patch_fit, international_experience,
                    adaptability("bo3"), adaptability("bo5"), latest_patch, _now(), team_id,
                ),
            )


def dataset_summary(db: Database) -> dict[str, Any]:
    with db.connect() as conn:
        by_region = {
            row["region"]: row["n"]
            for row in conn.execute(
                "SELECT region, COUNT(*) AS n FROM matches GROUP BY region ORDER BY region"
            )
        }
        by_year = {
            str(row["year"]): row["n"]
            for row in conn.execute(
                """SELECT CAST(strftime('%Y', played_at) AS INTEGER) AS year, COUNT(*) AS n
                   FROM matches GROUP BY year ORDER BY year"""
            )
        }
        latest_batch = conn.execute(
            """SELECT * FROM import_batches ORDER BY julianday(started_at) DESC LIMIT 1"""
        ).fetchone()
        return {
            "teams": conn.execute("SELECT COUNT(*) FROM teams").fetchone()[0],
            "matches": conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0],
            "maps": conn.execute("SELECT COUNT(*) FROM map_results").fetchone()[0],
            "player_map_stats": conn.execute("SELECT COUNT(*) FROM match_player_stats").fetchone()[0],
            "player_form_snapshots": conn.execute("SELECT COUNT(*) FROM player_form_snapshots").fetchone()[0],
            "roster_events": conn.execute("SELECT COUNT(*) FROM roster_events").fetchone()[0],
            "open_conflicts": conn.execute("SELECT COUNT(*) FROM import_conflicts WHERE status='open'").fetchone()[0],
            "by_region": by_region,
            "by_year": by_year,
            "latest_batch": dict(latest_batch) if latest_batch else None,
        }
