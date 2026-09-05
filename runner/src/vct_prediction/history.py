"""Import prior human predictions without inventing exact lock timestamps."""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import Database


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", value.lower())


def import_prediction_archive(db: Database, path: str | Path) -> dict[str, Any]:
    db.initialize()
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    source_ref = payload["source_ref"]
    imported = 0
    unmatched: list[dict[str, Any]] = []
    duplicates = 0
    with db.connect() as conn:
        teams = [dict(row) for row in conn.execute("SELECT team_id, name FROM teams")]
    by_name = {_norm(team["name"]): team for team in teams}

    def resolve_team(candidates: list[str]) -> dict[str, Any] | None:
        for candidate in candidates:
            exact = by_name.get(_norm(candidate))
            if exact:
                return exact
        candidate_keys = [_norm(item) for item in candidates]
        for team in teams:
            key = _norm(team["name"])
            if any(candidate in key or key in candidate for candidate in candidate_keys):
                return team
        return None

    for item in payload["predictions"]:
        team_a = resolve_team(item["team_a"])
        team_b = resolve_team(item["team_b"])
        if not team_a or not team_b:
            unmatched.append({"key": item["key"], "reason": "team_not_found"})
            continue
        with db.connect() as conn:
            match = conn.execute(
                """SELECT * FROM matches
                   WHERE ((team_a_id=? AND team_b_id=?) OR (team_a_id=? AND team_b_id=?))
                     AND julianday(played_at) >= julianday(?)
                   ORDER BY julianday(played_at) ASC LIMIT 1""",
                (
                    team_a["team_id"], team_b["team_id"], team_b["team_id"],
                    team_a["team_id"], item["not_before"],
                ),
            ).fetchone()
        if not match:
            unmatched.append({"key": item["key"], "reason": "completed_match_not_found"})
            continue
        match = dict(match)
        source_prediction_id = f"archive:{item['key']}"
        with db.connect() as conn:
            if conn.execute("SELECT 1 FROM predictions WHERE prediction_id=?", (source_prediction_id,)).fetchone():
                duplicates += 1
                continue
            pair_reversed = match["team_a_id"] != team_a["team_id"]
            probability_a = 1.0 - float(item["probability_a"]) if pair_reversed else float(item["probability_a"])
            predicted_score = item["predicted_score"]
            if pair_reversed:
                left, right = predicted_score.split("-", 1)
                predicted_score = f"{right}-{left}"
            predicted_winner = match["team_a_id"] if probability_a >= 0.5 else match["team_b_id"]
            actual_score = f"{match['team_a_maps']}-{match['team_b_maps']}"
            conn.execute(
                """INSERT INTO predictions(
                       prediction_id, source, model_version, locked_at, scheduled_at,
                       event, region, patch, series_format, team_a_id, team_b_id,
                       predicted_winner_id, team_a_win_probability, team_b_win_probability,
                       predicted_score, score_distribution_json, map_probabilities_json,
                       factor_snapshot_json, bp_plan_json, status, actual_winner_id,
                       actual_score, resolved_match_id
                   ) VALUES(?, 'human_archive', 'human-conversation-2026', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, '{}', 'resolved', ?, ?, ?)""",
                (
                    source_prediction_id, match["played_at"], match["played_at"], match["event"],
                    match["region"], match["patch"], match["series_format"], match["team_a_id"],
                    match["team_b_id"], predicted_winner, probability_a, 1.0 - probability_a,
                    predicted_score,
                    json.dumps({
                        "archive_key": item["key"],
                        "transcript_excerpt": item["excerpt"],
                        "lock_time_method": "upper_bound_match_start",
                    }, ensure_ascii=False),
                    match["winner_id"], actual_score, match["match_id"],
                ),
            )
            conn.execute(
                """INSERT INTO prediction_provenance(
                       prediction_id, source_ref, lock_order_verified,
                       exact_lock_time_verified, imported_at, transcript_excerpt,
                       evaluation_eligible, note
                   ) VALUES(?, ?, 1, 0, ?, ?, 1, ?)""",
                (
                    source_prediction_id, source_ref, _now(), item["excerpt"],
                    payload["timestamp_policy"],
                ),
            )
        imported += 1
    return {"imported": imported, "duplicates": duplicates, "unmatched": unmatched}
