"""Frozen Logistic C1 prospective shadow evaluation.

This module has no training path.  It loads the V1.4B artifact, constructs an
exclusive-cutoff feature snapshot, freezes a shadow probability and later
settles that frozen record independently from the Champion prediction.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .db import Database
from .math_utils import clamp, logistic_rating
from .ratings import calculate_update


MODEL_ID = "logistic_c1_v1.4b_20260903"
DATASET_VERSION = "v1.4b-c1-20260903"
BASE_FEATURES = (
    "team_rating_diff", "recent_form_diff", "map_strength_diff",
    "roster_continuity_diff", "player_form_diff", "acs_diff", "adr_diff",
    "kast_diff", "player_rating_diff", "fk_fd_diff",
)
STATUS_VALUES = {"observed", "imputed_team_mean", "feature_unavailable"}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _default_artifact_dir() -> Path:
    configured = os.getenv("VCT_C1_ARTIFACT_DIR")
    return Path(configured) if configured else Path.cwd() / "artifacts" / "logistic_c1_v1_4b_20260903"


class FrozenLogisticC1:
    """Read-only scorer reconstructed from the already fitted V1.4B artifact."""

    def __init__(self, artifact_dir: str | Path | None = None):
        root = Path(artifact_dir) if artifact_dir else _default_artifact_dir()
        manifest_bytes = (root / "manifest.json").read_bytes()
        evaluation_bytes = (root / "evaluation.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        evaluation = json.loads(evaluation_bytes)
        model = evaluation["logistic_c1"]
        preprocessor = model["preprocessor"]
        if manifest["dataset_version"] != DATASET_VERSION or evaluation["dataset_version"] != DATASET_VERSION:
            raise ValueError("c1_dataset_version_mismatch")
        if preprocessor.get("fit_scope") != "train_only":
            raise ValueError("c1_preprocessor_not_train_only")
        self.columns = tuple(preprocessor["columns"])
        coefficient_map = {item["feature"]: float(item["standardized_coefficient"]) for item in model["coefficients"]}
        if set(coefficient_map) != set(self.columns):
            raise ValueError("c1_coefficient_schema_mismatch")
        self.coefficients = tuple(coefficient_map[column] for column in self.columns)
        self.intercept = float(model["intercept"])
        self.imputation = {key: float(value) for key, value in preprocessor["feature_imputation"].items()}
        self.means = {key: float(value) for key, value in preprocessor["means"].items()}
        self.scales = {key: float(value) for key, value in preprocessor["scales"].items()}
        if any(scale <= 0 for scale in self.scales.values()):
            raise ValueError("c1_invalid_scale")
        self.model_id = MODEL_ID
        self.dataset_version = DATASET_VERSION
        self.dataset_sha256 = manifest["dataset_sha256"]
        canonical_artifact = json.dumps(
            {"manifest": manifest, "evaluation": evaluation},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.artifact_hash = hashlib.sha256(canonical_artifact).hexdigest()
        self.preprocessing_source = "V1.4B train-only frozen evaluation artifact"

    def predict(self, features: dict[str, float | None], statuses: dict[str, str]) -> float:
        if set(features) != set(BASE_FEATURES) or set(statuses) != set(BASE_FEATURES):
            raise ValueError("c1_feature_schema_mismatch")
        if any(status not in STATUS_VALUES for status in statuses.values()):
            raise ValueError("c1_feature_status_invalid")
        values: list[float] = []
        for column in self.columns:
            if column.endswith("__imputed"):
                raw = float(statuses[column.removesuffix("__imputed")] == "imputed_team_mean")
            elif column.endswith("__unavailable"):
                raw = float(statuses[column.removesuffix("__unavailable")] == "feature_unavailable")
            else:
                value = features[column]
                raw = self.imputation[column] if value is None else float(value)
            values.append((raw - self.means[column]) / self.scales[column])
        logit = self.intercept + sum(weight * value for weight, value in zip(self.coefficients, values))
        return 1.0 / (1.0 + math.exp(-max(min(logit, 40.0), -40.0)))


class ProspectiveFeatureBuilder:
    """V1.4A-compatible features using only facts strictly before cutoff."""

    def __init__(self, connection: Any, config: dict[str, Any]):
        self.connection = connection
        self.base = float(config.get("base_rating", 1500.0))
        self.scale = float(config.get("elo_scale", 400.0))
        self.series_k = float(config.get("series_k", 45.0))
        self.map_k = float(config.get("map_k", 18.0))
        self.half_life = float(config.get("form_half_life_days", 70.0))
        self.window_days = int(config.get("form_window_days", 180))

    def build(self, fixture: dict[str, Any], cutoff: str) -> dict[str, Any]:
        if not (_time(cutoff) < _time(fixture["scheduled_at"])):
            raise ValueError("shadow_cutoff_not_before_match")
        a, b = fixture["team_a_id"], fixture["team_b_id"]
        ratings = self._ratings(cutoff)
        map_ratings = self._map_ratings(cutoff)
        form_a = self._recent_form(a, cutoff, ratings["timeline"])
        form_b = self._recent_form(b, cutoff, ratings["timeline"])
        map_a = self._map_strength(a, cutoff, map_ratings["ratings"])
        map_b = self._map_strength(b, cutoff, map_ratings["ratings"])
        roster_a, roster_b = self._previous_roster(a, cutoff), self._previous_roster(b, cutoff)
        player_form_a, player_form_b = self._player_form(roster_a["players"], cutoff), self._player_form(roster_b["players"], cutoff)
        stats_a, stats_b = self._player_stats(a, roster_a["players"], cutoff), self._player_stats(b, roster_b["players"], cutoff)

        def difference(left: float | None, right: float | None) -> float | None:
            return None if left is None or right is None else round(float(left) - float(right), 8)

        def combined(left: str, right: str, value: float | None) -> str:
            if value is None or "feature_unavailable" in {left, right}:
                return "feature_unavailable"
            return "imputed_team_mean" if "imputed_team_mean" in {left, right} else "observed"

        ra, rb = ratings["ratings"].get(a, self.base), ratings["ratings"].get(b, self.base)
        features: dict[str, float | None] = {
            "team_rating_diff": difference(ra, rb),
            "recent_form_diff": difference(form_a["value"], form_b["value"]),
            "map_strength_diff": difference(map_a["value"], map_b["value"]),
            "roster_continuity_diff": difference(roster_a["continuity"], roster_b["continuity"]),
            "player_form_diff": difference(player_form_a["value"], player_form_b["value"]),
            "acs_diff": difference(stats_a["acs"]["value"], stats_b["acs"]["value"]),
            "adr_diff": difference(stats_a["adr"]["value"], stats_b["adr"]["value"]),
            "kast_diff": difference(stats_a["kast"]["value"], stats_b["kast"]["value"]),
            "player_rating_diff": difference(stats_a["rating"]["value"], stats_b["rating"]["value"]),
            "fk_fd_diff": difference(stats_a["fk_fd"]["value"], stats_b["fk_fd"]["value"]),
        }
        statuses = {
            "team_rating_diff": "observed",
            "recent_form_diff": "observed" if form_a["window_match_count"] and form_b["window_match_count"] else "feature_unavailable",
            "map_strength_diff": combined(map_a["status"], map_b["status"], features["map_strength_diff"]),
            "roster_continuity_diff": "observed" if features["roster_continuity_diff"] is not None else "feature_unavailable",
            "player_form_diff": combined(player_form_a["status"], player_form_b["status"], features["player_form_diff"]),
        }
        for feature, metric in (("acs_diff", "acs"), ("adr_diff", "adr"), ("kast_diff", "kast"), ("player_rating_diff", "rating"), ("fk_fd_diff", "fk_fd")):
            statuses[feature] = combined(stats_a[metric]["status"], stats_b[metric]["status"], features[feature])
        for feature, status in statuses.items():
            if status == "feature_unavailable":
                features[feature] = None
        latest = max((value for value in (
            ratings["latest_source_time"], map_ratings["latest_source_time"], roster_a["latest_source_time"], roster_b["latest_source_time"],
            player_form_a["latest_observed_at"], player_form_b["latest_observed_at"], stats_a["latest_source_time"], stats_b["latest_source_time"],
        ) if value), default=None)
        if latest and not (_time(latest) < _time(cutoff)):
            raise AssertionError("shadow_temporal_leakage")
        return {
            "features": features,
            "feature_status": statuses,
            "audit": {
                "cutoff_rule": "source_time < feature_cutoff_at < scheduled_match_time",
                "feature_cutoff_at": cutoff,
                "max_source_time": latest,
                "source_match_count": ratings["source_match_count"],
                "prior_match_count": {"team_a": form_a["prior_match_count"], "team_b": form_b["prior_match_count"]},
                "previous_roster_source": {"team_a": roster_a["source_match_id"], "team_b": roster_b["source_match_id"]},
                "current_team_state_used": False,
                "current_team_map_rating_used": False,
                "target_result_or_actual_roster_used": False,
            },
        }

    def _matches_before(self, cutoff: str) -> list[Any]:
        return self.connection.execute(
            """SELECT m.*,COALESCE(SUM(r.team_a_rounds-r.team_b_rounds),0) round_margin_a
               FROM matches m LEFT JOIN map_results r ON r.match_id=m.match_id
               WHERE julianday(m.played_at)<julianday(?) GROUP BY m.match_id
               ORDER BY julianday(m.played_at),m.match_id""", (cutoff,),
        ).fetchall()

    def _ratings(self, cutoff: str) -> dict[str, Any]:
        ratings: dict[str, float] = defaultdict(lambda: self.base)
        timeline: dict[str, list[dict[str, Any]]] = defaultdict(list)
        rows = self._matches_before(cutoff)
        for row in rows:
            a, b = row["team_a_id"], row["team_b_id"]
            before_a, before_b = ratings[a], ratings[b]
            update = calculate_update(before_a, before_b, row["team_a_maps"], row["team_b_maps"], row["round_margin_a"], k=self.series_k, scale=self.scale, importance=float(row["importance"]))
            ratings[a], ratings[b] = update.after_a, update.after_b
            timeline[a].append({"match_id": row["match_id"], "played_at": row["played_at"], "expected": update.expected_a, "actual": update.quality_score_a, "opponent_rating": before_b})
            timeline[b].append({"match_id": row["match_id"], "played_at": row["played_at"], "expected": 1-update.expected_a, "actual": 1-update.quality_score_a, "opponent_rating": before_a})
        return {"ratings": dict(ratings), "timeline": dict(timeline), "source_match_count": len(rows), "latest_source_time": rows[-1]["played_at"] if rows else None}

    def _map_ratings(self, cutoff: str) -> dict[str, Any]:
        rows = self.connection.execute(
            """SELECT m.match_id,m.played_at,m.team_a_id,m.team_b_id,m.importance,r.map_id,r.team_a_rounds,r.team_b_rounds
               FROM matches m JOIN map_results r ON r.match_id=m.match_id
               WHERE julianday(m.played_at)<julianday(?) ORDER BY julianday(m.played_at),m.match_id,r.map_order""", (cutoff,),
        ).fetchall()
        ratings: dict[tuple[str, str], float] = defaultdict(lambda: self.base)
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
        return {"ratings": dict(ratings), "latest_source_time": rows[-1]["played_at"] if rows else None}

    def _recent_form(self, team_id: str, cutoff: str, timeline: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
        lower = _time(cutoff)-timedelta(days=self.window_days)
        all_prior = timeline.get(team_id, [])
        selected = [row for row in all_prior if _time(row["played_at"]) >= lower]
        numerator = denominator = 0.0
        for row in selected:
            age = max((_time(cutoff)-_time(row["played_at"])).total_seconds()/86400.0, 0.0)
            weight = math.pow(0.5, age/self.half_life)*clamp(0.75+(row["opponent_rating"]-self.base)/800.0, 0.5, 1.5)
            numerator += 2.0*(row["actual"]-row["expected"])*weight
            denominator += weight
        return {"value": clamp(numerator/denominator if denominator else 0.0, -1.0, 1.0), "prior_match_count": len(all_prior), "window_match_count": len(selected)}

    def _map_strength(self, team_id: str, cutoff: str, ratings: dict[tuple[str, str], float]) -> dict[str, Any]:
        lower = (_time(cutoff)-timedelta(days=self.window_days)).isoformat()
        rows = self.connection.execute(
            """SELECT DISTINCT m.match_id,r.map_id FROM matches m JOIN map_results r ON r.match_id=m.match_id
               WHERE julianday(m.played_at)<julianday(?) AND julianday(m.played_at)>=julianday(?)
                 AND (m.team_a_id=? OR m.team_b_id=?)""", (cutoff, lower, team_id, team_id),
        ).fetchall()
        map_ids = {row["map_id"] for row in rows}
        values = [ratings.get((team_id, map_id), self.base) for map_id in map_ids]
        return {"value": sum(values)/len(values) if values else self.base, "status": "observed" if values else "feature_unavailable"}

    def _previous_roster(self, team_id: str, cutoff: str) -> dict[str, Any]:
        matches = self.connection.execute(
            """SELECT DISTINCT m.match_id,m.played_at FROM matches m JOIN match_player_stats s ON s.match_id=m.match_id AND s.team_id=?
               WHERE julianday(m.played_at)<julianday(?) AND (m.team_a_id=? OR m.team_b_id=?)
               ORDER BY julianday(m.played_at) DESC,m.match_id DESC""", (team_id, cutoff, team_id, team_id),
        ).fetchall()
        observed: list[tuple[Any, list[dict[str, str]]]] = []
        for match in matches:
            players = [dict(row) for row in self.connection.execute(
                "SELECT player_id,MAX(player_name) player_name FROM match_player_stats WHERE match_id=? AND team_id=? GROUP BY player_id ORDER BY player_id",
                (match["match_id"], team_id),
            ).fetchall()]
            if players:
                observed.append((match, players))
            if len(observed) == 2:
                break
        if not observed:
            return {"players": [], "continuity": None, "source_match_id": None, "latest_source_time": None}
        latest, players = observed[0]
        continuity = None
        if len(observed) == 2:
            prior_ids = {row["player_id"] for row in observed[1][1]}
            current_ids = {row["player_id"] for row in players}
            continuity = len(current_ids & prior_ids)/max(len(current_ids), 1)
        return {"players": players, "continuity": continuity, "source_match_id": latest["match_id"], "latest_source_time": latest["played_at"]}

    def _player_form(self, roster: list[dict[str, str]], cutoff: str) -> dict[str, Any]:
        observed = []
        for player in roster:
            row = self.connection.execute(
                """SELECT observed_at,form_score,reliability FROM player_form_snapshots WHERE player_id=?
                   AND julianday(observed_at)<julianday(?) ORDER BY julianday(observed_at) DESC,snapshot_id DESC LIMIT 1""",
                (player["player_id"], cutoff),
            ).fetchone()
            if row:
                observed.append(row)
        weight = sum(float(row["reliability"]) for row in observed)
        value = sum(float(row["form_score"])*float(row["reliability"]) for row in observed)/weight if weight else None
        status = "observed" if roster and len(observed) == len(roster) else "imputed_team_mean" if observed else "feature_unavailable"
        return {"value": value, "status": status, "latest_observed_at": max((row["observed_at"] for row in observed), default=None)}

    def _player_stats(self, team_id: str, roster: list[dict[str, str]], cutoff: str) -> dict[str, Any]:
        metrics = ("acs", "adr", "kast", "rating", "fk_fd")
        ids = [row["player_id"] for row in roster]
        unavailable = {"value": None, "status": "feature_unavailable"}
        if not ids:
            return {**{metric: dict(unavailable) for metric in metrics}, "latest_source_time": None}
        lower = (_time(cutoff)-timedelta(days=self.window_days)).isoformat()
        marks = ",".join("?" for _ in ids)
        rows = self.connection.execute(
            f"""SELECT s.player_id,m.played_at,s.acs,s.adr,s.kast,s.rating,
                       CASE WHEN s.first_kills IS NULL OR s.first_deaths IS NULL THEN NULL ELSE s.first_kills-s.first_deaths END fk_fd
                FROM match_player_stats s JOIN matches m ON m.match_id=s.match_id
                WHERE s.team_id=? AND s.player_id IN ({marks}) AND julianday(m.played_at)<julianday(?)
                  AND julianday(m.played_at)>=julianday(?)""", (team_id, *ids, cutoff, lower),
        ).fetchall()
        result: dict[str, Any] = {}
        for metric in metrics:
            by_player: dict[str, list[float]] = defaultdict(list)
            for row in rows:
                if row[metric] is not None:
                    by_player[row["player_id"]].append(float(row[metric]))
            averages = {pid: sum(values)/len(values) for pid, values in by_player.items() if values}
            if not averages:
                result[metric] = dict(unavailable)
            else:
                mean = sum(averages.values())/len(averages)
                result[metric] = {"value": sum(averages.get(pid, mean) for pid in ids)/len(ids), "status": "observed" if len(averages) == len(ids) else "imputed_team_mean"}
        result["latest_source_time"] = max((row["played_at"] for row in rows), default=None)
        return result


def create_feature_snapshot(db: Database, fixture: dict[str, Any], cutoff: str) -> dict[str, Any]:
    with db.connect() as conn:
        latest_gold = conn.execute(
            """SELECT snapshot_id,quality_status,observed_at FROM prospective_snapshots WHERE fixture_id=?
               AND quality_status IN ('ready','locked') AND julianday(observed_at)<=julianday(?)
               ORDER BY julianday(observed_at) DESC LIMIT 1""", (fixture["fixture_id"], cutoff),
        ).fetchone()
        if latest_gold is None:
            raise ValueError("shadow_missing_ready_gold_snapshot")
        built = ProspectiveFeatureBuilder(conn, db.config()).build(fixture, cutoff)
    payload = {
        "fixture_id": fixture["fixture_id"], "scheduled_at": fixture["scheduled_at"], "feature_cutoff_at": cutoff,
        "features": built["features"], "feature_status": built["feature_status"], "audit": built["audit"],
        "gold_snapshot_id": latest_gold["snapshot_id"], "gold_quality_status": latest_gold["quality_status"],
    }
    content_hash = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()
    snapshot_id = f"c1-feature:{fixture['fixture_id']}:{content_hash[:20]}"
    with db.connect() as conn:
        existing = conn.execute("SELECT * FROM challenger_feature_snapshots WHERE fixture_id=?", (fixture["fixture_id"],)).fetchone()
        if existing and existing["content_hash"] != content_hash:
            raise ValueError("challenger_feature_snapshot_conflict")
        conn.execute(
            """INSERT OR IGNORE INTO challenger_feature_snapshots(snapshot_id,fixture_id,created_at,feature_cutoff_at,scheduled_at,
                   gold_snapshot_id,quality_status,feature_json,feature_status_json,evidence_json,content_hash)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (snapshot_id, fixture["fixture_id"], _now(), cutoff, fixture["scheduled_at"], latest_gold["snapshot_id"], latest_gold["quality_status"],
             _json(built["features"]), _json(built["feature_status"]), _json(built["audit"]), content_hash),
        )
    return {"snapshot_id": snapshot_id, "content_hash": content_hash, **payload}


