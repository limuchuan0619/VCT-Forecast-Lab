"""SQLite 数据层：比赛事实、动态评分、预测快照与赛后评估。"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .constants import DEFAULT_CONFIG, MAPS


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
    team_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    rating REAL NOT NULL DEFAULT 1500,
    matches_played INTEGER NOT NULL DEFAULT 0,
    roster_version TEXT NOT NULL DEFAULT 'unknown',
    roster_continuity REAL NOT NULL DEFAULT 1.0 CHECK(roster_continuity BETWEEN 0 AND 1),
    player_form REAL NOT NULL DEFAULT 0.0 CHECK(player_form BETWEEN -1 AND 1),
    patch_fit REAL NOT NULL DEFAULT 0.0 CHECK(patch_fit BETWEEN -1 AND 1),
    international_experience REAL NOT NULL DEFAULT 0.5 CHECK(international_experience BETWEEN 0 AND 1),
    bo3_adaptability REAL NOT NULL DEFAULT 0.5 CHECK(bo3_adaptability BETWEEN 0 AND 1),
    bo5_adaptability REAL NOT NULL DEFAULT 0.5 CHECK(bo5_adaptability BETWEEN 0 AND 1),
    last_patch TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roster_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    effective_at TEXT NOT NULL,
    roster_version TEXT NOT NULL,
    changed_players INTEGER NOT NULL,
    continuity REAL NOT NULL CHECK(continuity BETWEEN 0 AND 1),
    note TEXT
);

CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS player_form_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL REFERENCES players(player_id),
    observed_at TEXT NOT NULL,
    form_score REAL NOT NULL CHECK(form_score BETWEEN -1 AND 1),
    reliability REAL NOT NULL DEFAULT 1.0 CHECK(reliability BETWEEN 0 AND 1),
    note TEXT,
    UNIQUE(player_id, observed_at)
);

CREATE TABLE IF NOT EXISTS team_map_ratings (
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    map_id TEXT NOT NULL,
    rating REAL NOT NULL DEFAULT 1500,
    matches_played INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(team_id, map_id)
);

CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    region TEXT NOT NULL,
    stage TEXT,
    played_at TEXT NOT NULL,
    patch TEXT,
    series_format TEXT NOT NULL,
    team_a_id TEXT NOT NULL REFERENCES teams(team_id),
    team_b_id TEXT NOT NULL REFERENCES teams(team_id),
    winner_id TEXT NOT NULL REFERENCES teams(team_id),
    team_a_maps INTEGER NOT NULL,
    team_b_maps INTEGER NOT NULL,
    is_international INTEGER NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 1.0,
    team_a_roster_version TEXT,
    team_b_roster_version TEXT,
    source_url TEXT,
    data_quality TEXT NOT NULL DEFAULT 'verified_result',
    processed INTEGER NOT NULL DEFAULT 0,
    inserted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_results (
    match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    map_order INTEGER NOT NULL,
    map_id TEXT NOT NULL,
    team_a_rounds INTEGER NOT NULL,
    team_b_rounds INTEGER NOT NULL,
    PRIMARY KEY(match_id, map_order)
);

CREATE TABLE IF NOT EXISTS rating_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL REFERENCES matches(match_id),
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    rating_before REAL NOT NULL,
    rating_after REAL NOT NULL,
    expected_score REAL NOT NULL,
    actual_quality_score REAL NOT NULL,
    delta REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
    prediction_id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'system',
    model_version TEXT NOT NULL,
    locked_at TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    event TEXT NOT NULL,
    region TEXT NOT NULL,
    patch TEXT,
    series_format TEXT NOT NULL,
    team_a_id TEXT NOT NULL REFERENCES teams(team_id),
    team_b_id TEXT NOT NULL REFERENCES teams(team_id),
    predicted_winner_id TEXT NOT NULL REFERENCES teams(team_id),
    team_a_win_probability REAL NOT NULL CHECK(team_a_win_probability BETWEEN 0 AND 1),
    team_b_win_probability REAL NOT NULL CHECK(team_b_win_probability BETWEEN 0 AND 1),
    predicted_score TEXT NOT NULL,
    score_distribution_json TEXT NOT NULL,
    map_probabilities_json TEXT NOT NULL,
    factor_snapshot_json TEXT NOT NULL,
    bp_plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'locked',
    actual_winner_id TEXT REFERENCES teams(team_id),
    actual_score TEXT,
    resolved_match_id TEXT REFERENCES matches(match_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at);
CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status, scheduled_at);

CREATE TABLE IF NOT EXISTS data_sources (
    source_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    authority_level TEXT NOT NULL,
    terms_note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
    batch_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES data_sources(source_id),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    snapshot_root TEXT,
    records_seen INTEGER NOT NULL DEFAULT 0,
    records_inserted INTEGER NOT NULL DEFAULT 0,
    records_skipped INTEGER NOT NULL DEFAULT 0,
    conflicts INTEGER NOT NULL DEFAULT 0,
    checksum TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS source_records (
    source_id TEXT NOT NULL REFERENCES data_sources(source_id),
    entity_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    canonical_id TEXT,
    source_url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    batch_id TEXT REFERENCES import_batches(batch_id),
    raw_path TEXT,
    data_quality TEXT NOT NULL,
    PRIMARY KEY(source_id, entity_type, external_id)
);

CREATE TABLE IF NOT EXISTS import_conflicts (
    conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES import_batches(batch_id),
    entity_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    existing_json TEXT,
    incoming_json TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS team_aliases (
    source_id TEXT NOT NULL REFERENCES data_sources(source_id),
    external_team_id TEXT NOT NULL,
    canonical_team_id TEXT NOT NULL REFERENCES teams(team_id),
    alias TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(source_id, external_team_id)
);

CREATE TABLE IF NOT EXISTS event_catalog (
    source_id TEXT NOT NULL REFERENCES data_sources(source_id),
    external_event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    classification TEXT NOT NULL,
    status TEXT,
    source_url TEXT NOT NULL,
    included INTEGER NOT NULL DEFAULT 1,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY(source_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS match_player_stats (
    match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    map_order INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    agent TEXT,
    rating REAL,
    acs REAL,
    kills INTEGER,
    deaths INTEGER,
    assists INTEGER,
    kast REAL,
    adr REAL,
    hs_pct REAL,
    first_kills INTEGER,
    first_deaths INTEGER,
    PRIMARY KEY(match_id, map_order, player_id)
);

CREATE TABLE IF NOT EXISTS player_team_history (
    membership_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL REFERENCES players(player_id),
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    roster_version TEXT NOT NULL,
    source_url TEXT,
    UNIQUE(player_id, team_id, effective_from)
);

CREATE TABLE IF NOT EXISTS prediction_provenance (
    prediction_id TEXT PRIMARY KEY REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL,
    lock_order_verified INTEGER NOT NULL DEFAULT 0,
    exact_lock_time_verified INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL,
    transcript_excerpt TEXT,
    evaluation_eligible INTEGER NOT NULL DEFAULT 0,
    note TEXT
);

CREATE TABLE IF NOT EXISTS model_freezes (
    model_version TEXT PRIMARY KEY,
    frozen_at TEXT NOT NULL,
    training_cutoff TEXT NOT NULL,
    validation_start TEXT,
    validation_end TEXT,
    config_json TEXT NOT NULL,
    data_checksum TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES data_sources(source_id),
    external_match_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    event TEXT NOT NULL,
    region TEXT NOT NULL,
    classification TEXT NOT NULL,
    stage TEXT,
    scheduled_at TEXT NOT NULL,
    series_format TEXT NOT NULL,
    patch TEXT,
    patch_provenance TEXT NOT NULL,
    team_a_id TEXT REFERENCES teams(team_id),
    team_b_id TEXT REFERENCES teams(team_id),
    team_a_name TEXT NOT NULL,
    team_b_name TEXT NOT NULL,
    map_pool_json TEXT NOT NULL DEFAULT '[]',
    map_pool_provenance TEXT NOT NULL DEFAULT 'unavailable',
    source_url TEXT NOT NULL,
    raw_path TEXT,
    content_hash TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    quality_status TEXT NOT NULL DEFAULT 'blocked',
    blocker_json TEXT NOT NULL DEFAULT '[]',
    prediction_id TEXT REFERENCES predictions(prediction_id),
    completed_match_id TEXT REFERENCES matches(match_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_id, external_match_id)
);

CREATE TABLE IF NOT EXISTS prospective_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
    observed_at TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    quality_status TEXT NOT NULL,
    blocker_json TEXT NOT NULL DEFAULT '[]',
    snapshot_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prediction_id TEXT REFERENCES predictions(prediction_id),
    outcome_status TEXT NOT NULL DEFAULT 'pending',
    resolved_match_id TEXT REFERENCES matches(match_id),
    created_at TEXT NOT NULL,
    UNIQUE(fixture_id, checkpoint, content_hash)
);

CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT PRIMARY KEY,
    run_type TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    counters_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    model_version TEXT NOT NULL,
    database_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_reviews (
    prediction_id TEXT PRIMARY KEY REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    generated_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    winner_correct INTEGER NOT NULL,
    score_correct INTEGER NOT NULL,
    brier_score REAL NOT NULL,
    log_loss REAL NOT NULL,
    predicted_maps_json TEXT NOT NULL,
    actual_maps_json TEXT NOT NULL,
    map_overlap INTEGER NOT NULL,
    flags_json TEXT NOT NULL,
    diagnostics_json TEXT NOT NULL,
    summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenger_feature_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL UNIQUE REFERENCES fixtures(fixture_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    feature_cutoff_at TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    gold_snapshot_id TEXT REFERENCES prospective_snapshots(snapshot_id),
    quality_status TEXT NOT NULL,
    feature_json TEXT NOT NULL,
    feature_status_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    CHECK(julianday(feature_cutoff_at) < julianday(scheduled_at))
);

CREATE TABLE IF NOT EXISTS challenger_predictions (
    shadow_prediction_id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL UNIQUE REFERENCES fixtures(fixture_id) ON DELETE CASCADE,
    champion_prediction_id TEXT NOT NULL UNIQUE REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    feature_snapshot_id TEXT NOT NULL UNIQUE REFERENCES challenger_feature_snapshots(snapshot_id),
    created_at TEXT NOT NULL,
    frozen_at TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    champion_model_version TEXT NOT NULL,
    champion_probability REAL NOT NULL CHECK(champion_probability BETWEEN 0 AND 1),
    challenger_model_id TEXT NOT NULL,
    dataset_version TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    challenger_probability REAL NOT NULL CHECK(challenger_probability BETWEEN 0 AND 1),
    probability_delta REAL NOT NULL,
    data_quality_state TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK(record_kind IN ('real_prospective','isolated_test')),
    eligible INTEGER NOT NULL DEFAULT 0 CHECK(eligible IN (0,1)),
    status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','resolved')),
    actual_winner_id TEXT REFERENCES teams(team_id),
    resolved_match_id TEXT REFERENCES matches(match_id),
    resolved_at TEXT,
    champion_brier REAL,
    challenger_brier REAL,
    champion_log_loss REAL,
    challenger_log_loss REAL,
    champion_correct INTEGER CHECK(champion_correct IN (0,1)),
    challenger_correct INTEGER CHECK(challenger_correct IN (0,1)),
    CHECK(julianday(frozen_at) < julianday(scheduled_at))
);

CREATE TRIGGER IF NOT EXISTS challenger_prediction_freeze_guard
BEFORE UPDATE ON challenger_predictions
WHEN NEW.fixture_id != OLD.fixture_id
  OR NEW.champion_prediction_id != OLD.champion_prediction_id
  OR NEW.feature_snapshot_id != OLD.feature_snapshot_id
  OR NEW.frozen_at != OLD.frozen_at
  OR NEW.scheduled_at != OLD.scheduled_at
  OR NEW.champion_model_version != OLD.champion_model_version
  OR NEW.champion_probability != OLD.champion_probability
  OR NEW.challenger_model_id != OLD.challenger_model_id
  OR NEW.dataset_version != OLD.dataset_version
  OR NEW.artifact_hash != OLD.artifact_hash
  OR NEW.challenger_probability != OLD.challenger_probability
  OR NEW.probability_delta != OLD.probability_delta
  OR NEW.data_quality_state != OLD.data_quality_state
  OR NEW.record_kind != OLD.record_kind
  OR NEW.eligible != OLD.eligible
BEGIN
  SELECT RAISE(ABORT, 'challenger_prediction_frozen');
END;

CREATE INDEX IF NOT EXISTS idx_fixtures_schedule ON fixtures(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_prospective_fixture_time ON prospective_snapshots(fixture_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_prospective_outcome_schedule ON prospective_snapshots(outcome_status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_challenger_status ON challenger_predictions(status, eligible, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_challenger_model ON challenger_predictions(challenger_model_id, status);

CREATE INDEX IF NOT EXISTS idx_source_records_batch ON source_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_player_team_asof ON player_team_history(team_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_match_player_stats_player ON match_player_stats(player_id, match_id);
"""


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self, config: dict[str, Any] | None = None) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            if config is None:
                conn.execute(
                    "INSERT OR IGNORE INTO metadata(key, value) VALUES('config', ?)",
                    (json.dumps(DEFAULT_CONFIG, ensure_ascii=False),),
                )
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO metadata(key, value) VALUES('config', ?)",
                    (json.dumps(config, ensure_ascii=False),),
                )
            for map_id in MAPS:
                conn.execute(
                    "INSERT OR IGNORE INTO metadata(key, value) VALUES(?, ?)",
                    (f"map:{map_id}", MAPS[map_id]),
                )
            prediction_columns = {row["name"] for row in conn.execute("PRAGMA table_info(predictions)").fetchall()}
            if "fixture_id" not in prediction_columns:
                conn.execute("ALTER TABLE predictions ADD COLUMN fixture_id TEXT")
            if "lock_policy" not in prediction_columns:
                conn.execute("ALTER TABLE predictions ADD COLUMN lock_policy TEXT NOT NULL DEFAULT 'manual'")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_fixture ON predictions(fixture_id) WHERE fixture_id IS NOT NULL"
            )
            conn.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', '6')"
            )

    def config(self) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM metadata WHERE key='config'").fetchone()
        return json.loads(row["value"]) if row else dict(DEFAULT_CONFIG)

    def fetch_team(self, team_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM teams WHERE team_id=?", (team_id,)).fetchone()
        if row is None:
            raise ValueError(f"队伍不存在：{team_id}")
        return dict(row)

    def team_context_as_of(self, team_id: str, as_of: str) -> dict[str, Any]:
        """Return a team snapshot using only roster evidence available by ``as_of``."""
        team = self.fetch_team(team_id)
        with self.connect() as conn:
            roster = conn.execute(
                """SELECT roster_version, continuity, effective_at
                   FROM roster_events
                   WHERE team_id=? AND julianday(effective_at) <= julianday(?)
                   ORDER BY julianday(effective_at) DESC, event_id DESC LIMIT 1""",
                (team_id, as_of),
            ).fetchone()
            last_match = conn.execute(
                """SELECT patch FROM matches
                   WHERE processed=1 AND (team_a_id=? OR team_b_id=?)
                     AND julianday(played_at) < julianday(?) AND patch IS NOT NULL
                   ORDER BY julianday(played_at) DESC LIMIT 1""",
                (team_id, team_id, as_of),
            ).fetchone()
        if roster:
            team["roster_version"] = roster["roster_version"]
            team["roster_continuity"] = roster["continuity"]
        if last_match:
            team["last_patch"] = last_match["patch"]
        return team

    def fetch_map_rating(self, team_id: str, map_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM team_map_ratings WHERE team_id=? AND map_id=?",
                (team_id, map_id),
            ).fetchone()
        return dict(row) if row else None

    def recent_matches(self, team_id: str, before: str, window_start: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT m.*,
                       COALESCE(rha.rating_before, ta.rating) AS historical_team_a_rating,
                       COALESCE(rhb.rating_before, tb.rating) AS historical_team_b_rating,
                       COALESCE(SUM(CASE WHEN mr.team_a_rounds > mr.team_b_rounds
                                         THEN mr.team_a_rounds - mr.team_b_rounds
                                         ELSE -(mr.team_b_rounds - mr.team_a_rounds) END), 0) AS signed_round_margin
                FROM matches m
                JOIN teams ta ON ta.team_id=m.team_a_id
                JOIN teams tb ON tb.team_id=m.team_b_id
                LEFT JOIN rating_history rha ON rha.match_id=m.match_id AND rha.team_id=m.team_a_id
                LEFT JOIN rating_history rhb ON rhb.match_id=m.match_id AND rhb.team_id=m.team_b_id
                LEFT JOIN map_results mr ON mr.match_id=m.match_id
                WHERE m.processed=1 AND (m.team_a_id=? OR m.team_b_id=?)
                  AND julianday(m.played_at) < julianday(?)
                  AND julianday(m.played_at) >= julianday(?)
                GROUP BY m.match_id
                ORDER BY m.played_at DESC
                """,
                (team_id, team_id, before, window_start),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_pending_matches(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM matches WHERE processed=0 ORDER BY played_at, match_id"
            ).fetchall()
        return [dict(row) for row in rows]

    def player_form_as_of(self, team_id: str, as_of: str) -> tuple[float | None, dict[str, Any]]:
        """只读取预测时间点之前每名现役选手的最新状态，防止赛后信息泄漏。"""
        with self.connect() as conn:
            rows = conn.execute(
                """SELECT p.player_id, p.name, s.observed_at, s.form_score, s.reliability
                   FROM players p
                   JOIN player_team_history h ON h.player_id=p.player_id
                   JOIN player_form_snapshots s ON s.player_id=p.player_id
                   WHERE h.team_id=?
                     AND julianday(h.effective_from) <= julianday(?)
                     AND (h.effective_to IS NULL OR julianday(h.effective_to) > julianday(?))
                     AND s.observed_at=(
                       SELECT MAX(s2.observed_at) FROM player_form_snapshots s2
                       WHERE s2.player_id=p.player_id AND s2.observed_at <= ?
                   )
                   ORDER BY p.player_id""",
                (team_id, as_of, as_of, as_of),
            ).fetchall()
        if not rows:
            return None, {"source": "team_aggregate_fallback", "players": []}
        total_reliability = sum(float(row["reliability"]) for row in rows)
        if total_reliability <= 0:
            return None, {"source": "team_aggregate_fallback", "players": []}
        score = sum(float(row["form_score"]) * float(row["reliability"]) for row in rows) / total_reliability
        return score, {
            "source": "player_snapshots",
            "players": [dict(row) for row in rows],
            "effective_reliability": round(total_reliability, 4),
        }
