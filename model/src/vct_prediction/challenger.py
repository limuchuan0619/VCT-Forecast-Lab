"""V1.4B offline historical dataset and first data-driven challenger.

The module is intentionally dependency-free.  It never persists predictions,
updates ratings, or touches production model state.
"""

from __future__ import annotations

import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .maps import series_distribution
from .math_utils import clamp, logistic_rating, probability_with_adjustments, sigmoid
from .replay import HistoricalReplayBuilder


DATASET_VERSION = "v1.4b-c1-20260903"
BASE_FEATURES = (
    "team_rating_diff",
    "recent_form_diff",
    "map_strength_diff",
    "roster_continuity_diff",
    "player_form_diff",
    "acs_diff",
    "adr_diff",
    "kast_diff",
    "player_rating_diff",
    "fk_fd_diff",
)
STATUS_VALUES = ("observed", "imputed_team_mean", "feature_unavailable")
REGULARIZATION_GRID = (0.001, 0.01, 0.1, 1.0)


def select_eligible_matches(
    connection: sqlite3.Connection,
    *,
    limit: int = 1000,
    min_prior_matches: int = 5,
) -> tuple[list[dict[str, Any]], int, int]:
    """Select the latest eligible matches without consulting results for filtering."""
    raw_count = int(connection.execute("SELECT COUNT(*) FROM matches").fetchone()[0])
    predicate = """
        (SELECT COUNT(*) FROM matches p
         WHERE julianday(p.played_at) < julianday(m.played_at)
           AND (p.team_a_id=m.team_a_id OR p.team_b_id=m.team_a_id)) >= ?
        AND
        (SELECT COUNT(*) FROM matches p
         WHERE julianday(p.played_at) < julianday(m.played_at)
           AND (p.team_a_id=m.team_b_id OR p.team_b_id=m.team_b_id)) >= ?
        AND EXISTS(
            SELECT 1 FROM matches p JOIN match_player_stats s
              ON s.match_id=p.match_id AND s.team_id=m.team_a_id
            WHERE julianday(p.played_at) < julianday(m.played_at)
        )
        AND EXISTS(
            SELECT 1 FROM matches p JOIN match_player_stats s
              ON s.match_id=p.match_id AND s.team_id=m.team_b_id
            WHERE julianday(p.played_at) < julianday(m.played_at)
        )
        AND m.winner_id IN (m.team_a_id,m.team_b_id)
        AND m.series_format IN ('bo3','bo5')
    """
    eligible_count = int(
        connection.execute(
            f"SELECT COUNT(*) FROM matches m WHERE {predicate}",
            (min_prior_matches, min_prior_matches),
        ).fetchone()[0]
    )
    rows = connection.execute(
        f"""SELECT m.match_id,m.played_at,m.event,m.stage,m.region,m.series_format,m.patch,
                   m.team_a_id,m.team_b_id,m.winner_id,m.team_a_maps,m.team_b_maps,
                   ta.name team_a,tb.name team_b
            FROM matches m JOIN teams ta ON ta.team_id=m.team_a_id
            JOIN teams tb ON tb.team_id=m.team_b_id
            WHERE {predicate}
            ORDER BY julianday(m.played_at) DESC,m.match_id DESC LIMIT ?""",
        (min_prior_matches, min_prior_matches, limit),
    ).fetchall()
    selected = [dict(row) for row in reversed(rows)]
    if len(selected) != min(limit, eligible_count):
        raise AssertionError("Eligible match selection returned an unexpected count")
    return selected, raw_count, eligible_count


def _normal_status(value: str) -> str:
    if value == "partial":
        return "imputed_team_mean"
    return value if value in STATUS_VALUES else "feature_unavailable"


def _combined_status(left: str, right: str, value: float | None) -> str:
    if value is None:
        return "feature_unavailable"
    statuses = {_normal_status(left), _normal_status(right)}
    if "feature_unavailable" in statuses:
        return "feature_unavailable"
    if "imputed_team_mean" in statuses:
        return "imputed_team_mean"
    return "observed"


