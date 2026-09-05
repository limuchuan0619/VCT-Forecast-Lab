"""动态 Team Rating 与逐地图 Rating 更新。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .math_utils import clamp, logistic_rating


@dataclass(frozen=True)
class RatingUpdate:
    expected_a: float
    quality_score_a: float
    delta_a: float
    before_a: float
    after_a: float
    before_b: float
    after_b: float


def score_quality(
    team_a_maps: int,
    team_b_maps: int,
    round_margin_a: int,
) -> float:
    """
    把赛果与比分质量合并为 [0, 1] 的 A 队实际表现分。

    胜负决定方向；地图净胜和总回合净胜只调整胜负幅度，不能把败者变成胜者。
    这避免单场加时险胜与横扫获得完全相同的更新量。
    """
    if team_a_maps == team_b_maps:
        return 0.5
    winner_sign = 1.0 if team_a_maps > team_b_maps else -1.0
    total_maps = max(team_a_maps + team_b_maps, 1)
    map_dominance = abs(team_a_maps - team_b_maps) / total_maps
    round_dominance = min(abs(round_margin_a) / 24.0, 1.0)
    confidence = clamp(0.62 + 0.23 * map_dominance + 0.15 * round_dominance, 0.55, 1.0)
    return 0.5 + winner_sign * 0.5 * confidence


def calculate_update(
    rating_a: float,
    rating_b: float,
    team_a_maps: int,
    team_b_maps: int,
    round_margin_a: int,
    *,
    k: float = 30.0,
    scale: float = 400.0,
    importance: float = 1.0,
) -> RatingUpdate:
    expected_a = logistic_rating(rating_a - rating_b, scale)
    actual_a = score_quality(team_a_maps, team_b_maps, round_margin_a)
    delta = k * clamp(importance, 0.5, 2.0) * (actual_a - expected_a)
    return RatingUpdate(
        expected_a=expected_a,
        quality_score_a=actual_a,
        delta_a=delta,
        before_a=rating_a,
        after_a=rating_a + delta,
        before_b=rating_b,
        after_b=rating_b - delta,
    )


def process_match(connection: Any, match: dict[str, Any], config: dict[str, Any]) -> RatingUpdate:
    """在一个事务内处理系列赛 Rating 和每张地图 Rating。"""
    if match["processed"]:
        raise ValueError(f"比赛已处理：{match['match_id']}")
    team_a = connection.execute("SELECT * FROM teams WHERE team_id=?", (match["team_a_id"],)).fetchone()
    team_b = connection.execute("SELECT * FROM teams WHERE team_id=?", (match["team_b_id"],)).fetchone()
    if team_a is None or team_b is None:
        raise ValueError("处理比赛前必须先录入双方队伍")

    map_rows = connection.execute(
        "SELECT * FROM map_results WHERE match_id=? ORDER BY map_order", (match["match_id"],)
    ).fetchall()
    round_margin = sum(row["team_a_rounds"] - row["team_b_rounds"] for row in map_rows)
    update = calculate_update(
        team_a["rating"],
        team_b["rating"],
        match["team_a_maps"],
        match["team_b_maps"],
        round_margin,
        k=float(config["series_k"]),
        scale=float(config["elo_scale"]),
        importance=float(match["importance"]),
    )
    now = datetime.now(timezone.utc).isoformat()
    connection.execute(
        "UPDATE teams SET rating=?, matches_played=matches_played+1, last_patch=?, updated_at=? WHERE team_id=?",
        (update.after_a, match["patch"], now, match["team_a_id"]),
    )
    connection.execute(
        "UPDATE teams SET rating=?, matches_played=matches_played+1, last_patch=?, updated_at=? WHERE team_id=?",
        (update.after_b, match["patch"], now, match["team_b_id"]),
    )
    for team_id, before, after, expected, actual, delta in (
        (match["team_a_id"], update.before_a, update.after_a, update.expected_a, update.quality_score_a, update.delta_a),
        (match["team_b_id"], update.before_b, update.after_b, 1 - update.expected_a, 1 - update.quality_score_a, -update.delta_a),
    ):
        connection.execute(
            """INSERT INTO rating_history(
                   match_id, team_id, rating_before, rating_after, expected_score,
                   actual_quality_score, delta, created_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
            (match["match_id"], team_id, before, after, expected, actual, delta, now),
        )

    for row in map_rows:
        _update_map_rating(connection, match, row, config, now)

    connection.execute("UPDATE matches SET processed=1 WHERE match_id=?", (match["match_id"],))
    connection.execute(
        """UPDATE predictions
           SET status='resolved', actual_winner_id=?, actual_score=?, resolved_match_id=?
           WHERE status='locked' AND team_a_id=? AND team_b_id=?
             AND ABS(julianday(scheduled_at) - julianday(?)) <= 1.0""",
        (
            match["winner_id"],
            f"{match['team_a_maps']}-{match['team_b_maps']}",
            match["match_id"],
            match["team_a_id"],
            match["team_b_id"],
            match["played_at"],
        ),
    )
    connection.execute(
        """UPDATE predictions
           SET status='resolved', actual_winner_id=?, actual_score=?, resolved_match_id=?
           WHERE status='locked' AND team_a_id=? AND team_b_id=?
             AND ABS(julianday(scheduled_at) - julianday(?)) <= 1.0""",
        (
            match["winner_id"],
            f"{match['team_b_maps']}-{match['team_a_maps']}",
            match["match_id"],
            match["team_b_id"],
            match["team_a_id"],
            match["played_at"],
        ),
    )
    return update


def _update_map_rating(connection: Any, match: dict[str, Any], row: Any, config: dict[str, Any], now: str) -> None:
    map_id = row["map_id"]
    base = float(config["base_rating"])

    def current(team_id: str) -> tuple[float, int]:
        found = connection.execute(
            "SELECT rating, matches_played FROM team_map_ratings WHERE team_id=? AND map_id=?",
            (team_id, map_id),
        ).fetchone()
        return (found["rating"], found["matches_played"]) if found else (base, 0)

    rating_a, played_a = current(match["team_a_id"])
    rating_b, played_b = current(match["team_b_id"])
    expected_a = logistic_rating(rating_a - rating_b, float(config["elo_scale"]))
    if row["team_a_rounds"] == row["team_b_rounds"]:
        actual_a = 0.5
    else:
        sign = 1 if row["team_a_rounds"] > row["team_b_rounds"] else -1
        dominance = min(abs(row["team_a_rounds"] - row["team_b_rounds"]) / 13.0, 1.0)
        actual_a = 0.5 + sign * 0.5 * (0.75 + 0.25 * dominance)
    delta = float(config["map_k"]) * clamp(float(match["importance"]), 0.5, 2.0) * (actual_a - expected_a)
    for team_id, rating, played, signed_delta in (
        (match["team_a_id"], rating_a, played_a, delta),
        (match["team_b_id"], rating_b, played_b, -delta),
    ):
        connection.execute(
            """INSERT INTO team_map_ratings(team_id, map_id, rating, matches_played, updated_at)
               VALUES(?, ?, ?, ?, ?)
               ON CONFLICT(team_id, map_id) DO UPDATE SET
                   rating=excluded.rating,
                   matches_played=excluded.matches_played,
                   updated_at=excluded.updated_at""",
            (team_id, map_id, rating + signed_delta, played + 1, now),
        )
