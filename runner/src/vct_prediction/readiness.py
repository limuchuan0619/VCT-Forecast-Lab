"""Small, persistent readiness queue and bounded public-source cache.

This sidecar is operational metadata, not a new training dataset or model.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .competition import event_policy
from .db import Database
from .history_preparation import apply_history_batch
from .sources.vlr import BASE_URL, FetchResult, VlrClient

READINESS_VERSION = 'data-readiness-v1'


class ReadinessStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,payload BLOB NOT NULL,expires REAL NOT NULL,created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(team_id TEXT PRIMARY KEY,status TEXT NOT NULL,payload TEXT NOT NULL,next_at REAL NOT NULL,updated TEXT NOT NULL);''')

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def cached(self, key: str, now: float):
        with self.connect() as c:
            row = c.execute('SELECT payload FROM cache WHERE key=? AND expires>?', (key,now)).fetchone()
        return json.loads(gzip.decompress(row[0])) if row else None

    def cache(self, key: str, payload: dict[str, Any], now: float, ttl: int):
        blob = gzip.compress(json.dumps(payload).encode())
        if len(blob)>1_000_000:
            return
        with self.connect() as c:
            c.execute('INSERT OR REPLACE INTO cache VALUES(?,?,?,?)', (key,blob,now+ttl,now))
            c.execute('DELETE FROM cache WHERE expires<?', (now-7200,))
            # Only our disposable cache entries are evicted, never production facts.
            while c.execute('SELECT COALESCE(SUM(length(payload)),0) FROM cache').fetchone()[0] > 10_000_000:
                c.execute('DELETE FROM cache WHERE key=(SELECT key FROM cache ORDER BY created LIMIT 1)')

    def job(self, team_id: str):
        with self.connect() as c:
            row = c.execute('SELECT status,payload,next_at FROM jobs WHERE team_id=?', (team_id,)).fetchone()
        return {'status':row[0], **json.loads(row[1]), 'next_at':row[2]} if row else None

    def save_job(self, team_id: str, status: str, payload: dict[str, Any], next_at: float):
        with self.connect() as c:
            c.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)', (team_id,status,json.dumps(payload,ensure_ascii=False),next_at,datetime.now(timezone.utc).isoformat()))


class PreparedVlrClient(VlrClient):
    def __init__(self, raw_root, store: ReadinessStore, *, now: datetime, request_limit=160, seconds=240):
        super().__init__(raw_root)
        self.store, self.reference = store, now
        self.request_limit, self.deadline = request_limit, time.monotonic()+seconds
        self.network_requests, self.cache_hits = 0, 0
        self.history_mode = False
        self.parsing_history = False
        self.history_deadline = self.deadline
        self.history_request_limit = request_limit
        self.live_matches: dict[str, str] = {}
        self.urgent_events: set[str] = set()

    def before_network_request(self):
        if self.network_requests >= min(self.request_limit,self.history_request_limit) or time.monotonic() >= min(self.deadline,self.history_deadline):
            raise RuntimeError('source_request_budget_deferred')
        self.network_requests += 1

    def source_retry_allowed(self, delay):
        return self.network_requests < min(self.request_limit,self.history_request_limit) and time.monotonic()+delay < min(self.deadline,self.history_deadline)

    def fetch(self, path_or_url):
        if self.parsing_history:
            return super().fetch(path_or_url)
        url = path_or_url if path_or_url.startswith('http') else BASE_URL+path_or_url
        path = urlparse(url).path
        ttl = 0
        if path.startswith('/events'):
            ttl = 7200
        elif path.startswith('/event/matches/'):
            identifier = path.split('/')[3]
            ttl = 300 if identifier in self.urgent_events else 1800
        elif path.startswith('/team/'):
            ttl = 21600
        elif re.match(r'^/\d+/', path) and not self.history_mode:
            scheduled = self.live_matches.get(path.split('/')[1])
            if scheduled:
                delta = (datetime.fromisoformat(scheduled.replace('Z','+00:00'))-self.reference).total_seconds()
                ttl = 300 if 0<delta<10800 else 900 if delta>0 else 0
            else:
                ttl = 900
        # Results/history candidates always need a new source observation.
        if ttl:
            cached = self.store.cached(url, self.reference.timestamp())
            if cached:
                self.cache_hits += 1
                raw = self.snapshot_root/(cached['content_hash'][:16]+'.html')
                if not raw.exists():
                    raw.write_text(cached['text'],encoding='utf-8')
                return FetchResult(cached['url'],cached['text'],cached['fetched_at'],cached['content_hash'],str(raw))
        if self.history_mode and re.match(r'^/\d+/',path):
            self._response_cache.pop(url,None)
        result = super().fetch(url)
        if ttl:
            self.store.cache(url,{'url':result.url,'text':result.text,'fetched_at':result.fetched_at,'content_hash':result.content_hash},self.reference.timestamp(),ttl)
        return result


def prior_count(db: Database, team_id: str, cutoff: str) -> int:
    with db.connect() as c:
        return c.execute('SELECT COUNT(*) FROM matches WHERE processed=1 AND (team_a_id=? OR team_b_id=?) AND julianday(played_at)<julianday(?)', (team_id,team_id,cutoff)).fetchone()[0]


def team_result_links(client: VlrClient, team_id: str) -> list[str]:
    identifier = team_id.removeprefix('vlr_team_')
    if not identifier.isdigit():
        raise ValueError('unverified_team_identity')
    result = client.fetch('/team/'+identifier)
    if not re.match(rf'^/team/{identifier}(?:/|$)', urlparse(result.url).path):
        raise ValueError('source_team_identity_mismatch')
    soup = client.soup(result)
    ledger = getattr(client,'evidence_store',None)
    if ledger is not None:
        try:
            ledger.observe_team_page(result,soup,identifier)
        except Exception as exc:
            ledger.note_error(exc)
    if not soup.select_one('h1'):
        raise ValueError('source_team_header_missing')
    links=[]
    def add_results(page):
        for a in page.select('a.m-item[href],a.match-item[href]'):
            href = a.get('href','').split('?')[0]
            score=a.select_one('.m-item-result:not(.mod-tbd),.match-item-vs')
            if re.match(r'^/\d+/',href) and score is not None and re.fullmatch(r'\s*\d+\s*:\s*\d+\s*',score.get_text(' ',strip=True)) and href not in links:
                links.append(href)
            if len(links)>=20:
                break
    add_results(soup)
    # At most one observed archive page, never archive pagination/full backfill.
    archive=next((a['href'] for a in soup.select('a[href]')
                  if re.match(rf'^/team/matches/{identifier}/',a['href']) and 'group=completed' in a['href']),None)
    if archive and len(links)<20:
        page=client.fetch(archive)
        if not re.match(rf'^/team/matches/{identifier}/',urlparse(page.url).path):
            raise ValueError('source_team_archive_identity_mismatch')
        archive_soup=client.soup(page)
        if ledger is not None:
            try:
                ledger.observe_team_page(page,archive_soup,identifier)
            except Exception as exc:
                ledger.note_error(exc)
        add_results(archive_soup)
    return links[:20]


def history_record(client: VlrClient, href: str, region: str):
    result = client.fetch(href)
    soup = client.soup(result)
    event_link = soup.select_one('a.match-header-event[href]')
    found = re.match(r'/event/(\d+)',event_link.get('href','')) if event_link else None
    name = (event_link.select_one('.match-header-event-name') or event_link.select_one('div > div:not(.match-header-event-series)')) if event_link else None
    if not found or name is None:
        return None, {'reason':'historical_event_unavailable'}
    title = name.get_text(' ',strip=True)
    policy = event_policy(title,region)
    event = {'external_event_id':found.group(1),'name':title,'source_url':BASE_URL+event_link['href'],
             'fetched_at':result.fetched_at,'status':'completed',**policy}
    # Parsing reuses the exact fetched page, not a second network request.
    old = client.history_mode
    old_parsing = client.parsing_history
    client.history_mode = False
    client.parsing_history = True
    client._response_cache[result.url] = result
    client._response_cache[href if href.startswith('http') else BASE_URL+href] = result
    client._cache_responses = True
    try:
        record, issue = client.parse_match(href,event)
    finally:
        client.history_mode = old
        client.parsing_history = old_parsing
    return (record,event) if record else (None,issue)


def prepare_history(db: Database, client: PreparedVlrClient, *, now: datetime, pages=10, seconds=90) -> dict[str, Any]:
    from .automation import SOURCE, observe_result_candidate
    cutoff = now.isoformat()
    with db.connect() as c:
        fixtures=[dict(r) for r in c.execute('''SELECT * FROM fixtures WHERE prediction_id IS NULL
            AND julianday(scheduled_at)>julianday(?) AND julianday(scheduled_at)<=julianday(?)
            AND classification IN ('regional','international','qualification','secondary','invitational')
            AND region IN ('CN','EMEA','AMERICAS','PACIFIC','INTERNATIONAL')
            ORDER BY CASE WHEN region='CN' THEN 0 ELSE 1 END,julianday(scheduled_at),fixture_id''',
            (cutoff,(now+timedelta(days=14)).isoformat()))]
    teams={}
    for f in fixtures:
        for side in ('a','b'):
            identifier=f['team_'+side+'_id']
            if identifier and identifier not in teams:
                teams[identifier]={'name':f['team_'+side+'_name'],'region':f['region'],'next_match':f['scheduled_at']}
    start=client.network_requests
    client.history_mode=True
    client.history_request_limit=min(client.request_limit,start+pages)
    client.history_deadline=min(client.deadline,time.monotonic()+seconds)
    old_timeout=client.client.timeout
    client.client.timeout=10
    records, events, attempted, inspected = {}, {}, [], 0
    seen = set()
    failures=[]
    try:
        for identifier,team in teams.items():
            count=prior_count(db,identifier,cutoff)
            if count>=3:
                continue
            existing=client.store.job(identifier)
            if existing and existing['next_at']>now.timestamp():
                continue
            if client.network_requests-start>=pages or time.monotonic()>=client.history_deadline:
                break
            attempted.append(identifier)
            links=[]
            accepted=0
            candidates=0
            exhausted=True
            try:
                if existing and existing.get('link_schema_version')==2 and existing.get('links') and existing.get('links_expire_at',0)>now.timestamp():
                    links=existing['links']
                    links_expire_at=existing['links_expire_at']
                else:
                    links=team_result_links(client,identifier)
                    links_expire_at=now.timestamp()+21600
                rejected_source=False
                deferred_links=(existing or {}).get('deferred_links',{})
                for href in links:
                    if client.network_requests-start>=pages or time.monotonic()>=client.history_deadline:
                        exhausted=False
                        break
                    external=re.match(r'/(\d+)/',href).group(1)
                    if deferred_links.get(external,{}).get('next_at',0)>now.timestamp():
                        continue
                    if external in seen:
                        continue
                    with db.connect() as c:
                        if c.execute('SELECT 1 FROM matches WHERE match_id=?',('vlr_match_'+external,)).fetchone():
                            continue
                    seen.add(external)
                    record,event=history_record(client,href,team['region'])
                    inspected+=1
                    if not record:
                        reason=event.get('reason','source_unavailable')
                        failures.append({'team_id':identifier,'match_id':external,'reason':reason})
                        deferred_links[external]={'reason':reason,'next_at':now.timestamp()+(21600 if reason=='map_evidence_missing' else 1800)}
                        rejected_source=True
                        continue
                    played=datetime.fromisoformat(record['played_at'])
                    if played>=now or played<now-timedelta(days=365) or identifier not in {record['team_a_id'],record['team_b_id']}:
                        continue
                    candidates+=1
                    confirmed,_=observe_result_candidate(db,record,record['fetched_at'])
                    if confirmed:
                        record['result_finality_status']='FINAL_CONFIRMED'
                        records[external]=record
                        events[event['external_event_id']]=event
                        accepted+=1
                    if count+accepted>=3:
                        break
                map_gaps=any(item.get('reason')=='map_evidence_missing' for item in deferred_links.values())
                status='PENDING_CONFIRMATION' if candidates else 'QUEUED' if links and not exhausted else 'DATA_GAP_MISSING_MAP_EVIDENCE' if map_gaps else 'SOURCE_RETRY' if rejected_source else 'COLD_START_INSUFFICIENT_RECENT_HISTORY' if links else 'COLD_START_NO_PUBLIC_RESULTS'
                # Retry source evidence once next cycle, cool down genuine gaps.
                client.store.save_job(identifier,status,{**team,'links':links,'link_schema_version':2,'links_expire_at':links_expire_at,'deferred_links':deferred_links,'prior_series':count},now.timestamp()+(21600 if status.startswith('COLD_START') or status=='DATA_GAP_MISSING_MAP_EVIDENCE' else 1800 if status=='SOURCE_RETRY' else 900))
            except Exception as exc:
                failures.append({'team_id':identifier,'reason':str(exc)[:180]})
                client.store.save_job(identifier,'SOURCE_RETRY',{**team,'links':links,'prior_series':count},now.timestamp()+1800)
    finally:
        client.history_mode=False
        client.history_deadline=client.deadline
        client.history_request_limit=client.request_limit
        client.client.timeout=old_timeout
    imported=0
    if records:
        # Actual observed/freeze time is after collection; no retrospective lock.
        apply_cutoff=datetime.now(timezone.utc).isoformat()
        collection={'source':SOURCE,'scope':{'mode':'targeted_prematch_history','not_training':True},
                    'events':list(events.values()),'matches':list(records.values()),'issues':[]}
        report=apply_history_batch(db,collection,cutoff=apply_cutoff,raw_root=client.snapshot_root)
        imported=report['records_inserted']
    for identifier in attempted:
        if prior_count(db,identifier,datetime.now(timezone.utc).isoformat())>=3:
            team=teams[identifier]
            client.store.save_job(identifier,'HISTORY_READY',team,now.timestamp()+21600)
    states=[]
    for identifier,team in teams.items():
        count=prior_count(db,identifier,cutoff)
        job=client.store.job(identifier)
        states.append({'team_id':identifier,**team,'prior_series':count,
                       'status':'HISTORY_READY' if count>=3 else (job or {}).get('status','QUEUED'),
                       'next_check_at':datetime.fromtimestamp(job['next_at'],timezone.utc).isoformat() if job else None})
    return {'version':READINESS_VERSION,'preparation_days':14,'formal_lock_hours_unchanged':True,
            'requests':client.network_requests-start,'request_budget':pages,'seconds_budget':seconds,
            'matches_inspected':inspected,'historical_matches_imported':imported,'teams':states[:100],
            'tbd_fixtures':sum(not f['team_a_id'] or not f['team_b_id'] for f in fixtures),'issues':failures[:20]}
