"""只评估赛前已锁定预测，计算概率预测与比分预测指标。"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

from .db import Database
from .math_utils import clamp


def evaluate(db: Database, source: str | None = None) -> dict[str, Any]:
    where = (
        "p.status='resolved' AND p.locked_at <= m.played_at "
        "AND COALESCE(pp.evaluation_eligible, 1)=1"
    )
    params: list[Any] = []
    if source and source != "all":
        where += " AND p.source=?"
        params.append(source)
    with db.connect() as conn:
        rows = conn.execute(
            f"""SELECT p.*, m.played_at
                FROM predictions p JOIN matches m ON m.match_id=p.resolved_match_id
                LEFT JOIN prediction_provenance pp ON pp.prediction_id=p.prediction_id
                WHERE {where} ORDER BY p.locked_at""",
            params,
        ).fetchall()
    groups: dict[str, list[Any]] = defaultdict(list)
    for row in rows:
        groups[row["source"]].append(row)
    return {
        "evaluation_rule": "仅包含赛前顺序可验证、已结算且 evaluation_eligible=1 的预测",
        "overall": _metrics(rows),
        "by_source": {key: _metrics(group) for key, group in sorted(groups.items())},
    }


def _metrics(rows: list[Any]) -> dict[str, Any]:
    if not rows:
        return {
            "n": 0,
            "accuracy": None,
            "brier_score": None,
            "log_loss": None,
            "exact_score_accuracy": None,
            "calibration": [],
        }
    correct = 0
    exact = 0
    brier = 0.0
    log_loss = 0.0
    bins: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for row in rows:
        outcome_a = 1 if row["actual_winner_id"] == row["team_a_id"] else 0
        p = clamp(float(row["team_a_win_probability"]), 1e-15, 1.0 - 1e-15)
        correct += int(row["predicted_winner_id"] == row["actual_winner_id"])
        exact += int(row["predicted_score"] == row["actual_score"])
        brier += (p - outcome_a) ** 2
        log_loss += -(outcome_a * math.log(p) + (1 - outcome_a) * math.log(1 - p))
        bins[min(int(p * 10), 9)].append((p, outcome_a))
    n = len(rows)
    calibration = [
        {
            "probability_bin": f"{index * 10}-{(index + 1) * 10}%",
            "n": len(values),
            "mean_predicted_a": round(sum(item[0] for item in values) / len(values), 4),
            "actual_a_win_rate": round(sum(item[1] for item in values) / len(values), 4),
        }
        for index, values in sorted(bins.items())
    ]
    return {
        "n": n,
        "accuracy": round(correct / n, 6),
        "brier_score": round(brier / n, 6),
        "log_loss": round(log_loss / n, 6),
        "exact_score_accuracy": round(exact / n, 6),
        "calibration": calibration,
    }
