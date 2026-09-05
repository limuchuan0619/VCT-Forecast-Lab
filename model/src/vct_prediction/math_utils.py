"""无第三方依赖的数值辅助函数。"""

from __future__ import annotations

import math
from datetime import datetime


EPSILON = 1e-15


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def logistic_rating(diff: float, scale: float = 400.0) -> float:
    """Elo 评分差转胜率。diff > 0 表示 A 更强。"""
    return 1.0 / (1.0 + 10.0 ** (-diff / scale))


def logit(probability: float) -> float:
    p = clamp(probability, EPSILON, 1.0 - EPSILON)
    return math.log(p / (1.0 - p))


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def probability_with_adjustments(base_probability: float, adjustments: list[float]) -> float:
    return clamp(sigmoid(logit(base_probability) + sum(adjustments)), 0.01, 0.99)


def patch_distance(old_patch: str | None, new_patch: str | None) -> float:
    """返回简化版本距离；跨主版本明显加大距离。"""
    if not old_patch or not new_patch or old_patch == new_patch:
        return 0.0
    try:
        old_major, old_minor = (int(x) for x in old_patch.split(".", 1))
        new_major, new_minor = (int(x) for x in new_patch.split(".", 1))
    except (ValueError, AttributeError):
        return 1.0
    return abs(new_major - old_major) * 3.0 + min(abs(new_minor - old_minor), 3) / 3.0


def parse_timestamp(value: str, field: str = "timestamp") -> datetime:
    """解析带时区的 ISO 8601 时间，拒绝会导致回测歧义的本地裸时间。"""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{field} 必须是 ISO 8601 时间") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} 必须包含时区，例如 +08:00")
    return parsed