def freeze_shadow_prediction(db: Database, fixture: dict[str, Any], champion: dict[str, Any], snapshot: dict[str, Any], model: FrozenLogisticC1, *, record_kind: str = "real_prospective") -> dict[str, Any]:
    probability = model.predict(snapshot["features"], snapshot["feature_status"])
    champion_probability = float(champion.get("team_a_win_probability", champion.get("team_a", {}).get("win_probability")))
    frozen_at = champion["locked_at"]
    if not (_time(frozen_at) < _time(fixture["scheduled_at"])):
        raise ValueError("shadow_freeze_not_before_match")
    eligible = int(record_kind == "real_prospective" and fixture["source_id"] == "vlr" and fixture["quality_status"] == "ready")
    shadow_id = f"c1-shadow:{fixture['fixture_id']}"
    values = (
        shadow_id, fixture["fixture_id"], champion["prediction_id"], snapshot["snapshot_id"], _now(), frozen_at, fixture["scheduled_at"],
        champion["model_version"], champion_probability, model.model_id, model.dataset_version, model.artifact_hash,
        probability, probability-champion_probability, fixture["quality_status"], record_kind, eligible,
    )
    with db.connect() as conn:
        existing = conn.execute("SELECT * FROM challenger_predictions WHERE fixture_id=?", (fixture["fixture_id"],)).fetchone()
        if existing:
            expected = (champion["prediction_id"], snapshot["snapshot_id"], model.artifact_hash, round(probability, 12))
            actual = (existing["champion_prediction_id"], existing["feature_snapshot_id"], existing["artifact_hash"], round(float(existing["challenger_probability"]), 12))
            if actual != expected:
                raise ValueError("challenger_prediction_freeze_conflict")
            return dict(existing)
        conn.execute(
            """INSERT INTO challenger_predictions(shadow_prediction_id,fixture_id,champion_prediction_id,feature_snapshot_id,created_at,
                   frozen_at,scheduled_at,champion_model_version,champion_probability,challenger_model_id,dataset_version,artifact_hash,
                   challenger_probability,probability_delta,data_quality_state,record_kind,eligible)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", values,
        )
        return dict(conn.execute("SELECT * FROM challenger_predictions WHERE shadow_prediction_id=?", (shadow_id,)).fetchone())


def settle_shadow_predictions(db: Database, *, resolved_at: str | None = None) -> dict[str, int]:
    resolved_at = resolved_at or _now()
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT c.*,p.team_a_id,p.team_b_id,p.actual_winner_id,p.resolved_match_id
               FROM challenger_predictions c JOIN predictions p ON p.prediction_id=c.champion_prediction_id
               WHERE c.status='locked' AND p.status='resolved' AND p.actual_winner_id IS NOT NULL"""
        ).fetchall()
        for row in rows:
            outcome = 1.0 if row["actual_winner_id"] == row["team_a_id"] else 0.0
            champion_p, challenger_p = float(row["champion_probability"]), float(row["challenger_probability"])
            epsilon = 1e-15
            score = lambda p: -math.log(min(max(p if outcome else 1-p, epsilon), 1-epsilon))
            conn.execute(
                """UPDATE challenger_predictions SET status='resolved',actual_winner_id=?,resolved_match_id=?,resolved_at=?,
                   champion_brier=?,challenger_brier=?,champion_log_loss=?,challenger_log_loss=?,champion_correct=?,challenger_correct=?
                   WHERE shadow_prediction_id=? AND status='locked'""",
                (row["actual_winner_id"], row["resolved_match_id"], resolved_at, (champion_p-outcome)**2, (challenger_p-outcome)**2,
                 score(champion_p), score(challenger_p), int((champion_p>=0.5)==bool(outcome)), int((challenger_p>=0.5)==bool(outcome)), row["shadow_prediction_id"]),
            )
    return {"challenger_settled": len(rows)}