def replay_record_to_dataset_row(record: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    if record["match_id"] != target["match_id"]:
        raise AssertionError("Replay record and target label do not match")
    features: dict[str, float | None] = {
        "team_rating_diff": record["team_rating_diff"],
        "recent_form_diff": record["recent_form_diff"],
        "map_strength_diff": record["map_strength_diff"],
        "roster_continuity_diff": record["roster_continuity_diff"],
        "player_form_diff": record["player_form_diff"],
        "acs_diff": record["acs_diff"],
        "adr_diff": record["adr_diff"],
        "kast_diff": record["kast_diff"],
        "player_rating_diff": record["rating_diff"],
        "fk_fd_diff": record["fk_fd_diff"],
    }
    statuses: dict[str, str] = {
        "team_rating_diff": "observed",
        "recent_form_diff": (
            "observed"
            if record["recent_form_detail_a"]["window_match_count"]
            and record["recent_form_detail_b"]["window_match_count"]
            else "feature_unavailable"
        ),
        "map_strength_diff": _combined_status(
            "observed" if record["map_strength_detail_a"]["status"] == "historical_active_map_mean" else "feature_unavailable",
            "observed" if record["map_strength_detail_b"]["status"] == "historical_active_map_mean" else "feature_unavailable",
            record["map_strength_diff"],
        ),
        "roster_continuity_diff": "observed" if record["roster_continuity_diff"] is not None else "feature_unavailable",
        "player_form_diff": _combined_status(
            record["player_form_detail_a"]["status"],
            record["player_form_detail_b"]["status"],
            record["player_form_diff"],
        ),
    }
    stat_key = {
        "acs_diff": "acs",
        "adr_diff": "adr",
        "kast_diff": "kast",
        "player_rating_diff": "rating",
        "fk_fd_diff": "fk_fd",
    }
    for feature, metric in stat_key.items():
        statuses[feature] = _combined_status(
            record["player_stats_a"][metric]["status"],
            record["player_stats_b"][metric]["status"],
            features[feature],
        )
    for feature, status in statuses.items():
        if status == "feature_unavailable":
            features[feature] = None
    if set(features) != set(BASE_FEATURES) or set(statuses) != set(BASE_FEATURES):
        raise AssertionError("Dataset feature contract is incomplete")
    if any(status not in STATUS_VALUES for status in statuses.values()):
        raise AssertionError("Unexpected missingness status")

    target_a_win = 1 if target["winner_id"] == target["team_a_id"] else 0
    return {
        "dataset_version": DATASET_VERSION,
        "match_id": target["match_id"],
        "played_at": target["played_at"],
        "event": target["event"],
        "stage": target["stage"],
        "region": target["region"],
        "series_format": target["series_format"],
        "event_cohort": target["patch"],
        "team_a_id": target["team_a_id"],
        "team_b_id": target["team_b_id"],
        "team_a": target["team_a"],
        "team_b": target["team_b"],
        "winner_id": target["winner_id"],
        "target_a_win": target_a_win,
        "features": features,
        "feature_status": statuses,
        "imputation_indicators": {
            feature: int(status == "imputed_team_mean") for feature, status in statuses.items()
        },
        "unavailable_indicators": {
            feature: int(status == "feature_unavailable") for feature, status in statuses.items()
        },
        "champion_context": {
            "team_rating_a": record["team_rating_a"],
            "team_rating_b": record["team_rating_b"],
            "map_strength_a": record["map_strength_a"] if statuses["map_strength_diff"] != "feature_unavailable" else None,
            "map_strength_b": record["map_strength_b"] if statuses["map_strength_diff"] != "feature_unavailable" else None,
            "recent_form_a": record["recent_form_a"] if statuses["recent_form_diff"] != "feature_unavailable" else None,
            "recent_form_b": record["recent_form_b"] if statuses["recent_form_diff"] != "feature_unavailable" else None,
            "player_form_a": record["player_form_a"] if statuses["player_form_diff"] != "feature_unavailable" else None,
            "player_form_b": record["player_form_b"] if statuses["player_form_diff"] != "feature_unavailable" else None,
            "roster_continuity_a": record["roster_continuity_a"],
            "roster_continuity_b": record["roster_continuity_b"],
        },
        "replay_audit": {
            "feature_cutoff_time": record["feature_cutoff_time"],
            "max_source_match_time": record["max_source_match_time"],
            "source_match_count": record["source_match_count"],
            "current_team_state_used": record["replay_metadata"]["current_team_state_used"],
            "current_team_map_rating_used": record["replay_metadata"]["current_team_map_rating_used"],
            "target_map_or_veto_used": record["replay_metadata"]["target_map_or_veto_used"],
        },
    }


def build_historical_dataset(
    connection: sqlite3.Connection,
    config: dict[str, Any],
    *,
    limit: int = 1000,
    min_prior_matches: int = 5,
    progress: Callable[[int, int], None] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected, raw_count, eligible_count = select_eligible_matches(
        connection, limit=limit, min_prior_matches=min_prior_matches
    )
    builder = HistoricalReplayBuilder(connection, config)
    dataset: list[dict[str, Any]] = []
    for index, target in enumerate(selected, 1):
        record = builder.build(target["match_id"])
        row = replay_record_to_dataset_row(record, target)
        if row["replay_audit"]["max_source_match_time"] >= row["played_at"]:
            raise AssertionError(f"Temporal leakage in {row['match_id']}")
        dataset.append(row)
        if progress:
            progress(index, len(selected))
    return dataset, {
        "raw_match_count": raw_count,
        "eligible_match_count": eligible_count,
        "selected_match_count": len(dataset),
        "selection_policy": f"latest_{limit}_chronological_matches_with_both_teams_at_least_{min_prior_matches}_prior_matches",
        "min_prior_matches": min_prior_matches,
    }


def assign_chronological_splits(
    rows: list[dict[str, Any]],
    *,
    train_fraction: float = 0.65,
    validation_fraction: float = 0.15,
) -> dict[str, Any]:
    if rows != sorted(rows, key=lambda row: (row["played_at"], row["match_id"])):
        raise ValueError("Dataset must be in chronological order")
    total = len(rows)
    if total < 20:
        raise ValueError("Dataset is too small for chronological Train/Validation/Test")
    train_end = int(total * train_fraction)
    validation_end = train_end + int(total * validation_fraction)
    while train_end < total and rows[train_end - 1]["played_at"] == rows[train_end]["played_at"]:
        train_end += 1
    while validation_end < total and rows[validation_end - 1]["played_at"] == rows[validation_end]["played_at"]:
        validation_end += 1
    if not (0 < train_end < validation_end < total):
        raise ValueError("Could not create non-empty chronological splits")
    for index, row in enumerate(rows):
        row["split"] = "train" if index < train_end else "validation" if index < validation_end else "test"
    return {
        "train": train_end,
        "validation": validation_end - train_end,
        "test": total - validation_end,
        "boundaries": {
            "train_start": rows[0]["played_at"],
            "train_end": rows[train_end - 1]["played_at"],
            "validation_start": rows[train_end]["played_at"],
            "validation_end": rows[validation_end - 1]["played_at"],
            "test_start": rows[validation_end]["played_at"],
            "test_end": rows[-1]["played_at"],
        },
    }


def simple_elo_probabilities(
    connection: sqlite3.Connection,
    target_ids: Iterable[str],
    *,
    base_rating: float = 1500.0,
    scale: float = 400.0,
    k: float = 32.0,
) -> dict[str, float]:
    """Standard binary Elo; equal-time matches are all predicted before any update."""
    target_set = set(target_ids)
    rows = connection.execute(
        """SELECT match_id,played_at,team_a_id,team_b_id,winner_id FROM matches
           ORDER BY julianday(played_at),match_id"""
    ).fetchall()
    ratings: dict[str, float] = defaultdict(lambda: base_rating)
    probabilities: dict[str, float] = {}
    groups: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        groups[row["played_at"]].append(row)
    for played_at in sorted(groups):
        pending: dict[str, float] = defaultdict(float)
        for row in groups[played_at]:
            a, b = row["team_a_id"], row["team_b_id"]
            probability = logistic_rating(ratings[a] - ratings[b], scale)
            if row["match_id"] in target_set:
                probabilities[row["match_id"]] = probability
            outcome = 1.0 if row["winner_id"] == a else 0.0
            delta = k * (outcome - probability)
            pending[a] += delta
            pending[b] -= delta
        for team_id, delta in pending.items():
            ratings[team_id] += delta
    missing = target_set - probabilities.keys()
    if missing:
        raise AssertionError(f"Elo predictions missing matches: {sorted(missing)[:5]}")
    return probabilities


def champion_v1_replay_probability(row: dict[str, Any], config: dict[str, Any]) -> float:
    """Frozen-weight partial Champion reconstruction with an explicit map proxy."""
    context = row["champion_context"]
    base = float(config["base_rating"])
    continuity_a = context["roster_continuity_a"]
    continuity_b = context["roster_continuity_b"]
    reliability_a = 0.55 + 0.45 * continuity_a if continuity_a is not None else 0.55
    reliability_b = 0.55 + 0.45 * continuity_b if continuity_b is not None else 0.55
    effective_a = base + (float(context["team_rating_a"]) - base) * reliability_a
    effective_b = base + (float(context["team_rating_b"]) - base) * reliability_b

    map_a = context["map_strength_a"] if context["map_strength_a"] is not None else effective_a
    map_b = context["map_strength_b"] if context["map_strength_b"] is not None else effective_b
    # Current Champion shrinks per-map ratings toward team rating with a prior.
    # Historical map sample counts and target maps are unavailable, so the fixed
    # 50/50 active-map mean proxy is declared rather than disguised as exact BP.
    proxy_map_rating_a = 0.5 * effective_a + 0.5 * float(map_a)
    proxy_map_rating_b = 0.5 * effective_b + 0.5 * float(map_b)
    map_probability = logistic_rating(proxy_map_rating_a - proxy_map_rating_b, float(config["elo_scale"]))
    weights = config["weights"]
    adjustments = []
    for feature, weight_name in (
        ("recent_form_diff", "recent_form"),
        ("player_form_diff", "player_form"),
        ("roster_continuity_diff", "roster_continuity"),
    ):
        difference = row["features"][feature]
        if difference is not None:
            adjustments.append(float(weights[weight_name]) * 0.65 * float(difference))
    per_map_probability = probability_with_adjustments(map_probability, adjustments)
    required = 2 if row["series_format"] == "bo3" else 3
    distribution = series_distribution([per_map_probability] * (required * 2 - 1), row["series_format"])
    return sum(probability for score, probability in distribution.items() if int(score.split("-")[0]) == required)


@dataclass
class TrainPreprocessor:
    feature_imputation: dict[str, float | None]
    columns: list[str]
    means: dict[str, float]
    scales: dict[str, float]
    dropped_columns: list[str]

    @classmethod
    def fit(cls, rows: list[dict[str, Any]]) -> "TrainPreprocessor":
        feature_imputation: dict[str, float | None] = {}
        for feature in BASE_FEATURES:
            observed = [float(row["features"][feature]) for row in rows if row["features"][feature] is not None]
            feature_imputation[feature] = sum(observed) / len(observed) if observed else None
        candidate_columns = [
            feature for feature in BASE_FEATURES if feature_imputation[feature] is not None
        ]
        entirely_unavailable = [
            feature for feature in BASE_FEATURES if feature_imputation[feature] is None
        ]
        for feature in BASE_FEATURES:
            candidate_columns.extend((f"{feature}__imputed", f"{feature}__unavailable"))

        def raw_value(row: dict[str, Any], column: str) -> float:
            if column.endswith("__imputed"):
                return float(row["imputation_indicators"][column.removesuffix("__imputed")])
            if column.endswith("__unavailable"):
                return float(row["unavailable_indicators"][column.removesuffix("__unavailable")])
            value = row["features"][column]
            fill = feature_imputation[column]
            if value is None:
                if fill is None:
                    raise ValueError(f"Feature {column} was entirely unavailable in Train")
                return float(fill)
            return float(value)

        columns: list[str] = []
        dropped: list[str] = list(entirely_unavailable)
        means: dict[str, float] = {}
        scales: dict[str, float] = {}
        for column in candidate_columns:
            values = [raw_value(row, column) for row in rows]
            mean = sum(values) / len(values)
            variance = sum((value - mean) ** 2 for value in values) / len(values)
            scale = math.sqrt(variance)
            if scale <= 1e-12:
                dropped.append(column)
                continue
            columns.append(column)
            means[column] = mean
            scales[column] = scale
        return cls(feature_imputation, columns, means, scales, dropped)

    def _raw_value(self, row: dict[str, Any], column: str) -> float:
        if column.endswith("__imputed"):
            return float(row["imputation_indicators"][column.removesuffix("__imputed")])
        if column.endswith("__unavailable"):
            return float(row["unavailable_indicators"][column.removesuffix("__unavailable")])
        value = row["features"][column]
        if value is None:
            fill = self.feature_imputation[column]
            if fill is None:
                raise ValueError(f"Feature {column} was entirely unavailable in Train")
            return float(fill)
        return float(value)

    def transform(self, rows: list[dict[str, Any]]) -> list[list[float]]:
        return [
            [(self._raw_value(row, column) - self.means[column]) / self.scales[column] for column in self.columns]
            for row in rows
        ]

    def as_dict(self) -> dict[str, Any]:
        return {
            "fit_scope": "train_only",
            "feature_imputation": self.feature_imputation,
            "columns": self.columns,
            "means": self.means,
            "scales": self.scales,
            "dropped_constant_columns": self.dropped_columns,
            "unavailable_policy": "train_mean_imputation_plus_explicit_indicator",
        }


@dataclass
class LogisticModel:
    intercept: float
    coefficients: list[float]
    l2_strength: float
    iterations: int
    converged: bool

    def predict(self, matrix: list[list[float]]) -> list[float]:
        return [sigmoid(self.intercept + sum(weight * value for weight, value in zip(self.coefficients, row))) for row in matrix]


def _solve_linear(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [list(matrix[row]) + [vector[row]] for row in range(size)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            augmented[pivot][column] += 1e-8
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        for item in range(column, size + 1):
            augmented[column][item] /= divisor
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            if factor == 0:
                continue
            for item in range(column, size + 1):
                augmented[row][item] -= factor * augmented[column][item]
    return [augmented[row][size] for row in range(size)]


def _objective(matrix: list[list[float]], labels: list[int], weights: list[float], l2: float) -> float:
    total = 0.0
    for row, label in zip(matrix, labels):
        probability = clamp(sigmoid(weights[0] + sum(w * x for w, x in zip(weights[1:], row))), 1e-15, 1 - 1e-15)
        total += -(label * math.log(probability) + (1 - label) * math.log(1 - probability))
    return total / len(labels) + 0.5 * l2 * sum(weight * weight for weight in weights[1:])


def fit_logistic(
    matrix: list[list[float]],
    labels: list[int],
    *,
    l2_strength: float,
    max_iterations: int = 100,
    tolerance: float = 1e-8,
) -> LogisticModel:
    if not matrix or len(matrix) != len(labels):
        raise ValueError("Training matrix and labels must be non-empty and aligned")
    dimensions = len(matrix[0])
    mean_target = clamp(sum(labels) / len(labels), 1e-6, 1 - 1e-6)
    weights = [math.log(mean_target / (1 - mean_target))] + [0.0] * dimensions
    converged = False
    iteration = 0
    for iteration in range(1, max_iterations + 1):
        gradient = [0.0] * (dimensions + 1)
        hessian = [[0.0] * (dimensions + 1) for _ in range(dimensions + 1)]
        for row, label in zip(matrix, labels):
            augmented = [1.0] + row
            probability = sigmoid(sum(weight * value for weight, value in zip(weights, augmented)))
            residual = probability - label
            curvature = max(probability * (1 - probability), 1e-9)
            for left in range(dimensions + 1):
                gradient[left] += residual * augmented[left] / len(labels)
                for right in range(dimensions + 1):
                    hessian[left][right] += curvature * augmented[left] * augmented[right] / len(labels)
        hessian[0][0] += 1e-9
        for index in range(1, dimensions + 1):
            gradient[index] += l2_strength * weights[index]
            hessian[index][index] += l2_strength
        delta = _solve_linear(hessian, gradient)
        current = _objective(matrix, labels, weights, l2_strength)
        step = 1.0
        candidate = [weight - step * change for weight, change in zip(weights, delta)]
        while _objective(matrix, labels, candidate, l2_strength) > current and step > 1 / 128:
            step /= 2
            candidate = [weight - step * change for weight, change in zip(weights, delta)]
        weights = candidate
        if max(abs(step * change) for change in delta) < tolerance:
            converged = True
            break
    return LogisticModel(weights[0], weights[1:], l2_strength, iteration, converged)


def probability_metrics(labels: list[int], probabilities: list[float]) -> dict[str, Any]:
    if not labels or len(labels) != len(probabilities):
        raise ValueError("Labels and probabilities must be non-empty and aligned")
    bins: dict[int, list[tuple[float, int]]] = defaultdict(list)
    brier = log_loss = 0.0
    correct = 0
    high_confidence: list[tuple[float, int]] = []
    for label, raw_probability in zip(labels, probabilities):
        probability = clamp(float(raw_probability), 1e-15, 1 - 1e-15)
        brier += (probability - label) ** 2
        log_loss += -(label * math.log(probability) + (1 - label) * math.log(1 - probability))
        correct += int((probability >= 0.5) == bool(label))
        bins[min(int(probability * 10), 9)].append((probability, label))
        if probability >= 0.75 or probability <= 0.25:
            high_confidence.append((probability, label))
    total = len(labels)
    calibration = []
    ece = 0.0
    for index in range(10):
        values = bins.get(index, [])
        if not values:
            continue
        mean_probability = sum(item[0] for item in values) / len(values)
        actual_rate = sum(item[1] for item in values) / len(values)
        ece += len(values) / total * abs(mean_probability - actual_rate)
        calibration.append({
            "probability_bin": f"{index * 10}-{(index + 1) * 10}%",
            "n": len(values),
            "mean_predicted_a": round(mean_probability, 6),
            "actual_a_win_rate": round(actual_rate, 6),
            "absolute_gap": round(abs(mean_probability - actual_rate), 6),
        })
    high_correct = sum(int((probability >= 0.5) == bool(label)) for probability, label in high_confidence)
    mean_probability = sum(probabilities) / total
    variance = sum((probability - mean_probability) ** 2 for probability in probabilities) / total
    return {
        "n": total,
        "brier_score": round(brier / total, 8),
        "log_loss": round(log_loss / total, 8),
        "accuracy": round(correct / total, 8),
        "ece_10_bin": round(ece, 8),
        "calibration": calibration,
        "probability_distribution": {
            "minimum": round(min(probabilities), 8),
            "maximum": round(max(probabilities), 8),
            "mean": round(mean_probability, 8),
            "standard_deviation": round(math.sqrt(variance), 8),
            "high_confidence_count": len(high_confidence),
            "high_confidence_accuracy": round(high_correct / len(high_confidence), 8) if high_confidence else None,
        },
    }


def _verdict(test_metrics: dict[str, dict[str, Any]]) -> tuple[str, list[str]]:
    """Predeclared conservative rule; Test is not used to change this threshold."""
    challenger = test_metrics["logistic_c1"]
    baselines = [test_metrics["elo"], test_metrics["champion_v1_replay_proxy"]]
    best_brier = min(item["brier_score"] for item in baselines)
    best_log_loss = min(item["log_loss"] for item in baselines)
    best_accuracy = max(item["accuracy"] for item in baselines)
    better = (
        challenger["brier_score"] <= best_brier - 0.002
        and challenger["log_loss"] <= best_log_loss - 0.005
        and challenger["accuracy"] >= best_accuracy - 0.01
    )
    worse = (
        challenger["brier_score"] >= best_brier + 0.002
        and challenger["log_loss"] >= best_log_loss + 0.005
    )
    if better:
        return "CHALLENGER_HISTORICALLY_BETTER", [
            "C1 cleared the predeclared Brier and Log Loss margins against the best baseline.",
            "C1 accuracy was not more than one percentage point below the best baseline.",
        ]
    if worse:
        return "CHALLENGER_NOT_BETTER", [
            "C1 was worse than the best baseline by the predeclared Brier and Log Loss margins."
        ]
    return "INCONCLUSIVE", [
        "C1 did not clear either the predeclared superiority rule or the joint inferiority rule.",
        "The Champion comparison is a declared partial replay proxy because exact BP, true Patch, and several frozen factors are unavailable.",
    ]


def evaluate_models(
    connection: sqlite3.Connection,
    rows: list[dict[str, Any]],
    config: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    train = [row for row in rows if row["split"] == "train"]
    validation = [row for row in rows if row["split"] == "validation"]
    test = [row for row in rows if row["split"] == "test"]
    preprocessor = TrainPreprocessor.fit(train)
    train_matrix = preprocessor.transform(train)
    validation_matrix = preprocessor.transform(validation)
    test_matrix = preprocessor.transform(test)
    train_labels = [row["target_a_win"] for row in train]
    validation_labels = [row["target_a_win"] for row in validation]
    test_labels = [row["target_a_win"] for row in test]

    candidates = []
    fitted: dict[float, LogisticModel] = {}
    for strength in REGULARIZATION_GRID:
        model = fit_logistic(train_matrix, train_labels, l2_strength=strength)
        fitted[strength] = model
        metrics = probability_metrics(validation_labels, model.predict(validation_matrix))
        candidates.append({
            "l2_strength": strength,
            "validation_metrics": metrics,
            "iterations": model.iterations,
            "converged": model.converged,
        })
    selected = min(candidates, key=lambda item: (item["validation_metrics"]["log_loss"], -item["l2_strength"]))
    logistic = fitted[selected["l2_strength"]]

    target_ids = [row["match_id"] for row in rows]
    elo_map = simple_elo_probabilities(connection, target_ids, base_rating=1500.0, scale=400.0, k=32.0)
    test_probabilities = {
        "elo": [elo_map[row["match_id"]] for row in test],
        "champion_v1_replay_proxy": [champion_v1_replay_probability(row, config) for row in test],
        "logistic_c1": logistic.predict(test_matrix),
    }
    test_metrics = {
        model: probability_metrics(test_labels, probabilities)
        for model, probabilities in test_probabilities.items()
    }
    verdict, reasons = _verdict(test_metrics)
    coefficients = []
    for column, coefficient in zip(preprocessor.columns, logistic.coefficients):
        coefficients.append({
            "feature": column,
            "standardized_coefficient": round(coefficient, 8),
            "raw_scale_coefficient": round(coefficient / preprocessor.scales[column], 8),
            "direction": "team_a" if coefficient > 0 else "team_b" if coefficient < 0 else "neutral",
            "absolute_rank_value": round(abs(coefficient), 8),
        })
    coefficients.sort(key=lambda item: item["absolute_rank_value"], reverse=True)
    predictions = []
    for index, row in enumerate(test):
        predictions.append({
            "match_id": row["match_id"], "played_at": row["played_at"],
            "team_a": row["team_a"], "team_b": row["team_b"],
            "target_a_win": row["target_a_win"],
            "elo_probability_a": round(test_probabilities["elo"][index], 8),
            "champion_v1_replay_proxy_probability_a": round(test_probabilities["champion_v1_replay_proxy"][index], 8),
            "logistic_c1_probability_a": round(test_probabilities["logistic_c1"][index], 8),
        })
    evaluation = {
        "dataset_version": DATASET_VERSION,
        "evaluation_scope": "offline_historical_only",
        "test_evaluated_once_after_protocol_freeze": True,
        "elo": {"base_rating": 1500.0, "scale": 400.0, "k": 32.0,
                "result_update": "binary outcome after match; equal-time matches update as a batch"},
        "champion_v1_replay": {
            "model_version": "v1.0.0",
            "status": "FROZEN_BENCHMARK_PARTIAL_REPLAY_PROXY",
            "replayable": ["team_rating", "recent_form", "player_form", "roster_continuity"],
            "proxy": ["map_pool: prior-only active-map mean with fixed 50/50 shrink toward team rating"],
            "unavailable": ["true_patch", "patch_fit", "exact_bp_veto", "target_maps",
                            "official_pre_match_roster", "international_experience",
                            "series_adaptability", "tactical_matchup"],
            "frozen_weights": config["weights"],
        },
        "logistic_c1": {
            "features": list(BASE_FEATURES),
            "preprocessor": preprocessor.as_dict(),
            "regularization_selection": {
                "metric": "validation_log_loss",
                "grid": list(REGULARIZATION_GRID),
                "candidates": candidates,
                "selected_l2_strength": selected["l2_strength"],
            },
            "intercept": round(logistic.intercept, 8),
            "coefficients": coefficients,
            "iterations": logistic.iterations,
            "converged": logistic.converged,
        },
        "test_metrics": test_metrics,
        "verdict_rule": {
            "better": "Brier improves >=0.002 and Log Loss improves >=0.005 versus best baseline; Accuracy no worse by >0.01",
            "worse": "Brier worse >=0.002 and Log Loss worse >=0.005 versus best baseline",
            "otherwise": "INCONCLUSIVE",
        },
        "verdict": verdict,
        "verdict_reasons": reasons,
    }
    return evaluation, predictions


def status_counts(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    return {
        feature: {status: sum(row["feature_status"][feature] == status for row in rows) for status in STATUS_VALUES}
        for feature in BASE_FEATURES
    }
