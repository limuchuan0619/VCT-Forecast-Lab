"""Live coverage policy, independent of frozen model parameters/history import."""
from __future__ import annotations

import re

COVERAGE_VERSION = "four-region-coverage-v1"
PRIMARY_CLASSES = {"regional", "international"}
PREDICTABLE_CLASSES = PRIMARY_CLASSES | {"qualification", "secondary", "invitational"}
REGION_FILTERS = (("CN", "24"), ("EMEA", "27"), ("AMERICAS", "26"), ("PACIFIC", "28"))


def flag_region(flag: str) -> str:
    # Source country flags are only a coverage hint, not team nationality/rosters.
    groups = {
        "CN": {"cn"},
        "AMERICAS": set("us ca mx br ar cl co pe ve ec uy py bo cr pa gt sv hn ni cu do pr".split()),
        "PACIFIC": set("kr jp tw hk mo mn th vn id my sg ph in pk bd lk np bt au nz kh la mm bn".split()),
        "EMEA": set("gb uk ie fr de es pt it nl be lu dk se no fi is pl cz sk hu ro bg gr tr ru ua by lt lv ee rs hr si ba me mk al ch at cy mt il sa ae qa kw bh om jo lb iq ir eg ma dz tn ly za ng ke gh sn".split()),
    }
    return next((region for region, countries in groups.items() if flag in countries), "OTHER")


def event_policy(title: str, source_region: str = "OTHER") -> dict[str, str | bool]:
    text = title.casefold()
    named_region = next((region for pattern, region in (
        (r"\b(china|cn)\b|中国", "CN"), (r"\bemea\b", "EMEA"),
        (r"\b(americas|north america|latin america|brazil)\b", "AMERICAS"),
        (r"\b(pacific|oceania|southeast asia|south asia)\b", "PACIFIC"),
    ) if re.search(pattern, text)), None)
    region = named_region or source_region
    is_vct = bool(re.search(r"\bvct\b|champions tour", text))
    if re.search(r"show\s*match|exhibition|all[- ]?stars?|表演赛|娱乐赛", text):
        kind = "exhibition"
    elif "game changers" in text:
        kind = "separate_circuit"
    elif re.search(r"academy|collegiate|university|campus", text):
        kind = "development"
    elif (is_vct or re.search(r"^valorant (masters|champions)\b", text)) and re.search(r"qualif|ascension|threshold|\bopens?\b|资格|晋升",text):
        kind = "qualification"
    elif re.search(r"valorant masters|^valorant champions\s", text) or (is_vct and "masters" in text):
        kind, region = "international", "INTERNATIONAL"
    elif re.search(r"esports world cup|esports nations cup", text):
        kind, region = "invitational", "INTERNATIONAL"
    elif is_vct and re.search(r"kickoff|stage\s*[12]|\bcups?\s*\d*", text):
        kind = "regional"
    elif re.search(r"invitational|off[- ]?season|home ground|red bull|\bfgc\b|monsters reloaded|spotlight|radiant invitational", text):
        kind = "invitational"
    elif re.search(r"challengers|evolution series|national (tournament|competition)|spike (series|tour)|elite.*league|kaizen.*championship", text):
        kind = "secondary"
    else:
        kind = "unclassified"
    if region not in {"CN", "EMEA", "AMERICAS", "PACIFIC", "INTERNATIONAL"}:
        region = "OTHER"
    predictable = kind in PREDICTABLE_CLASSES and region != "OTHER"
    return {
        "region": region, "classification": kind, "watched": True,
        "included": predictable, "prediction_policy": "quality_gate_required" if predictable else "observe_only",
        "evaluation_cohort": "primary_vct" if kind in PRIMARY_CLASSES else kind,
        "region_provenance": "event_title" if named_region else "source_region_index_or_flag",
        "classification_provenance": "event_name_policy_not_official_tier",
    }


def can_predict(classification: str, region: str) -> bool:
    return classification in PREDICTABLE_CLASSES and region in {"CN", "EMEA", "AMERICAS", "PACIFIC", "INTERNATIONAL"}


def is_primary(classification: str) -> bool:
    return classification in PRIMARY_CLASSES
