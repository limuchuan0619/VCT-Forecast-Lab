"""项目常量、中文地图规范名与默认模型参数。"""

from __future__ import annotations

MAPS = {
    "bind": "源工重镇",
    "haven": "隐世修所",
    "split": "霓虹町",
    "ascent": "亚海悬城",
    "icebox": "森寒冬港",
    "breeze": "微风岛屿",
    "fracture": "裂变峡谷",
    "pearl": "深海明珠",
    "lotus": "莲华古城",
    "sunset": "日落之城",
    "abyss": "幽邃地窟",
    "corrode": "盐海矿镇",
    "summit": "天枢云阙",
}

MAP_ALIASES = {
    **{key: key for key in MAPS},
    **{key.upper(): key for key in MAPS},
    **{name: key for key, name in MAPS.items()},
    # 常见但不规范的写法仅用于输入兼容，输出始终使用上面的规范中文名。
    "分裂之地": "split",
    "裂变之地": "split",
    "深窟幽境": "abyss",
    "晶蚀之地": "corrode",
    "顶峰亭阁": "summit",
}

REGIONS = {"CN", "EMEA", "AMERICAS", "PACIFIC"}
SERIES_FORMATS = {"bo3": 2, "bo5": 3}

DEFAULT_WEIGHTS = {
    # 除 rating/map 外，其余因子作为 log-odds 调整，值越大影响越明显。
    "recent_form": 0.70,
    "player_form": 0.32,
    "roster_continuity": 0.30,
    "patch_fit": 0.22,
    "international_experience": 0.20,
    "series_adaptability": 0.22,
    "tactical_matchup": 0.24,
}

DEFAULT_CONFIG = {
    "base_rating": 1500.0,
    "elo_scale": 400.0,
    "series_k": 45.0,
    "map_k": 18.0,
    "form_half_life_days": 70.0,
    "form_window_days": 180,
    "map_prior_matches": 8.0,
    "monte_carlo_runs": 20000,
    "weights": {**DEFAULT_WEIGHTS, "recent_form": 0.45},
}


def normalize_map(value: str) -> str:
    """将中英文地图名规范化为稳定的英文 ID。"""
    raw = value.strip()
    key = MAP_ALIASES.get(raw, MAP_ALIASES.get(raw.lower()))
    if key is None:
        allowed = "、".join(MAPS.values())
        raise ValueError(f"未知地图 {value!r}；支持：{allowed}")
    return key


def chinese_map(value: str) -> str:
    return MAPS[normalize_map(value)]
