"""Bounded history ingestion. No fitting, prediction rewrite or live result settlement.

Old facts are staged separately; the frozen Rating formula is replayed in a
prediction-free database before committing a consistent current data state.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import Database, SCHEMA
from .ratings import process_match
from .realdata import import_collection, refresh_derived_team_factors, _lineup, _roster_version


def protected_digest(connection: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for table in ('predictions', 'challenger_predictions', 'model_freezes', 'prospective_snapshots', 'feature_snapshots', 'prediction_pairs'):
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
            continue
        for row in connection.execute(f'SELECT * FROM {table} ORDER BY 1'):
            digest.update(json.dumps(tuple(row), sort_keys=True, default=str).encode())
    row = connection.execute("SELECT value FROM metadata WHERE key='config'").fetchone()
    digest.update((row[0] if row else '').encode())
    return digest.hexdigest()


def rebuild_rating_state(connection: sqlite3.Connection, config: dict[str, Any], cutoff: str) -> None:
    """Reuse unmodified Champion update code, with no predictions to settle."""
    replay = sqlite3.connect(':memory:')
    replay.row_factory = sqlite3.Row
    try:
        replay.executescript(SCHEMA)
        for row in connection.execute('SELECT team_id,name,region FROM teams'):
            replay.execute('INSERT INTO teams(team_id,name,region,rating,updated_at) VALUES(?,?,?,?,?)',
                           (*tuple(row), float(config['base_rating']), cutoff))
        matches = connection.execute('SELECT * FROM matches WHERE julianday(played_at)<julianday(?) ORDER BY julianday(played_at),match_id', (cutoff,)).fetchall()
        columns = [r[1] for r in connection.execute('PRAGMA table_info(matches)')]
        for row in matches:
            match = dict(row)
            match['processed'] = 0
            replay.execute(f"INSERT INTO matches({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", [match[k] for k in columns])
            replay.executemany('INSERT INTO map_results VALUES(?,?,?,?,?)',
                               [tuple(r) for r in connection.execute('SELECT * FROM map_results WHERE match_id=?', (match['match_id'],))])
            process_match(replay, match, config)
        # Only derived data is rebuilt. Source facts and frozen ledgers survive.
        connection.execute('DELETE FROM rating_history')
        connection.execute('DELETE FROM team_map_ratings')
        for table in ('rating_history', 'team_map_ratings'):
            rows = replay.execute(f'SELECT * FROM {table}').fetchall()
            if rows:
                connection.executemany(f"INSERT INTO {table} VALUES({','.join('?' for _ in rows[0])})", [tuple(r) for r in rows])
        for row in replay.execute('SELECT rating,matches_played,last_patch,team_id FROM teams'):
            connection.execute('UPDATE teams SET rating=?,matches_played=?,last_patch=? WHERE team_id=?', tuple(row))
        connection.executemany('UPDATE matches SET processed=1 WHERE match_id=?', [(r['match_id'],) for r in matches])
    finally:
        replay.close()


def _repair_historical_memberships(stage: Database, original: sqlite3.Connection, records: list[dict[str, Any]], cutoff: str) -> None:
    """Restore old identity state first; insert past intervals without closing a later one backwards."""
    with stage.connect() as conn:
        conn.execute('DELETE FROM player_team_history')
        for row in original.execute('SELECT * FROM player_team_history'):
            conn.execute('INSERT INTO player_team_history VALUES(?,?,?,?,?,?,?)', tuple(row))
        for row in original.execute('SELECT name,team_id,active,player_id FROM players'):
            conn.execute('UPDATE players SET name=?,team_id=?,active=? WHERE player_id=?', tuple(row))
        for row in original.execute('SELECT name,region,roster_version,roster_continuity,team_id FROM teams'):
            conn.execute('UPDATE teams SET name=?,region=?,roster_version=?,roster_continuity=? WHERE team_id=?', tuple(row))
        max_event = original.execute('SELECT COALESCE(MAX(event_id),0) FROM roster_events').fetchone()[0]
        conn.execute('DELETE FROM roster_events WHERE event_id>?', (max_event,))
        for record in sorted(records, key=lambda r: (r['played_at'], r['match_id'])):
            at = record['played_at']
            for team_id in (record['team_a_id'], record['team_b_id']):
                lineup = _lineup(record, team_id)
                if len(lineup) != 5:
                    continue
                previous = conn.execute('''SELECT s.player_id FROM match_player_stats s JOIN matches m USING(match_id)
                    WHERE s.team_id=? AND m.match_id=(SELECT m2.match_id FROM matches m2 JOIN match_player_stats s2 USING(match_id)
                    WHERE s2.team_id=? AND julianday(m2.played_at)<julianday(?) ORDER BY julianday(m2.played_at) DESC LIMIT 1)
                    GROUP BY s.player_id''', (team_id, team_id, at)).fetchall()
                previous_ids = {r[0] for r in previous}
                ids = {p['player_id'] for p in lineup}
                continuity = len(ids & previous_ids) / 5 if previous_ids else 1.0
                version = _roster_version(lineup)
                conn.execute('''INSERT OR IGNORE INTO roster_events(team_id,effective_at,roster_version,changed_players,continuity,note)
                    VALUES(?,?,?,?,?,?)''', (team_id,at,version,len(ids-previous_ids) if previous_ids else 0,continuity,
                                            'Observed historical lineup: '+record['source_url']))
                for player in lineup:
                    pid = player['player_id']
                    prior = conn.execute('''SELECT * FROM player_team_history WHERE player_id=? AND julianday(effective_from)<=julianday(?)
                        AND (effective_to IS NULL OR julianday(effective_to)>julianday(?)) ORDER BY julianday(effective_from) DESC LIMIT 1''', (pid,at,at)).fetchone()
                    if prior and prior['team_id'] == team_id:
                        continue
                    after = conn.execute('SELECT MIN(effective_from) FROM player_team_history WHERE player_id=? AND julianday(effective_from)>julianday(?)', (pid,at)).fetchone()[0]
                    if prior:
                        conn.execute('UPDATE player_team_history SET effective_to=? WHERE membership_id=?', (at,prior['membership_id']))
                    conn.execute('''INSERT OR IGNORE INTO player_team_history(player_id,team_id,effective_from,effective_to,roster_version,source_url)
                        VALUES(?,?,?,?,?,?)''', (pid,team_id,at,after,version,record['source_url']))
                    if after is None:
                        conn.execute('UPDATE players SET team_id=? WHERE player_id=?', (team_id,pid))
        for row in conn.execute('SELECT team_id FROM teams').fetchall():
            latest = conn.execute('SELECT roster_version,continuity FROM roster_events WHERE team_id=? AND julianday(effective_at)<julianday(?) ORDER BY julianday(effective_at) DESC,event_id DESC LIMIT 1', (row[0],cutoff)).fetchone()
            if latest:
                conn.execute('UPDATE teams SET roster_version=?,roster_continuity=? WHERE team_id=?', (*tuple(latest),row[0]))


def apply_history_batch(db: Database, collection: dict[str, Any], *, cutoff: str, raw_root: str | Path) -> dict[str, Any]:
    records = collection['matches']
    limit = datetime.fromisoformat(cutoff.replace('Z','+00:00'))
    if any(datetime.fromisoformat(r['played_at'].replace('Z','+00:00')) >= limit for r in records):
        raise ValueError('history_not_strictly_before_cutoff')
    if not records:
        return {'records_inserted': 0}
    # One retained pre-import backup; never replace the production file by a shell move.
    if shutil.disk_usage(db.path.parent).free < 2 * db.path.stat().st_size + 20_000_000:
        raise RuntimeError('history_import_deferred_low_storage')
    original = sqlite3.connect(db.path)
    original.row_factory = sqlite3.Row
    initial_stamp = db.path.stat().st_mtime_ns
    frozen = protected_digest(original)
    try:
        with tempfile.TemporaryDirectory(prefix='vct-history-stage-') as folder:
            staged = Database(Path(folder)/'stage.sqlite3')
            target = sqlite3.connect(staged.path)
            original.backup(target)
            target.close()
            report = import_collection(staged, collection, snapshot_root=raw_root, process=False)
            if report['conflicts']:
                raise ValueError('history_conflict_quarantined_before_commit')
            if not report['records_inserted']:
                return report
            _repair_historical_memberships(staged, original, records, cutoff)
            with staged.connect() as conn:
                rebuild_rating_state(conn, db.config(), cutoff)
            refresh_derived_team_factors(staged)
            with staged.connect() as conn:
                if protected_digest(conn) != frozen:
                    raise ValueError('frozen_ledger_changed_in_staging')
                if conn.execute('PRAGMA foreign_key_check').fetchone():
                    raise ValueError('history_foreign_key_check_failed')
            if db.path.stat().st_mtime_ns != initial_stamp or protected_digest(original) != frozen:
                raise RuntimeError('history_import_deferred_concurrent_write')
            backup = sqlite3.connect(db.path.with_name('readiness-last-good.sqlite3'))
            original.backup(backup)
            backup.close()
            original.close()
            original = None
            source = sqlite3.connect(staged.path)
            destination = sqlite3.connect(db.path, timeout=20)
            try:
                source.backup(destination)
            finally:
                source.close()
                destination.close()
            return {**report, 'rating_order': 'chronological_frozen_formula', 'protected_ledger_unchanged': True}
    finally:
        if original is not None:
            original.close()
