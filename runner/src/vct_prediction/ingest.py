"""JSON/JSONL 数据录入、校验与赛后 Rating 更新。"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import MODEL_VERSION
from .constants import REGIONS, SERIES_FORMATS, normalize_map
from .db import Database
from .math_utils import parse_timestamp
from .ratings import process_match


def read_json(path: str | Path) -> Any:
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    records = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{path}:{line_number} 不是有效 JSON") from exc
    return records


def load_teams(db: Database, path: str | Path) -> int:
    payload = read_json(path)
    teams = payload["teams"] if isinstance(payload, dict) else payload
    now = datetime.now(timezone.utc).isoformat()
    count = 0
    with db.connect() as conn:
        for team in teams:
            region = team["region"].upper()
            if region not in REGIONS:
                raise ValueError(f"不支持的赛区：{region}")
            values = {
                "rating": 1500.0,
                "matches_played": 0,
                "roster_version": "unknown",
                "roster_continuity": 1.0,
                "player_form": 0.0,
                "patch_fit": 0.0,
                "international_experience": 0.5,
                "bo3_adaptability": 0.5,
                "bo5_adaptability": 0.5,
                "last_patch": None,
                **team,
            }
            conn.execute(
                """INSERT INTO teams(
                       team_id, name, region, rating, matches_played, roster_version,
                       roster_continuity, player_form, patch_fit, international_experience,
                       bo3_adaptability, bo5_adaptability, last_patch, updated_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(team_id) DO UPDATE SET
                       name=excluded.name, region=excluded.region,
                       roster_version=excluded.roster_version,
                       roster_continuity=excluded.roster_continuity,
                       player_form=excluded.player_form, patch_fit=excluded.patch_fit,
                       international_experience=excluded.international_experience,
                       bo3_adaptability=excluded.bo3_adaptability,
                       bo5_adaptability=excluded.bo5_adaptability,
                       updated_at=excluded.updated_at""",
                (
                    values["team_id"], values["name"], region, values["rating"], values["matches_played"],
                    values["roster_version"], values["roster_continuity"], values["player_form"],
                    values["patch_fit"], values["international_experience"], values["bo3_adaptability"],
                    values["bo5_adaptability"], values["last_patch"], now,
                ),
            )
            count += 1
    return count


def validate_match(record: dict[str, Any]) -> dict[str, Any]:
    required = {"match_id", "event", "region", "played_at", "series_format", "team_a_id", "team_b_id", "maps"}
    missing = required - record.keys()
    if missing:
        raise ValueError(f"比赛缺少字段：{', '.join(sorted(missing))}")
    if record["series_format"] not in SERIES_FORMATS:
        raise ValueError("series_format 必须为 bo3 或 bo5")
    parse_timestamp(record["played_at"], "played_at")
    maps = []
    for index, item in enumerate(record["maps"], 1):
        a_rounds = int(item["team_a_rounds"])
        b_rounds = int(item["team_b_rounds"])
        if a_rounds == b_rounds or min(a_rounds, b_rounds) < 0:
            raise ValueError(f"第 {index} 张地图回合比分无效")
        maps.append({
            "map_order": index,
            "map_id": normalize_map(item["map"]),
            "team_a_rounds": a_rounds,
            "team_b_rounds": b_rounds,
        })
    a_maps = sum(item["team_a_rounds"] > item["team_b_rounds"] for item in maps)
    b_maps = len(maps) - a_maps
    wins_needed = SERIES_FORMATS[record["series_format"]]
    if max(a_maps, b_maps) != wins_needed:
        raise ValueError(f"地图结果不是完整的 {record['series_format'].upper()} 系列赛")
    winner_id = record["team_a_id"] if a_maps > b_maps else record["team_b_id"]
    if record.get("winner_id") and record["winner_id"] != winner_id:
        raise ValueError("winner_id 与地图比分不一致")
    return {**record, "maps": maps, "team_a_maps": a_maps, "team_b_maps": b_maps, "winner_id": winner_id}


def record_match(db: Database, record: dict[str, Any], *, process: bool = False) -> dict[str, Any]:
    clean = validate_match(record)
    now = datetime.now(timezone.utc).isoformat()
    team_a = db.fetch_team(clean["team_a_id"])
    team_b = db.fetch_team(clean["team_b_id"])
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO matches(
                   match_id, event, region, stage, played_at, patch, series_format,
                   team_a_id, team_b_id, winner_id, team_a_maps, team_b_maps,
                   is_international, importance, team_a_roster_version,
                   team_b_roster_version, source_url, data_quality, processed, inserted_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                clean["match_id"], clean["event"], clean["region"], clean.get("stage"), clean["played_at"],
                clean.get("patch"), clean["series_format"], clean["team_a_id"], clean["team_b_id"],
                clean["winner_id"], clean["team_a_maps"], clean["team_b_maps"],
                int(bool(clean.get("is_international", False))), float(clean.get("importance", 1.0)),
                clean.get("team_a_roster_version", team_a["roster_version"]),
                clean.get("team_b_roster_version", team_b["roster_version"]),
                clean.get("source_url"), clean.get("data_quality", "verified_result"), now,
            ),
        )
        conn.executemany(
            "INSERT INTO map_results(match_id, map_order, map_id, team_a_rounds, team_b_rounds) VALUES(?, ?, ?, ?, ?)",
            [(clean["match_id"], item["map_order"], item["map_id"], item["team_a_rounds"], item["team_b_rounds"]) for item in clean["maps"]],
        )
    if process:
        process_pending(db, match_id=clean["match_id"])
    return clean


def process_pending(db: Database, match_id: str | None = None) -> list[dict[str, Any]]:
    config = db.config()
    processed = []
    with db.connect() as conn:
        if match_id:
            rows = conn.execute("SELECT * FROM matches WHERE processed=0 AND match_id=?", (match_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM matches WHERE processed=0 ORDER BY played_at, match_id").fetchall()
        for row in rows:
            match = dict(row)
            update = process_match(conn, match, config)
            processed.append({
                "match_id": match["match_id"],
                "team_a_delta": round(update.delta_a, 4),
                "team_a_rating": round(update.after_a, 2),
                "team_b_rating": round(update.after_b, 2),
            })
    return processed


def record_roster_event(
    db: Database,
    *,
    team_id: str,
    effective_at: str,
    roster_version: str,
    changed_players: int,
    continuity: float,
    note: str | None = None,
) -> None:
    if not 0.0 <= continuity <= 1.0:
        raise ValueError("continuity 必须在 [0, 1]")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO roster_events(team_id, effective_at, roster_version, changed_players, continuity, note) VALUES(?, ?, ?, ?, ?, ?)",
            (team_id, effective_at, roster_version, changed_players, continuity, note),
        )
        conn.execute(
            "UPDATE teams SET roster_version=?, roster_continuity=?, updated_at=? WHERE team_id=?",
            (roster_version, continuity, effective_at, team_id),
        )


def record_player_forms(db: Database, path: str | Path) -> int:
    payload = read_json(path)
    snapshots = payload.get("snapshots", payload) if isinstance(payload, dict) else payload
    count = 0
    with db.connect() as conn:
        for item in snapshots:
            parse_timestamp(item["observed_at"], "observed_at")
            score = float(item["form_score"])
            reliability = float(item.get("reliability", 1.0))
            if not -1.0 <= score <= 1.0 or not 0.0 <= reliability <= 1.0:
                raise ValueError("form_score 必须在 [-1,1]，reliability 必须在 [0,1]")
            conn.execute(
                """INSERT INTO players(player_id, name, team_id, active) VALUES(?, ?, ?, ?)
                   ON CONFLICT(player_id) DO UPDATE SET
                       name=excluded.name, team_id=excluded.team_id, active=excluded.active""",
                (item["player_id"], item.get("player_name", item["player_id"]), item["team_id"], int(item.get("active", True))),
            )
            conn.execute(
                """INSERT INTO player_form_snapshots(player_id, observed_at, form_score, reliability, note)
                   VALUES(?, ?, ?, ?, ?)
                   ON CONFLICT(player_id, observed_at) DO UPDATE SET
                       form_score=excluded.form_score, reliability=excluded.reliability, note=excluded.note""",
                (item["player_id"], item["observed_at"], score, reliability, item.get("note")),
            )
            count += 1
    return count


def record_manual_prediction(db: Database, record: dict[str, Any]) -> str:
    probability_a = float(record["team_a_win_probability"])
    if not 0.0 < probability_a < 1.0:
        raise ValueError("人工预测概率必须在 (0, 1)")
    if parse_timestamp(record["locked_at"], "locked_at") > parse_timestamp(record["scheduled_at"], "scheduled_at"):
        raise ValueError("人工预测 locked_at 不能晚于 scheduled_at")
    prediction_id = record.get("prediction_id", str(uuid.uuid4()))
    winner = record["team_a_id"] if probability_a >= 0.5 else record["team_b_id"]
    with db.connect() as conn:
        conn.execute(
            """INSERT INTO predictions(
                   prediction_id, source, model_version, locked_at, scheduled_at, event, region,
                   patch, series_format, team_a_id, team_b_id, predicted_winner_id,
                   team_a_win_probability, team_b_win_probability, predicted_score,
                   score_distribution_json, map_probabilities_json, factor_snapshot_json, bp_plan_json
               ) VALUES(?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, '{}')""",
            (
                prediction_id, record.get("model_version", "human"), record["locked_at"], record["scheduled_at"],
                record["event"], record["region"], record.get("patch"), record["series_format"],
                record["team_a_id"], record["team_b_id"], winner, probability_a, 1.0 - probability_a,
                record["predicted_score"], json.dumps(record.get("key_variables", {}), ensure_ascii=False),
            ),
        )
    return prediction_id
