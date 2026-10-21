from __future__ import annotations

from datetime import datetime, timedelta, timezone
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
import runner_service
from vct_prediction.automation import SOURCE, _upsert_fixture, _register_source, _record_prospective_snapshot, _prospective_stats, observe_result_candidate
from vct_prediction.db import Database
from vct_prediction.history_preparation import apply_history_batch, protected_digest
from vct_prediction.ingest import record_match
from vct_prediction.predictor import predict_match
from vct_prediction.readiness import ReadinessStore, PreparedVlrClient, team_result_links, history_record, prepare_history
from vct_prediction.sources.vlr import VlrClient
from vct_prediction.realdata import import_collection


NOW=datetime(2026,10,20,10,tzinfo=timezone.utc)


def result(identifier: int, day: int, reverse=False):
    a,b='vlr_team_1','vlr_team_2'
    stats=[]
    for order in (1,2):
        for tid in (a,b):
            for i in range(5):
                stats.append(dict(match_id=f'vlr_match_{identifier}',map_order=order,player_id=f'{tid}_p{i}',
                    player_name=f'isolated player {i}',team_id=tid,agent='Sova',rating=None,acs=200,adr=130,
                    kills=10,deaths=10,assists=4,kast=None,hs_pct=None,first_kills=1,first_deaths=1))
    record=dict(match_id=f'vlr_match_{identifier}',external_match_id=str(identifier),event_id='1',event='Isolated Event',
        region='CN',stage='test',played_at=NOW.replace(day=day).isoformat(),patch='cohort:test',series_format='bo3',
        team_a_id=a,team_b_id=b,winner_id=b if reverse else a,team_a_maps=0 if reverse else 2,team_b_maps=2 if reverse else 0,
        teams=[{'team_id':tid,'external_team_id':tid.removeprefix('vlr_team_'),'name':tid} for tid in (a,b)],
        maps=[{'map_order':i,'map':m,'team_a_rounds':6 if reverse else 13,'team_b_rounds':13 if reverse else 6}
              for i,m in enumerate(('bind','lotus'),1)],player_stats=stats,is_international=False,importance=1.0,
        source_url=f'https://www.vlr.gg/{identifier}/isolated-test',data_quality='verified_result_community_source',
        fetched_at=NOW.isoformat(),raw_path='isolated.html',content_hash=f'raw{identifier}',normalized_hash=f'normalized{identifier}',
        result_finality_status='FINAL_CANDIDATE')
    return record


