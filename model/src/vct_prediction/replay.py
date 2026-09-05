"""Strict as-of historical replay for the bounded V1.4A validation prototype.

Dynamic state is rebuilt from match facts. Current ``teams`` model fields and
``team_map_ratings`` are deliberately never used as historical features.
"""

from __future__ import annotations

import math
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .math_utils import clamp, logistic_rating
from .ratings import calculate_update


DEFAULT_EVENT = "VCT 2026: China Kickoff"
STAT_METRICS = ("acs", "adr", "kast", "rating", "fk_fd")


def open_read_only(path: str | Path) -> sqlite3.Connection:
    """Open a SQLite database in immutable, query-only mode."""
    resolved = Path(path).resolve()
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 8)


class HistoricalReplayBuilder:
    """Generate inspectable features with an exclusive target-time cutoff."""

    def __init__(self, connection: sqlite3.Connection, config: dict[str, Any]):
        self.connection = connection
        self.connection.row_factory = sqlite3.Row
        self.config = config
        self.base = float(config.get("base_rating", 1500.0))
        self.scale = float(config.get("elo_scale", 400.0))
        self.series_k = float(config.get("series_k", 45.0))
        self.map_k = float(config.get("map_k", 18.0))
        self.half_life = float(config.get("form_half_life_days", 70.0))
        self.window_days = int(config.get("form_window_days", 180))

    def select_cn_sample(
        self,
        *,
        event: str = DEFAULT_EVENT,
        min_prior_matches: int = 5,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            """SELECT m.match_id, m.played_at, m.event, m.stage,
                      m.team_a_id, m.team_b_id, ta.name AS team_a, tb.name AS team_b,
                      (SELECT COUNT(*) FROM matches p
                       WHERE julianday(p.played_at) < julianday(m.played_at)
                         AND (p.team_a_id=m.team_a_id OR p.team_b_id=m.team_a_id)) prior_a,
                      (SELECT COUNT(*) FROM matches p
                       WHERE julianday(p.played_at) < julianday(m.played_at)
                         AND (p.team_a_id=m.team_b_id OR p.team_b_id=m.team_b_id)) prior_b
               FROM matches m
               JOIN teams ta ON ta.team_id=m.team_a_id
               JOIN teams tb ON tb.team_id=m.team_b_id
               WHERE m.region='CN' AND m.event=?
               ORDER BY julianday(m.played_at), m.match_id LIMIT ?""",
            (event, limit),
        ).fetchall()
        selected = [dict(row) for row in rows]
        if len(selected) != limit:
            raise ValueError(f"Expected {limit} matches for {event!r}; found {len(selected)}")
        below = [row["match_id"] for row in selected if min(row["prior_a"], row["prior_b"]) < min_prior_matches]
        if below:
            raise ValueError(f"Matches below the prior-history threshold: {below}")
        return selected

    def build(self, match_id: str) -> dict[str, Any]:
        target = self.connection.execute(
            """SELECT m.match_id,m.event,m.region,m.stage,m.played_at,m.patch,m.series_format,
                      m.team_a_id,m.team_b_id,ta.name team_a_name,tb.name team_b_name
               FROM matches m JOIN teams ta ON ta.team_id=m.team_a_id
               JOIN teams tb ON tb.team_id=m.team_b_id WHERE m.match_id=?""",
            (match_id,),
        ).fetchone()
        if target is None:
            raise ValueError(f"Unknown match: {match_id}")
        cutoff = target["played_at"]
        a, b = target["team_a_id"], target["team_b_id"]

        rating = self._ratings(cutoff)
        maps = self._map_ratings(cutoff)
        form_a, form_b = self._recent_form(a, cutoff, rating["timeline"]), self._recent_form(b, cutoff, rating["timeline"])
        map_a, map_b = self._map_strength(a, cutoff, maps["ratings"]), self._map_strength(b, cutoff, maps["ratings"])
        roster_a, roster_b = self._previous_roster(a, cutoff), self._previous_roster(b, cutoff)
        pf_a, pf_b = self._player_form(roster_a["players"], cutoff), self._player_form(roster_b["players"], cutoff)
        stats_a, stats_b = self._player_stats(a, roster_a["players"], cutoff), self._player_stats(b, roster_b["players"], cutoff)

        missing: list[str] = []
        if roster_a["status"] != "observed" or roster_b["status"] != "observed":
            missing.append("previous_observed_roster")
        if pf_a["value"] is None or pf_b["value"] is None:
            missing.append("player_form")
        diffs: dict[str, float | None] = {}
        for metric in STAT_METRICS:
            left, right = stats_a[metric]["value"], stats_b[metric]["value"]
            diffs[metric] = _round(left - right) if left is not None and right is not None else None
            if diffs[metric] is None:
                missing.append(metric)

        source_by_feature = {
            "recent_form": sorted(set(form_a["source_match_ids"] + form_b["source_match_ids"])),
            "map_strength": sorted(set(map_a["source_match_ids"] + map_b["source_match_ids"])),
            "roster": sorted(set(roster_a["source_match_ids"] + roster_b["source_match_ids"])),
            "player_stats": sorted(set(stats_a["source_match_ids"] + stats_b["source_match_ids"])),
        }
        direct_ids = {item for values in source_by_feature.values() for item in values}
        times = [
            value for value in (
                rating["latest_source_time"], maps["latest_source_time"],
                roster_a["latest_source_time"], roster_b["latest_source_time"],
                pf_a["latest_observed_at"], pf_b["latest_observed_at"],
                stats_a["latest_source_time"], stats_b["latest_source_time"],
            ) if value is not None
        ]
        max_source = max(times) if times else None
        if max_source is not None and not (_time(max_source) < _time(cutoff)):
            raise AssertionError(f"Temporal leakage: {max_source} !< {cutoff}")
        if match_id in direct_ids:
            raise AssertionError(f"Target match leaked into replay: {match_id}")

        continuity_diff = None
        if roster_a["continuity"] is not None and roster_b["continuity"] is not None:
            continuity_diff = _round(roster_a["continuity"] - roster_b["continuity"])
        player_form_diff = None
        if pf_a["value"] is not None and pf_b["value"] is not None:
            player_form_diff = _round(pf_a["value"] - pf_b["value"])
        ra, rb = rating["ratings"].get(a, self.base), rating["ratings"].get(b, self.base)

        return {
            "match_id": match_id, "match_time": cutoff, "event": target["event"],
            "stage": target["stage"], "region": target["region"],
            "team_a_id": a, "team_b_id": b,
            "team_a": target["team_a_name"], "team_b": target["team_b_name"],
            "event_cohort": target["patch"],
            "team_rating_a": _round(ra), "team_rating_b": _round(rb),
            "team_rating_diff": _round(ra - rb),
            "recent_form_a": _round(form_a["value"]), "recent_form_b": _round(form_b["value"]),
            "recent_form_diff": _round(form_a["value"] - form_b["value"]),
            "recent_form_detail_a": form_a, "recent_form_detail_b": form_b,
            "prior_match_count_a": form_a["prior_match_count"],
            "prior_match_count_b": form_b["prior_match_count"],
            "map_strength_a": _round(map_a["value"]), "map_strength_b": _round(map_b["value"]),
            "map_strength_diff": _round(map_a["value"] - map_b["value"]),
            "map_strength_detail_a": map_a, "map_strength_detail_b": map_b,
            "player_form_a": _round(pf_a["value"]), "player_form_b": _round(pf_b["value"]),
            "player_form_diff": player_form_diff,
            "acs_diff": diffs["acs"], "adr_diff": diffs["adr"],
            "kast_diff": diffs["kast"], "rating_diff": diffs["rating"],
            "fk_fd_diff": diffs["fk_fd"],
            "roster_continuity_a": roster_a["continuity"],
            "roster_continuity_b": roster_b["continuity"],
            "roster_continuity_diff": continuity_diff,
            "previous_roster_a": roster_a, "previous_roster_b": roster_b,
            "player_form_detail_a": pf_a, "player_form_detail_b": pf_b,
            "player_stats_a": stats_a, "player_stats_b": stats_b,
            "feature_cutoff_time": cutoff, "cutoff_rule": "source_time < match_time",
            "max_source_match_time": max_source,
            "source_match_count": rating["source_match_count"],
            "direct_source_match_count": len(direct_ids),
            "source_match_ids_by_feature": source_by_feature,
            "replay_metadata": {
                "team_rating_source_count": rating["source_match_count"],
                "team_rating_latest_source": rating["latest_source_time"],
                "map_rating_source_count": maps["source_match_count"],
                "map_rating_latest_source": maps["latest_source_time"],
                "target_map_or_veto_used": False,
                "current_team_state_used": False,
                "current_team_map_rating_used": False,
            },
            "missing_features": sorted(set(missing)),
        }

    def _matches_before(self, cutoff: str) -> list[sqlite3.Row]:
        return self.connection.execute(
            """SELECT m.*, COALESCE(SUM(mr.team_a_rounds-mr.team_b_rounds), 0) round_margin_a
               FROM matches m LEFT JOIN map_results mr ON mr.match_id=m.match_id
               WHERE julianday(m.played_at) < julianday(?) GROUP BY m.match_id
               ORDER BY julianday(m.played_at), m.match_id""",
            (cutoff,),
        ).fetchall()

    def _ratings(self, cutoff: str) -> dict[str, Any]:
        ratings: dict[str, float] = defaultdict(lambda: self.base)
        timeline: dict[str, list[dict[str, Any]]] = defaultdict(list)
        rows = self._matches_before(cutoff)
        for row in rows:
            a, b = row["team_a_id"], row["team_b_id"]
            before_a, before_b = ratings[a], ratings[b]
            update = calculate_update(
                before_a, before_b, row["team_a_maps"], row["team_b_maps"], row["round_margin_a"],
                k=self.series_k, scale=self.scale, importance=float(row["importance"]),
            )
            ratings[a], ratings[b] = update.after_a, update.after_b
            timeline[a].append({"match_id": row["match_id"], "played_at": row["played_at"],
                                "expected": update.expected_a, "actual": update.quality_score_a,
                                "opponent_rating": before_b})
            timeline[b].append({"match_id": row["match_id"], "played_at": row["played_at"],
                                "expected": 1-update.expected_a, "actual": 1-update.quality_score_a,
                                "opponent_rating": before_a})
        return {"ratings": dict(ratings), "timeline": dict(timeline),
                "source_match_count": len(rows), "latest_source_time": rows[-1]["played_at"] if rows else None}

    def _map_ratings(self, cutoff: str) -> dict[str, Any]:
        rows = self.connection.execute(
            """SELECT m.match_id,m.played_at,m.team_a_id,m.team_b_id,m.importance,
                      r.map_id,r.team_a_rounds,r.team_b_rounds
               FROM matches m JOIN map_results r ON r.match_id=m.match_id
               WHERE julianday(m.played_at) < julianday(?)
               ORDER BY julianday(m.played_at),m.match_id,r.map_order""", (cutoff,),
        ).fetchall()
        ratings: dict[tuple[str, str], float] = defaultdict(lambda: self.base)
        match_ids: set[str] = set()
        for row in rows:
            ka, kb = (row["team_a_id"], row["map_id"]), (row["team_b_id"], row["map_id"])
            expected = logistic_rating(ratings[ka]-ratings[kb], self.scale)
            if row["team_a_rounds"] == row["team_b_rounds"]:
                actual = 0.5
            else:
                sign = 1 if row["team_a_rounds"] > row["team_b_rounds"] else -1
                dominance = min(abs(row["team_a_rounds"]-row["team_b_rounds"])/13.0, 1.0)
                actual = 0.5 + sign*0.5*(0.75+0.25*dominance)
            delta = self.map_k*clamp(float(row["importance"]), 0.5, 2.0)*(actual-expected)
            ratings[ka] += delta
            ratings[kb] -= delta
            match_ids.add(row["match_id"])
        return {"ratings": dict(ratings), "source_match_count": len(match_ids),
                "latest_source_time": rows[-1]["played_at"] if rows else None}

    def _recent_form(self, team_id: str, cutoff: str, timeline: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        cutoff_dt = _time(cutoff)
        lower = cutoff_dt - timedelta(days=self.window_days)
        all_prior = timeline.get(team_id, [])
        selected = [row for row in all_prior if _time(row["played_at"]) >= lower]
        numerator = denominator = 0.0
        for row in selected:
            age = max((cutoff_dt-_time(row["played_at"])).total_seconds()/86400.0, 0.0)
            weight = math.pow(0.5, age/self.half_life) * clamp(
                0.75+(row["opponent_rating"]-self.base)/800.0, 0.5, 1.5
            )
            numerator += 2.0*(row["actual"]-row["expected"])*weight
            denominator += weight
        return {"value": clamp(numerator/denominator if denominator else 0.0, -1.0, 1.0),
                "prior_match_count": len(all_prior), "window_match_count": len(selected),
                "source_match_ids": [row["match_id"] for row in selected]}

    def _map_strength(self, team_id: str, cutoff: str, ratings: dict[tuple[str, str], float]) -> dict[str, Any]:
        lower = (_time(cutoff)-timedelta(days=self.window_days)).isoformat()
        rows = self.connection.execute(
            """SELECT DISTINCT m.match_id,m.played_at,r.map_id
               FROM matches m JOIN map_results r ON r.match_id=m.match_id
               WHERE julianday(m.played_at)<julianday(?) AND julianday(m.played_at)>=julianday(?)
                 AND (m.team_a_id=? OR m.team_b_id=?)
               ORDER BY julianday(m.played_at),m.match_id""", (cutoff, lower, team_id, team_id),
        ).fetchall()
        map_ids = sorted({row["map_id"] for row in rows})
        values = [ratings.get((team_id, map_id), self.base) for map_id in map_ids]
        return {"value": sum(values)/len(values) if values else self.base, "map_ids": map_ids,
                "status": "historical_active_map_mean" if values else "imputed_base_no_prior_map",
                "source_match_ids": sorted({row["match_id"] for row in rows})}

    def _previous_roster(self, team_id: str, cutoff: str) -> dict[str, Any]:
        matches = self.connection.execute(
            """SELECT DISTINCT m.match_id,m.played_at FROM matches m
               JOIN match_player_stats s ON s.match_id=m.match_id AND s.team_id=?
               WHERE julianday(m.played_at)<julianday(?) AND (m.team_a_id=? OR m.team_b_id=?)
               ORDER BY julianday(m.played_at) DESC,m.match_id DESC""", (team_id, cutoff, team_id, team_id),
        ).fetchall()
        observed: list[tuple[sqlite3.Row, list[dict[str, str]]]] = []
        for match in matches:
            rows = self.connection.execute(
                """SELECT player_id,MAX(player_name) player_name FROM match_player_stats
                   WHERE match_id=? AND team_id=? GROUP BY player_id ORDER BY player_id""",
                (match["match_id"], team_id),
            ).fetchall()
            lineup = [{"player_id": row["player_id"], "player_name": row["player_name"]} for row in rows]
            if lineup:
                observed.append((match, lineup))
            if len(observed) == 2:
                break
        if not observed:
            return {"status": "feature_unavailable", "players": [], "source_match_id": None,
                    "source_match_time": None, "previous_source_match_id": None, "continuity": None,
                    "source_match_ids": [], "latest_source_time": None}
        latest, lineup = observed[0]
        if len(observed) == 2:
            prior, prior_lineup = observed[1]
            current_ids, prior_ids = {p["player_id"] for p in lineup}, {p["player_id"] for p in prior_lineup}
            continuity = len(current_ids & prior_ids)/max(len(current_ids), 1)
            source_ids, previous_id, status = [latest["match_id"], prior["match_id"]], prior["match_id"], "observed"
        else:
            continuity, source_ids, previous_id, status = None, [latest["match_id"]], None, "partial_one_prior_lineup"
        return {"status": status, "players": lineup, "source_match_id": latest["match_id"],
                "source_match_time": latest["played_at"], "previous_source_match_id": previous_id,
                "continuity": _round(continuity), "source_match_ids": source_ids,
                "latest_source_time": latest["played_at"]}

    def _player_form(self, roster: list[dict[str, str]], cutoff: str) -> dict[str, Any]:
        details: list[dict[str, Any]] = []
        for player in roster:
            row = self.connection.execute(
                """SELECT observed_at,form_score,reliability FROM player_form_snapshots
                   WHERE player_id=? AND julianday(observed_at)<julianday(?)
                   ORDER BY julianday(observed_at) DESC,snapshot_id DESC LIMIT 1""",
                (player["player_id"], cutoff),
            ).fetchone()
            if row is None:
                details.append({**player, "status": "feature_unavailable", "observed_at": None})
            else:
                details.append({**player, "status": "observed", "observed_at": row["observed_at"],
                                "form_score": _round(row["form_score"]), "reliability": _round(row["reliability"])})
        observed = [row for row in details if row["status"] == "observed"]
        weight = sum(row["reliability"] for row in observed)
        value = sum(row["form_score"]*row["reliability"] for row in observed)/weight if weight else None
        return {"value": _round(value),
                "status": "observed" if roster and len(observed)==len(roster) else ("imputed_team_mean" if observed else "feature_unavailable"),
                "observed_players": len(observed), "expected_players": len(roster),
                "missing_player_ids": [row["player_id"] for row in details if row["status"] != "observed"],
                "latest_observed_at": max((row["observed_at"] for row in observed), default=None),
                "players": details}

    def _player_stats(self, team_id: str, roster: list[dict[str, str]], cutoff: str) -> dict[str, Any]:
        ids = [row["player_id"] for row in roster]
        unavailable = {"value": None, "status": "feature_unavailable", "observed_players": 0,
                       "expected_players": len(ids), "missing_player_ids": list(ids)}
        if not ids:
            return {**{metric: dict(unavailable) for metric in STAT_METRICS},
                    "source_match_ids": [], "latest_source_time": None, "window_days": self.window_days}
        lower = (_time(cutoff)-timedelta(days=self.window_days)).isoformat()
        marks = ",".join("?" for _ in ids)
        rows = self.connection.execute(
            f"""SELECT s.player_id,m.match_id,m.played_at,s.acs,s.adr,s.kast,s.rating,
                       CASE WHEN s.first_kills IS NULL OR s.first_deaths IS NULL THEN NULL
                            ELSE s.first_kills-s.first_deaths END fk_fd
                FROM match_player_stats s JOIN matches m ON m.match_id=s.match_id
                WHERE s.team_id=? AND s.player_id IN ({marks})
                  AND julianday(m.played_at)<julianday(?) AND julianday(m.played_at)>=julianday(?)
                ORDER BY julianday(m.played_at),m.match_id,s.map_order""",
            (team_id, *ids, cutoff, lower),
        ).fetchall()
        result: dict[str, Any] = {}
        for metric in STAT_METRICS:
            by_player: dict[str, list[float]] = defaultdict(list)
            for row in rows:
                if row[metric] is not None:
                    by_player[row["player_id"]].append(float(row[metric]))
            averages = {pid: sum(values)/len(values) for pid, values in by_player.items() if values}
            missing = [pid for pid in ids if pid not in averages]
            if not averages:
                result[metric] = {**unavailable, "missing_player_ids": missing}
                continue
            mean = sum(averages.values())/len(averages)
            completed = [averages.get(pid, mean) for pid in ids]
            result[metric] = {"value": _round(sum(completed)/len(completed)),
                              "status": "observed" if not missing else "imputed_team_mean",
                              "observed_players": len(averages), "expected_players": len(ids),
                              "missing_player_ids": missing,
                              "imputation_value": _round(mean) if missing else None}
        result["source_match_ids"] = sorted({row["match_id"] for row in rows})
        result["latest_source_time"] = max((row["played_at"] for row in rows), default=None)
        result["window_days"] = self.window_days
        return result


def poison_future_test(source: sqlite3.Connection, config: dict[str, Any], match_ids: Iterable[str]) -> dict[str, Any]:
    """Add extreme future facts to an in-memory clone and compare past features."""
    selected = list(match_ids)
    before_builder = HistoricalReplayBuilder(source, config)
    before = {match_id: before_builder.build(match_id) for match_id in selected}
    clone = sqlite3.connect(":memory:")
    clone.row_factory = sqlite3.Row
    source.backup(clone)
    for ordinal, match_id in enumerate(selected, 1):
        record = before[match_id]
        future = f"2099-01-{ordinal:02d}T00:00:00Z"
        future_id = f"poison_future_{ordinal}_{match_id}"
        a, b = record["team_a_id"], record["team_b_id"]
        clone.execute(
            """INSERT INTO matches(match_id,event,region,stage,played_at,patch,series_format,
                   team_a_id,team_b_id,winner_id,team_a_maps,team_b_maps,is_international,
                   importance,source_url,data_quality,processed,inserted_at)
               VALUES(?,'POISON FUTURE','CN','future',?,'future','BO3',?,?,?,2,0,0,2.0,
                      'memory://poison','synthetic_poison',1,?)""", (future_id, future, a, b, a, future),
        )
        for order, map_id in ((1, "poison_alpha"), (2, "poison_beta")):
            clone.execute("INSERT INTO map_results VALUES(?,?,?,13,0)", (future_id, order, map_id))
        roster_a = record["previous_roster_a"]["players"]
        for player in roster_a + record["previous_roster_b"]["players"]:
            team = a if player in roster_a else b
            clone.execute("INSERT OR REPLACE INTO player_form_snapshots(player_id,observed_at,form_score,reliability,note) VALUES(?,?,?,1,'future poison')",
                          (player["player_id"], future, 1.0 if team == a else -1.0))
            clone.execute("INSERT OR IGNORE INTO player_team_history(player_id,team_id,effective_from,effective_to,roster_version,source_url) VALUES(?,?,?,NULL,'future-poison','memory://poison')",
                          (player["player_id"], team, future))
            for order in (1, 2):
                clone.execute(
                    """INSERT INTO match_player_stats(match_id,map_order,player_id,player_name,team_id,
                           agent,rating,acs,kills,deaths,assists,kast,adr,hs_pct,first_kills,first_deaths)
                       VALUES(?,?,?,?,?,'future-agent',99,999,99,0,99,100,999,100,99,0)""",
                    (future_id, order, player["player_id"], player["player_name"], team),
                )
        for team, value in ((a, 9999.0), (b, 1.0)):
            clone.execute("UPDATE teams SET rating=?,player_form=1,roster_continuity=0,patch_fit=1,updated_at=? WHERE team_id=?",
                          (value, future, team))
            clone.execute("INSERT INTO roster_events(team_id,effective_at,roster_version,changed_players,continuity,note) VALUES(?,?,'future-poison',5,0,'future poison')",
                          (team, future))
            clone.execute("""INSERT INTO team_map_ratings(team_id,map_id,rating,matches_played,updated_at)
                           VALUES(?,'poison_alpha',?,999,?) ON CONFLICT(team_id,map_id) DO UPDATE SET
                           rating=excluded.rating,matches_played=excluded.matches_played,updated_at=excluded.updated_at""",
                          (team, value, future))
    clone.commit()
    after_builder = HistoricalReplayBuilder(clone, config)
    changed: dict[str, list[str]] = {}
    for match_id in selected:
        after = after_builder.build(match_id)
        if after != before[match_id]:
            changed[match_id] = sorted(key for key in before[match_id] if before[match_id].get(key) != after.get(key))
    clone.close()
    return {"passed": not changed, "tested_match_ids": selected, "changed_fields_by_match": changed,
            "poison_scope": ["future_match_result", "future_map_result", "future_player_stats",
                             "future_player_form", "future_roster_history", "current_teams_state",
                             "current_team_map_ratings"]}