def prospective_metrics(db: Database) -> dict[str, Any]:
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT c.*,p.team_a_id,p.team_b_id FROM challenger_predictions c
               JOIN predictions p ON p.prediction_id=c.champion_prediction_id
               WHERE c.status='resolved' AND c.eligible=1 AND c.record_kind='real_prospective'
               ORDER BY julianday(c.scheduled_at),c.shadow_prediction_id"""
        ).fetchall()
    count = len(rows)
    phase = "ACCUMULATING" if count < 30 else "PRELIMINARY" if count < 50 else "EVALUATING" if count < 100 else "GATE_READY"
    result: dict[str, Any] = {"eligible_resolved_matches": count, "gate": 100, "phase": phase, "promotion_status": "EVALUATING" if count < 100 else "GATE_READY", "promotion_enabled": False}
    if not rows:
        result["metrics"] = None
        return result
    def model_metrics(prefix: str, probability_column: str) -> dict[str, float]:
        probabilities = [float(row[probability_column]) for row in rows]
        outcomes = [1.0 if row["actual_winner_id"] == row["team_a_id"] else 0.0 for row in rows]
        bins = [[] for _ in range(10)]
        for p, y in zip(probabilities, outcomes):
            bins[min(int(p*10), 9)].append((p, y))
        ece = sum(len(group)/count*abs(sum(p for p, _ in group)/len(group)-sum(y for _, y in group)/len(group)) for group in bins if group)
        return {
            "brier": sum(float(row[f"{prefix}_brier"]) for row in rows)/count,
            "log_loss": sum(float(row[f"{prefix}_log_loss"]) for row in rows)/count,
            "accuracy": sum(int(row[f"{prefix}_correct"]) for row in rows)/count,
            "ece_10_bin": ece,
            "mean_probability_team_a": sum(probabilities)/count,
            "high_confidence_count": sum(p >= 0.7 or p <= 0.3 for p in probabilities),
        }
    result["metrics"] = {"champion": model_metrics("champion", "champion_probability"), "logistic_c1": model_metrics("challenger", "challenger_probability")}
    return result


def blocker_coverage(db: Database) -> dict[str, Any]:
    with db.connect() as conn:
        fixtures = conn.execute("SELECT fixture_id,status,quality_status,blocker_json,prediction_id FROM fixtures").fetchall()
        eligible = int(conn.execute("SELECT COUNT(*) FROM challenger_predictions WHERE status='resolved' AND eligible=1 AND record_kind='real_prospective'").fetchone()[0])
    reasons: dict[str, int] = defaultdict(int)
    for row in fixtures:
        for reason in json.loads(row["blocker_json"] or "[]"):
            reasons[reason] += 1
    ready = sum(row["quality_status"] in {"ready", "locked"} for row in fixtures)
    blocked = sum(row["quality_status"] not in {"ready", "locked"} for row in fixtures)
    unresolved = sum(row["status"] != "completed" for row in fixtures)
    return {"total_fixtures_discovered": len(fixtures), "ready": ready, "blocked": blocked, "resolved_eligible": eligible, "unresolved": unresolved, "block_reason_distribution": dict(sorted(reasons.items())), "gold_eligible_rate": ready/len(fixtures) if fixtures else 0.0}
