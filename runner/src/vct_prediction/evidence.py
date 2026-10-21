"""Private append-only source observations, never a formal result/model input."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import gzip
import json
from pathlib import Path
import re
import shutil
import sqlite3
import uuid

from .constants import MAPS, normalize_map

VERSION = 'evidence-preservation-v1'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def utcnow():
    return datetime.now(timezone.utc).isoformat()


class EvidenceLedger:
    def __init__(self, path, *, reserve_bytes=25_000_000):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.reserve_bytes = reserve_bytes
        self.errors = []
        self.inserted = 0
        with self.connect() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS journal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS observations(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,evidence_id TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,
                    observed_at TEXT NOT NULL,archived_at TEXT NOT NULL,source_url TEXT,
                    source_content_hash TEXT,facts_hash TEXT NOT NULL,previous_id TEXT,
                    payload_json TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS observation_entity ON observations(kind,source_id,external_id,seq DESC);
                CREATE TABLE IF NOT EXISTS cursors(name TEXT PRIMARY KEY,last_rowid INTEGER NOT NULL);
            ''')
            c.execute('INSERT OR IGNORE INTO journal_meta VALUES(?,?)', ('stream_id', str(uuid.uuid4())))
            c.execute('INSERT OR IGNORE INTO journal_meta VALUES(?,?)', ('schema_version', VERSION))

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=5)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

    def note_error(self, exc):
        if len(self.errors) < 10:
            self.errors.append(f'{type(exc).__name__}: {exc}'[:200])

    def append(self, kind, external_id, payload, *, source_id='vlr', observed_at,
               source_url=None, source_content_hash=None):
        if shutil.disk_usage(self.path.parent).free < self.reserve_bytes:
            raise RuntimeError('evidence_storage_reserve_reached_no_deletion')
        serialized = canonical(payload)
        if len(serialized.encode()) > 500_000:
            raise ValueError('evidence_record_too_large')
        facts_hash = hashlib.sha256(serialized.encode()).hexdigest()
        with self.connect() as c:
            previous = c.execute('''SELECT evidence_id,facts_hash FROM observations
                WHERE kind=? AND source_id=? AND external_id=? ORDER BY seq DESC LIMIT 1''',
                (kind, source_id, str(external_id))).fetchone()
            if previous and previous['facts_hash'] == facts_hash:
                return False
            previous_id = previous['evidence_id'] if previous else None
            identifier = hashlib.sha256(canonical([kind, source_id, str(external_id),
                                                   facts_hash, observed_at, previous_id]).encode()).hexdigest()
            c.execute('''INSERT INTO observations(evidence_id,kind,source_id,external_id,observed_at,
                archived_at,source_url,source_content_hash,facts_hash,previous_id,payload_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (identifier, kind, source_id, str(external_id),
                observed_at, utcnow(), source_url, source_content_hash, facts_hash, previous_id, serialized))
        self.inserted += 1
        return True

    def safe_append(self, *args, **kwargs):
        try:
            return self.append(*args, **kwargs)
        except Exception as exc:
            self.note_error(exc)
            return False

    def observe_match(self, result, soup, event):
        """Preserve visible source assertions, including incomplete/illegal scores."""
        def text(node):
            return node.get_text(' ', strip=True) if node else None
        def integer(node):
            value = text(node)
            return int(value) if value and re.fullmatch(r'\d+', value) else None
        teams = []
        for link in soup.select("a.match-header-link[href^='/team/']")[:2]:
            found = re.match(r'/team/(\d+)(?:/|$)', link['href'])
            teams.append({'source_team_id': found.group(1) if found else None, 'name': text(link)})
        date = soup.select_one('[data-utc-ts]')
        source_time = date.get('data-utc-ts') if date else None
        if source_time:
            try:
                source_time = datetime.strptime(source_time, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                source_time = None
        score_node = soup.select_one('.match-header-vs-score .sp-hide')
        score_text = text(score_node)
        numbers = re.fullmatch(r'\s*(\d+)\s*[:\-]\s*(\d+)\s*', score_text or '')
        score = [int(numbers[1]), int(numbers[2])] if numbers else None
        header = text(soup.select_one('.match-header-vs-score')) or ''
        bo = re.search(r'Bo([135])', header, re.I)
        notes = [text(node) for node in soup.select('.match-header-vs-note')]
        status = next((n.lower() for n in notes if n and n.lower() in {'final','completed','live','upcoming'}), None)
        maps = []
        for game in soup.select('.vm-stats-game[data-game-id]'):
            if game.get('data-game-id') == 'all':
                continue
            map_header = game.select_one('.vm-stats-game-header')
            sides = map_header.select('.team') if map_header else []
            map_node = map_header.select_one('.map') if map_header else None
            name = next(map_node.stripped_strings, None) if map_node else None
            if not name:
                continue
            # Raw map names are source facts; existing formal parser still owns normalization.
            entry = {'source_map_name':name, 'source_game_id':game.get('data-game-id'),
                     'score': [integer(t.select_one('.score')) for t in sides[:2]],
                     'score_authority':'SOURCE_OBSERVED_NOT_FORMAL','players':[]}
            try:
                entry['map_id'] = normalize_map(name)
                entry['map_name_zh'] = MAPS[entry['map_id']]
            except ValueError:
                entry['map_id'],entry['map_name_zh'] = None,None
            for team_index, table in enumerate(game.select('.ovw-table')[:2]):
                for row in table.select('.ovw-row')[1:]:
                    link = row.select_one("a[href^='/player/']")
                    if link is None:
                        continue
                    found = re.match(r'/player/(\d+)(?:/|$)',link['href'])
                    stats = {}
                    for label in ('rating2','acs','kills','deaths','assists','kast','adr','hsp','fk','fd','fb'):
                        cell = row.select_one(f'[data-col="{label}"] .side.mod-both')
                        value = text(cell)
                        stats[label] = None if value in {None,'','-','N/A'} else value
                    entry['players'].append({'source_player_id':found.group(1) if found else None,
                        'name':text(link),'team_index':team_index,
                        'agents':[i.get('alt') for i in row.select('.ovw-agents img') if i.get('alt')],
                        'source_statistics':stats})
            maps.append(entry)
        found = re.match(r'https://(?:www\.)?vlr\.gg/(\d+)(?:/|$)', result.url)
        if not found:
            return
        stage = soup.select_one('.match-header-event-series')
        payload = {'schema':VERSION,'authority':'SOURCE_OBSERVED_NOT_FORMAL',
            'event':{k:event.get(k) for k in ('external_event_id','name','region','classification')},
            'stage':text(stage),'source_match_time':source_time,'series_format':f'bo{bo[1]}' if bo else None,
            'source_status':status,'teams':teams,'source_series_score':score,
            'source_score_text':score_text,'maps':maps,
            'missing_fields':[k for k,v in {'teams':len(teams)==2,'match_time':source_time,
                'series_score':score,'maps':maps,'series_format':bo}.items() if not v]}
        self.safe_append('match_source',found[1],payload,observed_at=result.fetched_at,
                         source_url=result.url,source_content_hash=result.content_hash)

    def observe_team_page(self, result, soup, source_team_id):
        for item in soup.select('a.m-item[href],a.match-item[href]')[:50]:
            href = item.get('href','')
            found = re.match(r'/(\d+)/',href)
            node = item.select_one('.m-item-result:not(.mod-tbd)')
            score = re.fullmatch(r'\s*(\d+)\s*:\s*(\d+)\s*',node.get_text(' ',strip=True)) if node else None
            if not found or not score:
                continue
            self.safe_append('team_result_listing',f'{found[1]}:team:{source_team_id}',
                {'authority':'SOURCE_OBSERVED_NOT_FORMAL','known_source_team_id':str(source_team_id),
                 'source_match_id':found[1],
                 'source_series_score':[int(score[1]),int(score[2])],
                 'score_orientation':'as_displayed_not_normalized_to_canonical_teams',
                 'source_row_text':item.get_text(' ',strip=True)[:1500],
                 'match_url':'https://www.vlr.gg'+href,'maps':None},
                observed_at=result.fetched_at,source_url=result.url,source_content_hash=result.content_hash)

    def bootstrap_cached_teams(self, client):
        """One bounded pass of existing cache, zero source requests, not historical reconstruction."""
        with self.connect() as c:
            if c.execute("SELECT 1 FROM journal_meta WHERE key='cached_team_seed_done'").fetchone():
                return
        from .sources.vlr import FetchResult
        with client.store.connect() as c:
            rows = c.execute("SELECT payload FROM cache WHERE key LIKE '%/team/%' ORDER BY created DESC LIMIT 20").fetchall()
        for row in rows:
            page = json.loads(gzip.decompress(row[0]))
            found = re.search(r'/team/(?:matches/)?(\d+)(?:/|$)',page['url'])
            if found:
                result = FetchResult(page['url'],page['text'],page['fetched_at'],page['content_hash'],'')
                self.observe_team_page(result,client.soup(result),found[1])
        if not self.errors:
            with self.connect() as c:
                c.execute("INSERT OR IGNORE INTO journal_meta VALUES('cached_team_seed_done',?)",(utcnow(),))

    def sync_main_records(self, db):
        """Bounded private copies; never write the canonical database or invent as-of data."""
        with db.connect() as source:
            for table, key, bootstrap_limit in (('prospective_snapshots','snapshot_id',200), ('matches','match_id',200)):
                with self.connect() as c:
                    cursor = c.execute('SELECT last_rowid FROM cursors WHERE name=?',(table,)).fetchone()
                maximum = source.execute(f'SELECT COALESCE(MAX(rowid),0) FROM {table}').fetchone()[0]
                if cursor and maximum < cursor[0]:
                    raise RuntimeError('canonical_cursor_reset_requires_review')
                if cursor:
                    rows = source.execute(f'SELECT rowid AS archive_rowid,* FROM {table} WHERE rowid>? ORDER BY rowid LIMIT 200',(cursor[0],)).fetchall()
                elif table == 'prospective_snapshots':
                    rows = source.execute('''SELECT s.rowid AS archive_rowid,s.* FROM prospective_snapshots s
                        WHERE s.rowid=(SELECT MAX(s2.rowid) FROM prospective_snapshots s2 WHERE s2.fixture_id=s.fixture_id)
                        ORDER BY s.rowid DESC LIMIT 200''').fetchall()[::-1]
                else:
                    rows = source.execute(f'SELECT rowid AS archive_rowid,* FROM {table} ORDER BY rowid DESC LIMIT {bootstrap_limit}').fetchall()[::-1]
                last = cursor[0] if cursor else maximum
                for row in rows:
                    data = dict(row)
                    last = max(last, data.pop('archive_rowid'))
                    if table == 'prospective_snapshots':
                        # Outcomes are a separate stream; never mix postmatch labels into prematch features.
                        data = {k:data[k] for k in ('snapshot_id','fixture_id','observed_at','scheduled_at','checkpoint',
                            'quality_status','blocker_json','snapshot_json','content_hash','model_version','created_at')}
                        at = data['observed_at']
                        kind = 'prematch_snapshot'
                    else:
                        data['maps'] = [dict(r) for r in source.execute('SELECT * FROM map_results WHERE match_id=? ORDER BY map_order',(data[key],))]
                        data['players'] = [dict(r) for r in source.execute('SELECT * FROM match_player_stats WHERE match_id=? ORDER BY map_order,player_id',(data[key],))]
                        data['source_evidence'] = [dict(r) for r in source.execute('''SELECT source_id,source_url,content_hash,fetched_at,data_quality
                            FROM source_records WHERE entity_type='match' AND canonical_id=?''',(data[key],))]
                        data['archive_semantics'] = 'canonical_ingest_not_independent_asof_proof'
                        at = utcnow()
                        kind = 'canonical_match'
                    self.append(kind, data[key],data,source_id='canonical_db',observed_at=at)
                with self.connect() as c:
                    c.execute('INSERT OR REPLACE INTO cursors VALUES(?,?)',(table,last))
            # Preserve frozen formal inputs, not human archive or mutable settlement fields.
            for row in source.execute("SELECT * FROM predictions WHERE source LIKE 'system%'"):
                data = {k:v for k,v in dict(row).items() if k not in {'status','actual_winner_id','actual_score','resolved_match_id'}}
                self.append('frozen_prediction',data['prediction_id'],data,source_id='canonical_db',observed_at=data['locked_at'])
            teams = source.execute('''SELECT DISTINCT t.team_id,t.name,t.roster_version FROM teams t
                JOIN fixtures f ON t.team_id IN (f.team_a_id,f.team_b_id)
                WHERE julianday(f.scheduled_at)>julianday('now') AND julianday(f.scheduled_at)<julianday('now','+14 days')
                LIMIT 200''').fetchall()
            for team in teams:
                data = dict(team)
                data['semantics'] = 'current_database_observation_not_official_starting_roster'
                data['memberships'] = [dict(r) for r in source.execute('''SELECT h.player_id,p.name,h.effective_from,
                    h.roster_version,h.source_url FROM player_team_history h JOIN players p USING(player_id)
                    WHERE h.team_id=? AND h.effective_to IS NULL ORDER BY h.player_id''',(team['team_id'],))]
                self.append('team_roster_observation',team['team_id'],data,source_id='canonical_db',observed_at=utcnow())

    def summary(self):
        with self.connect() as c:
            count, maximum = c.execute('SELECT COUNT(*),COALESCE(MAX(seq),0) FROM observations').fetchone()
        return {'version':VERSION,'status':'DEGRADED' if self.errors else 'PRESERVING',
                'records':count,'last_sequence':maximum,'inserted_this_cycle':self.inserted,
                'bytes':self.path.stat().st_size,'errors':list(self.errors),
                'formal_authority':False,'automatic_deletion':False}
