"""Traceable VLR.gg collector for completed VCT match facts.

VLR is a community source rather than a Riot-operated API. Every imported
entity keeps its public page URL, raw HTML snapshot and content hash so a
later audit can reproduce exactly what entered the model.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from ..constants import normalize_map
from ..competition import COVERAGE_VERSION, REGION_FILTERS, event_policy, flag_region


BASE_URL = "https://www.vlr.gg"
USER_AGENT = "VCTPredictionModel/1.0 (local research; contact: local-user)"
REGION_TOKENS = {
    "americas": "AMERICAS",
    "emea": "EMEA",
    "pacific": "PACIFIC",
    "china": "CN",
}
EXCLUDED_EVENT_TOKENS = (
    "game changers",
    "challengers",
    "ascension",
    "academy",
    "collegiate",
    "qualifier",
    "offseason",
)


def _load_dependencies():
    try:
        import httpx
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - surfaced by CLI
        raise RuntimeError(
            "真实数据同步需要 httpx[socks] 与 beautifulsoup4；请运行 Install-VCT-Web.cmd"
        ) from exc
    return httpx, BeautifulSoup


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _clean(value: str | None) -> str:
    return " ".join((value or "").replace("\ufffd", "").split())


def _number(value: str | None, *, percent: bool = False) -> float | None:
    raw = _clean(value).replace("%", "")
    if not raw or raw in {"-", "N/A"}:
        return None
    try:
        number = float(raw)
    except ValueError:
        return None
    return number / 100.0 if percent else number


def _integer(value: str | None) -> int | None:
    number = _number(value)
    return int(number) if number is not None else None


def _complete_competitive_map_score(team_a_rounds: int, team_b_rounds: int) -> bool:
    """Return whether a VCT map score is terminal under standard win-by-two rules.

    VLR can expose a series-level winner while the final map panels are still
    updating. Merely counting the currently leading team as the map winner can
    therefore turn a live 6-3 or 4-1 panel into a false completed result.
    """
    winner = max(team_a_rounds, team_b_rounds)
    loser = min(team_a_rounds, team_b_rounds)
    if loser < 0 or winner < 13:
        return False
    return loser <= 11 if winner == 13 else winner - loser == 2


def validate_series_finality(
    series_format: str,
    source_status: str,
    source_score: tuple[int, int] | None,
    maps: list[dict[str, Any]],
) -> tuple[str, str | None]:
    """Deterministically prove a normal VCT series is final and self-consistent."""
    if source_status.strip().lower() != "final":
        return "REVISION_PENDING", "source_status_not_final"
    wins_needed = 3 if series_format == "bo5" else 2
    if not maps:
        return "REVISION_PENDING", "map_evidence_missing"
    for index, item in enumerate(maps, start=1):
        if int(item.get("map_order", 0)) != index:
            return "RESULT_INCONSISTENT", "map_order_inconsistent"
        if not _complete_competitive_map_score(int(item["team_a_rounds"]), int(item["team_b_rounds"])):
            return "REVISION_PENDING", "incomplete_map_score"
    team_a_maps = sum(int(item["team_a_rounds"]) > int(item["team_b_rounds"]) for item in maps)
    team_b_maps = len(maps) - team_a_maps
    reconstructed = (team_a_maps, team_b_maps)
    if max(reconstructed) != wins_needed or min(reconstructed) >= wins_needed:
        return "REVISION_PENDING", "series_not_terminal"
    if source_score is None:
        return "REVISION_PENDING", "source_series_score_missing"
    if source_score != reconstructed:
        return "RESULT_INCONSISTENT", "source_map_series_conflict"
    return "FINAL_CANDIDATE", None


def _year(title: str) -> int | None:
    match = re.search(r"\b(20\d{2})\b", title)
    return int(match.group(1)) if match else None


def classify_event(title: str) -> tuple[bool, str, str]:
    lower = title.lower()
    if any(token in lower for token in EXCLUDED_EVENT_TOKENS):
        return False, "OTHER", "excluded"
    region = next((value for token, value in REGION_TOKENS.items() if token in lower), None)
    is_vct = "vct" in lower or "champions tour" in lower
    is_regional = bool(region and is_vct and any(token in lower for token in ("kickoff", "stage 1", "stage 2")))
    is_international = (
        ("valorant masters" in lower or (is_vct and "masters" in lower))
        or lower.startswith("valorant champions ")
    )
    if is_regional:
        return True, region or "OTHER", "regional"
    if is_international:
        return True, "INTERNATIONAL", "international"
    return False, region or "OTHER", "excluded"


def competition_cohort(event_name: str, played_at: str) -> str:
    """Return a transparent event-version cohort when exact event patch is absent."""
    year = _year(event_name) or datetime.fromisoformat(played_at.replace("Z", "+00:00")).year
    lower = event_name.lower()
    for label, token in (
        ("kickoff", "kickoff"),
        ("stage1", "stage 1"),
        ("stage2", "stage 2"),
        ("masters", "masters"),
        ("champions", "champions"),
    ):
        if token in lower:
            return f"cohort:{year}-{label}"
    return f"cohort:{year}-other"


@dataclass
class FetchResult:
    url: str
    text: str
    fetched_at: str
    content_hash: str
    raw_path: str


class VlrClient:
    def __init__(
        self,
        snapshot_root: str | Path,
        *,
        delay_seconds: float = 0.18,
        retry_delays: tuple[float, ...] = (5.0, 20.0),
    ):
        httpx, BeautifulSoup = _load_dependencies()
        self.httpx = httpx
        self.BeautifulSoup = BeautifulSoup
        self.snapshot_root = Path(snapshot_root)
        self.snapshot_root.mkdir(parents=True, exist_ok=True)
        self.delay_seconds = max(0.0, delay_seconds)
        self.retry_delays = tuple(max(0.0, float(item)) for item in retry_delays)
        self.retry_count = 0
        self.retry_log: list[dict[str, Any]] = []
        self.link_observations: dict[str, dict[str, Any]] = {}
        self.discovery_report: dict[str, Any] = {}
        self._response_cache: dict[str, FetchResult] = {}
        self._cache_responses = False
        self.client = httpx.Client(
            headers={"User-Agent": USER_AGENT},
            timeout=30,
            follow_redirects=True,
        )
        self._last_request = 0.0

    def close(self) -> None:
        self.client.close()

    def fetch(self, path_or_url: str) -> FetchResult:
        url = path_or_url if path_or_url.startswith("http") else urljoin(BASE_URL, path_or_url)
        if self._cache_responses and url in self._response_cache:
            return self._response_cache[url]
        response = None
        last_error: Exception | None = None
        attempts = len(self.retry_delays) + 1
        for attempt in range(attempts):
            wait = self.delay_seconds - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            try:
                response = self.client.get(url)
                self._last_request = time.monotonic()
                response.raise_for_status()
                break
            except (self.httpx.TransportError, self.httpx.HTTPStatusError) as exc:
                last_error = exc
                status = getattr(getattr(exc, "response", None), "status_code", None)
                retryable = status is None or status == 429 or status >= 500
                if not retryable or attempt >= attempts - 1:
                    break
                delay = self.retry_delays[attempt]
                self.retry_count += 1
                self.retry_log.append({
                    "url": url,
                    "attempt": attempt + 1,
                    "delay_seconds": delay,
                    "error_type": type(exc).__name__,
                })
                if delay > 0:
                    time.sleep(delay)
        if response is None or last_error is not None and response.is_error:
            detail = f"{type(last_error).__name__}: {last_error}" if last_error else "unknown error"
            raise RuntimeError(f"数据源请求失败（共尝试 {attempts} 次）：{url}；{detail}") from last_error
        content_hash = _hash_bytes(response.content)
        raw_name = f"{content_hash[:16]}.html"
        raw_path = self.snapshot_root / raw_name
        if not raw_path.exists():
            raw_path.write_bytes(response.content)
        result = FetchResult(
            url=str(response.url),
            text=response.text,
            fetched_at=_now(),
            content_hash=content_hash,
            raw_path=str(raw_path),
        )
        if self._cache_responses:
            self._response_cache[url] = result
        return result

    def soup(self, result: FetchResult):
        return self.BeautifulSoup(result.text, "html.parser")

    def discover_events(self, start_year: int, end_year: int) -> list[dict[str, Any]]:
        events: dict[str, dict[str, Any]] = {}
        page = 1
        while True:
            result = self.fetch(f"/events/?series_id=all&region=all&tier=60&page={page}")
            soup = self.soup(result)
            for item in soup.select("a.event-item[href^='/event/']"):
                href = item.get("href", "")
                match = re.match(r"/event/(\d+)/([^/?#]+)", href)
                title_node = item.select_one(".event-item-title")
                if not match or not title_node:
                    continue
                title = _clean(title_node.get_text(" ", strip=True))
                event_year = _year(title)
                if event_year is None or not start_year <= event_year <= end_year:
                    continue
                included, region, classification = classify_event(title)
                status_node = item.select_one(".event-item-desc-item-status")
                events[match.group(1)] = {
                    "external_event_id": match.group(1),
                    "slug": match.group(2),
                    "name": title,
                    "year": event_year,
                    "region": region,
                    "classification": classification,
                    "status": _clean(status_node.get_text(" ", strip=True) if status_node else None),
                    "source_url": urljoin(BASE_URL, href),
                    "included": included,
                    "fetched_at": result.fetched_at,
                    "raw_path": result.raw_path,
                    "content_hash": result.content_hash,
                }
            next_link = soup.select_one("link[rel='next']")
            if not next_link:
                break
            page += 1
            if page > 20:
                raise RuntimeError("VLR 赛事分页超过安全上限 20 页")
        return sorted(events.values(), key=lambda item: (item["year"], item["external_event_id"]))

    def discover_live_events(self, now: datetime) -> list[dict[str, Any]]:
        """Five bounded all-tier indexes; never walk the historical pagination.

        Active future seasons/yearless events are retained. Region query IDs are
        taken from source navigation, not inferred from a URL path like /china/.
        """
        events: dict[str, dict[str, Any]] = {}
        self._cache_responses = True
        report: dict[str, Any] = {"schema_version": COVERAGE_VERSION, "index_requests": 0,
            "regions_checked": [], "index_failures": [], "historical_pages_followed": 0}
        indexes = [("OTHER", "/events/?region=all&tier=all")]
        indexes += [(region, f"/events/?region={identifier}&tier=all") for region, identifier in REGION_FILTERS]
        for region, path in indexes:
            report["index_requests"] += 1
            try:
                result = self.fetch(path)
                soup = self.soup(result)
                if not soup.select("a.event-item"):
                    # Empty regional calendars are valid only with recognizable navigation.
                    if not soup.select("a[href*='region=']"):
                        raise ValueError("event_index_structure_unrecognized")
                if region != "OTHER":
                    report["regions_checked"].append(region)
                for item in soup.select("a.event-item[href^='/event/']"):
                    match = re.match(r"/event/(\d+)/([^/?#]+)", item.get("href", ""))
                    title_node = item.select_one(".event-item-title")
                    if not match or not title_node:
                        continue
                    title = _clean(title_node.get_text(" ", strip=True))
                    status_node = item.select_one(".event-item-desc-item-status")
                    status = _clean(status_node.get_text(" ", strip=True) if status_node else "unknown").lower()
                    flag = item.select_one(".mod-location .flag")
                    country = next((c[4:] for c in (flag.get("class", []) if flag else []) if c.startswith("mod-")), "")
                    hint = region if region != "OTHER" else flag_region(country)
                    policy = event_policy(title, hint)
                    date_node = item.select_one(".mod-dates")
                    date_text = _clean(date_node.get_text(" ", strip=True) if date_node else "")
                    recent = self._recent_completed_event(date_text, _year(title), now)
                    value = {"external_event_id": match.group(1), "slug": match.group(2), "name": title,
                        "year": _year(title), "status": status, "source_dates": date_text,
                        "source_country_flag": country, "source_url": urljoin(BASE_URL,item["href"]),
                        "fetched_at":result.fetched_at,"raw_path":result.raw_path,"content_hash":result.content_hash,
                        "scan_matches": status in {"upcoming", "ongoing"} or (status == "completed" and recent), **policy}
                    previous = events.get(match.group(1))
                    # An explicit source-region index may resolve a yearless/global unknown.
                    if previous is None or (previous["region"] == "OTHER" and value["region"] != "OTHER"):
                        events[match.group(1)] = value
            except Exception as exc:
                report["index_failures"].append({"region":region,"url":urljoin(BASE_URL,path),"error":str(exc)[:250]})
        report["events_discovered"] = len(events)
        report["indexes_complete"] = not report["index_failures"] and len(report["regions_checked"]) == 4
        report["coverage_scope"] = "first_page_active_and_recent_source_events_not_all_real_world_matches"
        self.discovery_report = report
        return sorted(events.values(),key=lambda e: (0 if e["region"] == "CN" else 1, not e["scan_matches"], e["name"],e["external_event_id"]))

    @staticmethod
    def _recent_completed_event(text: str, year: int | None, now: datetime) -> bool:
        parts = re.findall(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})",text,re.I)
        if not parts:
            return False
        month, day = parts[-1]
        # A same-month range such as Oct 17–19 uses its trailing day.
        trailing = re.search(r"[–—-]\s*(\d{1,2})(?:\s+Dates)?\s*$",text)
        if trailing:
            day=trailing.group(1)
        try:
            end=datetime.strptime(f"{year or now.year} {month} {day}","%Y %b %d").replace(tzinfo=timezone.utc)
            return -1 <= (now-end).total_seconds()/86400 <= 7
        except ValueError:
            return False

    def event_match_links(self, event: dict[str, Any]) -> tuple[list[str], FetchResult]:
        path = f"/event/matches/{event['external_event_id']}/{event['slug']}/?series_id=all"
        result = self.fetch(path)
        soup = self.soup(result)
        links: list[str] = []
        for item in soup.select("a.wf-module-item.match-item[href]"):
            href = item.get("href", "")
            if re.match(r"/\d+/", href) and href not in links:
                links.append(href)
                names=[_clean(n.get_text(" ",strip=True)) for n in item.select(".match-item-vs-team-name")]
                status_node=item.select_one(".ml-status")
                self.link_observations[href] = {"source_url":urljoin(BASE_URL,href),"content_hash":result.content_hash,
                    "raw_path":result.raw_path,"fetched_at":result.fetched_at,
                    "source_status":_clean(status_node.get_text(" ",strip=True) if status_node else "").casefold(),
                    "unresolved_teams": bool(names) and all(n.casefold() in {"tbd","tba","-",""} for n in names)}
        return links, result

    def parse_fixture(self, href: str, event: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        """Parse a scheduled match without inventing a result or map order."""
        result = self.fetch(href)
        soup = self.soup(result)
        external_id_match = re.match(r"/(\d+)/", href)
        issue = {
            "external_id": external_id_match.group(1) if external_id_match else href,
            "source_url": result.url,
            "raw_path": result.raw_path,
            "content_hash": result.content_hash,
            "fetched_at": result.fetched_at,
        }
        if not external_id_match:
            return None, {**issue, "reason": "match_id_missing"}
        date_node = soup.select_one("[data-utc-ts]")
        if not date_node or not date_node.get("data-utc-ts"):
            return None, {**issue, "reason": "scheduled_at_missing"}
        scheduled_at = datetime.strptime(
            date_node["data-utc-ts"], "%Y-%m-%d %H:%M:%S"
        ).replace(tzinfo=timezone.utc).isoformat()
        score_node = soup.select_one(".match-header-vs-score")
        score_text = _clean(score_node.get_text(" ", strip=True) if score_node else None)
        format_match = re.search(r"Bo([35])", score_text, re.I)
        if not format_match:
            return None, {**issue, "reason": "unsupported_series_format", "detail": score_text}
        team_links = soup.select("a.match-header-link[href^='/team/']")
        teams: list[dict[str, str]] = []
        for link in team_links:
            team_match = re.match(r"/team/(\d+)/", link.get("href", ""))
            if team_match:
                teams.append({
                    "external_team_id": team_match.group(1),
                    "team_id": f"vlr_team_{team_match.group(1)}",
                    "name": _clean(link.get_text(" ", strip=True)),
                })
        event_node = soup.select_one(".match-header-event")
        stage_node = event_node.select_one(".match-header-event-series") if event_node else None
        blockers: list[str] = []
        if len(teams) != 2:
            blockers.append("teams_unresolved_or_tbd")
            while len(teams) < 2:
                teams.append({"external_team_id": "", "team_id": "", "name": "TBD"})
        record = {
            "fixture_id": f"vlr_fixture_{external_id_match.group(1)}",
            "external_match_id": external_id_match.group(1),
            "external_event_id": event["external_event_id"],
            "event": event["name"],
            "region": event["region"],
            "classification": event["classification"],
            "competition_policy": event.get("prediction_policy","quality_gate_required"),
            "evaluation_cohort": event.get("evaluation_cohort",event["classification"]),
            "stage": _clean(stage_node.get_text(" ", strip=True) if stage_node else None),
            "scheduled_at": scheduled_at,
            "series_format": f"bo{format_match.group(1)}".lower(),
            "patch": competition_cohort(event["name"], scheduled_at),
            "patch_provenance": "event_cohort_inferred_exact_patch_unavailable",
            "teams": teams[:2],
            "source_url": result.url,
            "raw_path": result.raw_path,
            "content_hash": result.content_hash,
            "fetched_at": result.fetched_at,
            "status": "scheduled" if datetime.fromisoformat(scheduled_at) > datetime.now(timezone.utc) else "result_pending",
            "blockers": blockers,
        }
        return record, issue

    def parse_match(self, href: str, event: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        result = self.fetch(href)
        soup = self.soup(result)
        external_id_match = re.match(r"/(\d+)/", href)
        issue = {
            "external_id": external_id_match.group(1) if external_id_match else href,
            "source_url": result.url,
            "raw_path": result.raw_path,
            "content_hash": result.content_hash,
            "fetched_at": result.fetched_at,
        }
        if not external_id_match:
            return None, {**issue, "reason": "match_id_missing"}
        team_links = soup.select("a.match-header-link[href^='/team/']")
        if len(team_links) != 2:
            return None, {**issue, "reason": "team_links_missing"}
        teams = []
        for link in team_links:
            team_match = re.match(r"/team/(\d+)/", link.get("href", ""))
            if not team_match:
                return None, {**issue, "reason": "team_id_missing"}
            teams.append({
                "external_team_id": team_match.group(1),
                "team_id": f"vlr_team_{team_match.group(1)}",
                "name": _clean(link.get_text(" ", strip=True)),
            })
        date_node = soup.select_one("[data-utc-ts]")
        if not date_node or not date_node.get("data-utc-ts"):
            return None, {**issue, "reason": "played_at_missing"}
        played_at = datetime.strptime(date_node["data-utc-ts"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
        vs_text = _clean(soup.select_one(".match-header-vs-score").get_text(" ", strip=True) if soup.select_one(".match-header-vs-score") else None)
        notes = [_clean(node.get_text(" ", strip=True)) for node in soup.select(".match-header-vs-note")]
        source_status = next((note for note in notes if note.lower() in {"final", "completed"}), "")
        score_node = soup.select_one(".match-header-vs-score .sp-hide")
        source_numbers = [int(value) for value in re.findall(r"\d+", _clean(score_node.get_text(" ", strip=True) if score_node else None))]
        source_score = (source_numbers[0], source_numbers[1]) if len(source_numbers) >= 2 else None
        format_match = re.search(r"Bo([35])", vs_text, re.I)
        if not format_match:
            return None, {**issue, "reason": "unsupported_series_format", "detail": vs_text}
        series_format = f"bo{format_match.group(1)}".lower()
        maps: list[dict[str, Any]] = []
        player_stats: list[dict[str, Any]] = []
        for game in soup.select(".vm-stats-game[data-game-id]"):
            if game.get("data-game-id") == "all":
                continue
            header = game.select_one(".vm-stats-game-header")
            map_node = header.select_one(".map") if header else None
            team_nodes = header.select(".team") if header else []
            if not map_node or len(team_nodes) < 2:
                continue
            map_name = next((_clean(text) for text in map_node.stripped_strings if _clean(text)), "")
            try:
                map_id = normalize_map(map_name)
            except ValueError:
                return None, {**issue, "reason": "unknown_map", "detail": map_name}
            score_a = _integer(team_nodes[0].select_one(".score").get_text(strip=True) if team_nodes[0].select_one(".score") else None)
            score_b = _integer(team_nodes[1].select_one(".score").get_text(strip=True) if team_nodes[1].select_one(".score") else None)
            if score_a is None or score_b is None or score_a == score_b:
                continue
            if not _complete_competitive_map_score(score_a, score_b):
                return None, {**issue, "reason": "incomplete_map_score", "detail": f"{map_name}:{score_a}-{score_b}"}
            map_order = len(maps) + 1
            maps.append({
                "map_order": map_order,
                "map": map_id,
                "team_a_rounds": score_a,
                "team_b_rounds": score_b,
            })
            tables = game.select(".ovw-table")
            for table_index, table in enumerate(tables[:2]):
                team = teams[table_index]
                for row in table.select(".ovw-row")[1:]:
                    player_link = row.select_one("a[href^='/player/']")
                    if not player_link:
                        continue
                    player_match = re.match(r"/player/(\d+)/", player_link.get("href", ""))
                    if not player_match:
                        continue
                    def cell(selector: str) -> str | None:
                        node = row.select_one(selector)
                        both = node.select_one(".side.mod-both") if node else None
                        return both.get_text(strip=True) if both else None
                    agents = [img.get("alt", "") for img in row.select(".ovw-agents img")]
                    player_stats.append({
                        "match_id": f"vlr_match_{external_id_match.group(1)}",
                        "map_order": map_order,
                        "player_id": f"vlr_player_{player_match.group(1)}",
                        "external_player_id": player_match.group(1),
                        "player_name": _clean(player_link.get_text(" ", strip=True)),
                        "team_id": team["team_id"],
                        "agent": ",".join(agent for agent in agents if agent) or None,
                        "rating": _number(cell("[data-col='rating2']")),
                        "acs": _number(cell("[data-col='acs']")),
                        "kills": _integer(cell("[data-col='kills']")),
                        "deaths": _integer(cell("[data-col='deaths']")),
                        "assists": _integer(cell("[data-col='assists']")),
                        "kast": _number(cell("[data-col='kast']"), percent=True),
                        "adr": _number(cell("[data-col='adr']")),
                        "hs_pct": _number(cell("[data-col='hsp']"), percent=True),
                        "first_kills": _integer(cell("[data-col='fb']")),
                        "first_deaths": _integer(cell("[data-col='fd']")),
                    })
        finality_status, finality_reason = validate_series_finality(series_format, source_status, source_score, maps)
        if finality_status != "FINAL_CANDIDATE":
            return None, {**issue, "reason": finality_reason, "finality_status": finality_status, "detail": f"source={source_score}"}
        wins_needed = 3 if series_format == "bo5" else 2
        a_maps = sum(item["team_a_rounds"] > item["team_b_rounds"] for item in maps)
        b_maps = len(maps) - a_maps
        if not maps or max(a_maps, b_maps) != wins_needed:
            return None, {**issue, "reason": "incomplete_or_forfeit_series", "detail": f"{a_maps}-{b_maps}"}
        event_node = soup.select_one(".match-header-event")
        stage_node = event_node.select_one(".match-header-event-series") if event_node else None
        event_name = event["name"]
        record = {
            "external_match_id": external_id_match.group(1),
            "match_id": f"vlr_match_{external_id_match.group(1)}",
            "event_id": event["external_event_id"],
            "event": event_name,
            "region": event["region"],
            "stage": _clean(stage_node.get_text(" ", strip=True) if stage_node else None),
            "played_at": played_at,
            "patch": competition_cohort(event_name, played_at),
            "patch_provenance": "event_cohort_inferred_exact_patch_unavailable",
            "series_format": series_format,
            "team_a_id": teams[0]["team_id"],
            "team_b_id": teams[1]["team_id"],
            "winner_id": teams[0]["team_id"] if a_maps > b_maps else teams[1]["team_id"],
            "team_a_maps": a_maps,
            "team_b_maps": b_maps,
            "teams": teams,
            "maps": maps,
            "player_stats": player_stats,
            "is_international": event["classification"] == "international",
            "importance": 1.25 if event["classification"] == "international" else 1.0,
            "source_url": result.url,
            "data_quality": "verified_result_community_source",
            "fetched_at": result.fetched_at,
            "raw_path": result.raw_path,
            "content_hash": result.content_hash,
            "result_finality_status": "FINAL_CANDIDATE",
        }
        normalized = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        record["normalized_hash"] = _hash_bytes(normalized)
        return record, issue


def collect_vct_history(
    snapshot_root: str | Path,
    *,
    start_year: int = 2024,
    end_year: int | None = None,
    progress=None,
) -> dict[str, Any]:
    end_year = end_year or datetime.now(timezone.utc).year
    client = VlrClient(snapshot_root)
    events: list[dict[str, Any]] = []
    matches: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    try:
        discovered = client.discover_events(start_year, end_year)
        selected = [event for event in discovered if event["included"]]
        if progress:
            progress({"phase": "events", "discovered": len(discovered), "selected": len(selected)})
        for event_index, event in enumerate(selected, 1):
            links, match_list_result = client.event_match_links(event)
            event = {
                **event,
                "match_list_raw_path": match_list_result.raw_path,
                "match_list_hash": match_list_result.content_hash,
            }
            events.append(event)
            if progress:
                progress({
                    "phase": "event_matches",
                    "event_index": event_index,
                    "event_total": len(selected),
                    "event": event["name"],
                    "matches": len(links),
                })
            for href in links:
                record, issue = client.parse_match(href, event)
                if record:
                    matches.append(record)
                else:
                    issues.append({**issue, "event": event["name"]})
        event_maps: dict[str, list[str]] = {}
        for record in matches:
            pool = event_maps.setdefault(record["event_id"], [])
            for item in record["maps"]:
                if item["map"] not in pool:
                    pool.append(item["map"])
        for record in matches:
            record["map_pool"] = event_maps.get(record["event_id"], [])
            record["map_pool_provenance"] = "event_observed_union"
        return {
            "source": {
                "source_id": "vlr",
                "name": "VLR.gg",
                "base_url": BASE_URL,
                "source_type": "community_public_web",
                "authority_level": "secondary",
                "terms_note": "Community match index; not affiliated with Riot. Raw pages and URLs retained for audit.",
            },
            "scope": {"start_year": start_year, "end_year": end_year},
            "collected_at": _now(),
            "events": events,
            "matches": sorted(matches, key=lambda item: (item["played_at"], item["match_id"])),
            "issues": issues,
        }
    finally:
        client.close()