def collection(records):
    return dict(source=SOURCE,scope={'mode':'isolated_readiness_unit_test'},issues=[],matches=records,
        events=[dict(external_event_id='1',name='Isolated Event',region='CN',classification='qualification',included=True,
                     status='completed',source_url='https://www.vlr.gg/event/1/test',fetched_at=NOW.isoformat())])


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.db=Database(self.root/'main.sqlite3')
        self.db.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def test_old_history_replayed_chronologically_and_predictions_unchanged(self):
        late=result(2,19)
        early=result(1,10,True)
        import_collection(self.db,collection([late]),snapshot_root=self.root)
        predict_match(self.db,team_a_id=late['team_a_id'],team_b_id=late['team_b_id'],scheduled_at=(NOW+timedelta(days=1)).isoformat(),
                      event='Isolated Future',region='CN',patch='cohort:test',series_format='bo3',map_pool=['bind','lotus','haven'],source='isolated_test')
        with self.db.connect() as c:
            before=protected_digest(c)
        report=apply_history_batch(self.db,collection([early]),cutoff=NOW.isoformat(),raw_root=self.root)
        self.assertTrue(report['protected_ledger_unchanged'])
        reference=Database(self.root/'chronological.sqlite3')
        import_collection(reference,collection([early,late]),snapshot_root=self.root)
        self.assertAlmostEqual(self.db.fetch_team(late['team_a_id'])['rating'],reference.fetch_team(late['team_a_id'])['rating'])
        self.assertEqual(self.db.fetch_team(late['team_a_id'])['matches_played'],2)
        with self.db.connect() as c:
            self.assertEqual(before,protected_digest(c))
            self.assertEqual(c.execute('SELECT COUNT(*) FROM player_team_history WHERE effective_to IS NOT NULL AND julianday(effective_to)<julianday(effective_from)').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM prospective_snapshots').fetchone()[0],0)
        self.assertTrue((self.root/'readiness-last-good.sqlite3').exists())

    def test_duplicate_import_does_not_count_twice(self):
        r=result(1,10)
        apply_history_batch(self.db,collection([r]),cutoff=NOW.isoformat(),raw_root=self.root)
        report=apply_history_batch(self.db,collection([r]),cutoff=NOW.isoformat(),raw_root=self.root)
        self.assertEqual(report['records_inserted'],0)
        self.assertEqual(self.db.fetch_team(r['team_a_id'])['matches_played'],1)

    def test_equal_or_future_cutoff_is_rejected_without_writes(self):
        for day in (20,21):
            with self.assertRaisesRegex(ValueError,'strictly_before'):
                apply_history_batch(self.db,collection([result(day,day)]),cutoff=NOW.isoformat(),raw_root=self.root)
        with self.db.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM matches').fetchone()[0],0)

    def test_existing_fact_conflict_does_not_overwrite_production(self):
        r=result(1,10)
        import_collection(self.db,collection([r]),snapshot_root=self.root)
        changed=result(1,10,True)
        changed['normalized_hash']='different'
        with self.assertRaisesRegex(ValueError,'conflict_quarantined'):
            apply_history_batch(self.db,collection([changed]),cutoff=NOW.isoformat(),raw_root=self.root)
        with self.db.connect() as c:
            self.assertEqual(c.execute('SELECT winner_id FROM matches').fetchone()[0],r['team_a_id'])

    def test_concurrent_write_defers_without_replacing_other_writer(self):
        from vct_prediction.history_preparation import refresh_derived_team_factors
        import_collection(self.db,collection([result(2,19)]),snapshot_root=self.root)
        def other_writer(staged):
            refresh_derived_team_factors(staged)
            with self.db.connect() as c:
                c.execute("UPDATE teams SET name='external current name' WHERE team_id='vlr_team_1'")
        with patch('vct_prediction.history_preparation.refresh_derived_team_factors',side_effect=other_writer):
            with self.assertRaisesRegex(RuntimeError,'concurrent_write'):
                apply_history_batch(self.db,collection([result(1,10)]),cutoff=NOW.isoformat(),raw_root=self.root)
        with self.db.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM matches').fetchone()[0],1)
            self.assertEqual(c.execute("SELECT name FROM teams WHERE team_id='vlr_team_1'").fetchone()[0],'external current name')


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.store=ReadinessStore(self.root/'sidecar.sqlite3')
        self.calls=[]

    def tearDown(self):
        self.temp.cleanup()

    def client(self, body='<html/>', status=200, limit=160):
        client=PreparedVlrClient(self.root/'raw',self.store,now=NOW,request_limit=limit)
        client.client.close()
        client.client=httpx.Client(transport=httpx.MockTransport(lambda req:(self.calls.append(str(req.url)) or httpx.Response(status,text=body))),follow_redirects=True)
        client.delay_seconds=0
        return client

    def fixture(self):
        db=Database(self.root/'main.sqlite3')
        db.initialize()
        _register_source(db)
        fixture=dict(fixture_id='vlr_fixture_9',external_match_id='9',external_event_id='1',event='VCT CN Qualifier',region='CN',classification='qualification',
            scheduled_at=(NOW+timedelta(hours=12)).isoformat(),series_format='bo3',patch=None,patch_provenance='unavailable',
            teams=[dict(team_id='vlr_team_1',external_team_id='1',name='A'),dict(team_id='vlr_team_2',external_team_id='2',name='B')],
            fetched_at=NOW.isoformat(),source_url='https://www.vlr.gg/9/test',content_hash='synthetic',status='scheduled',blockers=[])
        _upsert_fixture(db,fixture,NOW)
        return db,fixture

    def test_indexes_cached_across_cycles_but_not_falsely_refetched(self):
        a=self.client()
        first=a.fetch('/events/?region=all&tier=all')
        a.close()
        b=self.client()
        second=b.fetch('/events/?region=all&tier=all')
        self.assertEqual(len(self.calls),1)
        self.assertEqual(second.fetched_at,first.fetched_at)
        self.assertEqual(b.cache_hits,1)
        self.assertEqual(b.network_requests,0)
        b.close()

    def test_pending_result_never_uses_previous_cycle_cache(self):
        for _ in range(2):
            client=self.client()
            client.live_matches={'7':(NOW-timedelta(hours=2)).isoformat()}
            client.fetch('/7/result')
            client.close()
        self.assertEqual(len(self.calls),2)

    def test_retry_attempts_are_charged_to_request_budget(self):
        client=self.client(status=503,limit=1)
        client.retry_delays=(0,0)
        with self.assertRaises(RuntimeError):
            client.fetch('/unavailable')
        self.assertEqual(len(self.calls),1)
        self.assertEqual(client.network_requests,1)
        client.close()

    def test_history_cannot_consume_foreground_request_reserve(self):
        client=self.client()
        client.history_mode=True
        client.history_request_limit=2
        client.fetch('/1/match')
        client.fetch('/2/match')
        with self.assertRaisesRegex(RuntimeError,'budget_deferred'):
            client.fetch('/3/match')
        self.assertEqual(len(self.calls),2)
        client.close()

    def test_future_team_card_not_mistaken_for_result_date_colon(self):
        body='''<h1>Team</h1><a class="m-item" href="/1/future"><div class="m-item-result mod-tbd">1h</div>18:00</a>
            <a class="m-item" href="/2/past"><div class="m-item-result mod-win"><span>2</span>:<span>1</span></div></a>'''
        client=self.client(body)
        self.assertEqual(team_result_links(client,'vlr_team_10'),['/2/past'])
        client.close()

    def test_only_one_observed_archive_page_and_twenty_candidates(self):
        home='<h1>Team</h1><a href="/team/matches/10/team/?group=completed">more</a>'
        archive=''.join(f'<a class="m-item" href="/{i}/past"><div class="m-item-result">2:1</div></a>' for i in range(1,26))
        archive+='<a href="/team/matches/10/team/?page=2">Next</a>'
        client=self.client()
        client.client.close()
        def response(req):
            self.calls.append(str(req.url))
            return httpx.Response(200,text=archive if '/matches/' in req.url.path else home)
        client.client=httpx.Client(transport=httpx.MockTransport(response),follow_redirects=True)
        self.assertEqual(len(team_result_links(client,'vlr_team_10')),20)
        self.assertEqual(len(self.calls),2)
        self.assertFalse(any('page=2' in url for url in self.calls))
        client.close()

    def test_missing_map_pages_cool_down_and_remaining_candidates_resume(self):
        db,fixture=self.fixture()
        client=self.client()
        links=[f'/{i}/missing-map' for i in range(1,7)]
        inspected=[]
        def missing(c,href,region):
            c.before_network_request()
            inspected.append(href)
            return None,{'reason':'map_evidence_missing'}
        with patch('vct_prediction.readiness.team_result_links',return_value=links),patch('vct_prediction.readiness.history_record',side_effect=missing):
            first=prepare_history(db,client,now=NOW,pages=3)
            self.assertEqual(first['requests'],3)
            self.assertEqual(first['historical_matches_imported'],0)
            second=prepare_history(db,client,now=NOW+timedelta(minutes=16),pages=3)
            self.assertEqual(second['requests'],3)
            self.assertEqual(len(inspected),len(set(inspected)))
            self.assertEqual(client.store.job('vlr_team_1')['status'],'DATA_GAP_MISSING_MAP_EVIDENCE')
        with db.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM matches').fetchone()[0],0)
        client.close()

    def test_no_public_history_is_watched_not_fake_prediction(self):
        db,fixture=self.fixture()
        client=self.client('<h1>Team with no public results</h1>')
        report=prepare_history(db,client,now=NOW)
        self.assertEqual({t['status'] for t in report['teams']},{'COLD_START_NO_PUBLIC_RESULTS'})
        with db.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM predictions').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM prospective_snapshots').fetchone()[0],0)
        before=len(self.calls)
        prepare_history(db,client,now=NOW+timedelta(minutes=15))
        self.assertEqual(len(self.calls),before)
        client.close()

    def test_history_requires_second_cycle_and_one_observation_per_match(self):
        db,fixture=self.fixture()
        client=self.client()
        rows={f'/{i}/test':result(i,10+i) for i in (1,2,3)}
        event=collection([])['events'][0]
        def parsed(_client,href,_region):
            _client.before_network_request()
            return deepcopy(rows[href]),event
        with patch('vct_prediction.readiness.team_result_links',return_value=list(rows)),patch('vct_prediction.readiness.history_record',side_effect=parsed) as parser:
            first=prepare_history(db,client,now=NOW)
            self.assertEqual(first['historical_matches_imported'],0)
            self.assertEqual(parser.call_count,3)
            self.assertEqual(first['requests'],3)
            for row in rows.values():
                row['fetched_at']=(NOW+timedelta(minutes=16)).isoformat()
            second=prepare_history(db,client,now=NOW+timedelta(minutes=16))
            self.assertEqual(second['historical_matches_imported'],3)
            self.assertEqual({t['status'] for t in second['teams']},{'HISTORY_READY'})
        with db.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM matches').fetchone()[0],3)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM predictions').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM prospective_snapshots').fetchone()[0],0)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM result_candidates WHERE status='FINAL_CONFIRMED'").fetchone()[0],3)
        client.close()

    def test_fresh_history_parse_cannot_fall_back_to_stale_persistent_page(self):
        body='<a class="match-header-event" href="/event/1/test"><div><div>VCT CN Qualifier</div><div class="match-header-event-series">Group</div></div></a>'
        client=self.client(body)
        client.fetch('/1/match')
        client.client.close()
        fresh=body+'fresh-observation'
        client.client=httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(200,text=fresh)),follow_redirects=True)
        client.history_mode=True
        def parse(c,href,event):
            page=c.fetch(href)
            self.assertEqual(page.text,fresh)
            return {'proof':True},{}
        with patch.object(VlrClient,'parse_match',parse):
            record,event=history_record(client,'/1/match','CN')
        self.assertTrue(record['proof'])
        self.assertEqual(client.network_requests,2)
        client.close()

    def test_post_preparation_snapshot_uses_actual_observation_and_non_primary_cohort(self):
        db,fixture=self.fixture()
        at=NOW+timedelta(minutes=30)
        fixture['map_pool']=['bind','lotus','haven']
        _record_prospective_snapshot(db,fixture,'blocked',['team_history_below_three_series'],at,observed_at=at.isoformat())
        with db.connect() as c:
            row=c.execute('SELECT * FROM prospective_snapshots').fetchone()
            self.assertEqual(row['observed_at'],at.isoformat())
            payload=json.loads(row['snapshot_json'])
            self.assertEqual(payload['source']['fixture_fetched_at'],NOW.isoformat())
            self.assertFalse(payload['primary_training_eligible_competition'])
            self.assertLess(datetime.fromisoformat(row['observed_at']),datetime.fromisoformat(row['scheduled_at']))
        self.assertEqual(_prospective_stats(db)['gold_training_eligible'],0)


class SchedulingTests(unittest.TestCase):
    def test_imminent_confirmation_gets_bounded_retry(self):
        team={'next_match':(NOW+timedelta(hours=12)).isoformat(),'status':'PENDING_CONFIRMATION',
              'next_check_at':(NOW+timedelta(minutes=15)).isoformat()}
        state={'lastRun':{'counters':{'data_readiness':{'teams':[team]}}}}
        config={'interval':7200,'failure_retry':900,'horizon_hours':48}
        with patch.dict(runner_service.STATE,state,clear=True):
            self.assertEqual(runner_service.next_cycle_delay(config,True,current=NOW),900)
            team['status']='COLD_START_NO_PUBLIC_RESULTS'
            self.assertEqual(runner_service.next_cycle_delay(config,True,current=NOW),7200)
            team['status']='PENDING_CONFIRMATION'
            team['next_match']=(NOW+timedelta(days=10)).isoformat()
            self.assertEqual(runner_service.next_cycle_delay(config,True,current=NOW),7200)


if __name__=='__main__':
    unittest.main()
