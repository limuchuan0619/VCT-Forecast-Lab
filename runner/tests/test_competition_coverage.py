from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from vct_prediction.competition import event_policy, is_primary, can_predict, COVERAGE_VERSION
from vct_prediction.sources.vlr import VlrClient, FetchResult, classify_event
from vct_prediction.automation import _quality, _record_prospective_snapshot, _prospective_stats, _lock_ready_predictions, _ordered_fixture_links, run_daily_automation
from vct_prediction.db import Database
from bridge.vct_public_bridge import state_payload


def card(identifier,title,status='upcoming',flag='un',dates='Nov 1–3'):
    return f'''<a class="event-item" href="/event/{identifier}/event-slug"><div class="event-item-title">{title}</div>
      <span class="event-item-desc-item-status">{status}</span><div class="mod-dates">{dates}<div>Dates</div></div>
      <div class="mod-location"><i class="flag mod-{flag}"></i></div></a>'''


class IndexClient(VlrClient):
    def __init__(self,pages):
        super().__init__(Path(tempfile.gettempdir())/'vct-coverage-unit-pages',delay_seconds=0)
        self.pages=pages
        self.requested=[]

    def fetch(self,path):
        self.requested.append(path)
        value=self.pages.get(path,'<a href="?region=all">All</a>')
        if isinstance(value,Exception):
            raise value
        return FetchResult('https://www.vlr.gg'+path,value,'2026-10-19T00:00:00Z',hashlib.sha256(value.encode()).hexdigest(),'synthetic.html')


class PolicyTests(unittest.TestCase):
    def test_imminent_and_result_recovery_precede_unknown_and_far_future(self):
        now=datetime(2026,10,19,tzinfo=timezone.utc)
        links=['/1/result/','/2/near/','/3/far/','/4/unknown/']
        known={'1':(now-timedelta(hours=2)).isoformat(),'2':(now+timedelta(hours=3)).isoformat(),
               '3':(now+timedelta(days=8)).isoformat()}
        self.assertEqual(_ordered_fixture_links(links,known,now,48),[links[0],links[1],links[3],links[2]])

    def test_retry_rotation_advances_unknown_queue_in_fifteen_minutes(self):
        now=datetime(2026,10,19,tzinfo=timezone.utc)
        links=[f'/{i}/unknown/' for i in range(50)]
        before=_ordered_fixture_links(links,{},now,48)
        after=_ordered_fixture_links(links,{},now+timedelta(minutes=15),48)
        self.assertNotEqual(before[:24],after[:24])
        self.assertEqual(set(before),set(after))

    def test_legacy_four_region_primary_contract(self):
        for name,region in (('China','CN'),('EMEA','EMEA'),('Americas','AMERICAS'),('Pacific','PACIFIC')):
            for stage in ('Kickoff','Stage 1','Stage 2'):
                policy=event_policy(f'VCT 2026: {name} {stage}')
                self.assertEqual((policy['included'],policy['region'],policy['classification']),(True,region,'regional'))

    def test_2027_cups_and_opens(self):
        for region in ('China','EMEA','Americas','Pacific'):
            self.assertEqual(event_policy(f'VCT 2027: {region} Cup 1')['classification'],'regional')
            self.assertEqual(event_policy(f'VCT 2027: {region} Kickoff Open Qualifier')['classification'],'qualification')

    def test_cn_ascension_threshold_and_evolution_are_distinct(self):
        self.assertEqual(event_policy('VCT 2026: China Ascension')['classification'],'qualification')
        self.assertEqual(event_policy('VCT 2026: China Threshold')['classification'],'qualification')
        self.assertEqual(event_policy('China Evolution Series 2026: Act 3')['classification'],'secondary')

    def test_source_region_resolves_yearless_invitational(self):
        policy=event_policy('Red Bull Home Ground','EMEA')
        self.assertTrue(policy['included'])
        self.assertEqual(policy['classification'],'invitational')
        self.assertFalse(is_primary(policy['classification']))

    def test_unknown_region_is_not_guessed(self):
        self.assertFalse(event_policy('FGC 2026')['included'])
        self.assertEqual(event_policy('FGC 2026')['region'],'OTHER')

    def test_other_circuits_exhibition_unknown_observed_not_predicted(self):
        for title in ('Game Changers 2026: China','China Academy Cup','VCT China All-Star Showmatch','Unknown Event'):
            policy=event_policy(title,'CN')
            self.assertTrue(policy['watched'])
            self.assertFalse(policy['included'])

    def test_international_not_host_region(self):
        self.assertEqual(event_policy('Valorant Champions 2027','CN')['region'],'INTERNATIONAL')

    def test_national_and_other_global_cups_do_not_enter_vct_gate(self):
        self.assertFalse(is_primary(event_policy('Esports Nations Cup 2027')['classification']))
        self.assertFalse(is_primary(event_policy('Esports World Cup 2027')['classification']))

    def test_masters_qualifier_is_not_primary_international(self):
        value=event_policy('Valorant Masters Seoul 2027: China Qualifier')
        self.assertEqual(value['classification'],'qualification')
        self.assertFalse(is_primary(value['classification']))

    def test_historical_classifier_not_expanded(self):
        self.assertFalse(classify_event('VCT 2026: China Ascension')[0])


class IndexTests(unittest.TestCase):
    def test_five_all_tier_indexes_yearless_and_future_retained(self):
        client=IndexClient({
            '/events/?region=all&tier=all':card(1,'Valorant Masters Seoul 2027')+card(2,'VCT 2025: China Kickoff','completed',dates='Jan 1–10'),
            '/events/?region=24&tier=all':card(3,'FGC 2026')+card(4,'VCT 2027: China Kickoff Open Qualifier'),
            '/events/?region=27&tier=all':card(5,'VCT 2027: EMEA Cup 1'),
            '/events/?region=26&tier=all':card(6,'VCT 2027: Americas Kickoff Open Qualifier'),
            '/events/?region=28&tier=all':card(7,'Challengers League'),
        })
        try:
            events=client.discover_live_events(datetime(2026,10,19,tzinfo=timezone.utc))
            self.assertEqual(len(client.requested),5)
            self.assertTrue(all('tier=all' in p and 'page=' not in p for p in client.requested))
            self.assertEqual(set(client.discovery_report['regions_checked']),{'CN','EMEA','AMERICAS','PACIFIC'})
            self.assertTrue(client.discovery_report['indexes_complete'])
            lookup={e['external_event_id']:e for e in events}
            self.assertTrue(lookup['1']['scan_matches'])
            self.assertTrue(lookup['4']['scan_matches'])
            self.assertFalse(lookup['2']['scan_matches'])
            self.assertEqual(lookup['3']['region'],'CN')
            self.assertEqual(lookup['7']['region'],'PACIFIC')
        finally:
            client.close()

    def test_partial_index_failure_is_visible(self):
        client=IndexClient({'/events/?region=24&tier=all':RuntimeError('test source unavailable')})
        try:
            client.discover_live_events(datetime(2026,10,19,tzinfo=timezone.utc))
            self.assertFalse(client.discovery_report['indexes_complete'])
            self.assertEqual(client.discovery_report['index_failures'][0]['region'],'CN')
        finally:
            client.close()

    def test_empty_region_calendar_is_not_fake_fixture(self):
        client=IndexClient({})
        try:
            self.assertEqual(client.discover_live_events(datetime(2026,10,19,tzinfo=timezone.utc)),[])
        finally:
            client.close()

    def test_recent_completed_final_retained(self):
        now=datetime(2026,10,19,tzinfo=timezone.utc)
        self.assertTrue(VlrClient._recent_completed_event('Sep 24–Oct 18 Dates',2026,now))
        self.assertTrue(VlrClient._recent_completed_event('Oct 17–19 Dates',2026,now))
        self.assertFalse(VlrClient._recent_completed_event('Aug 1–20 Dates',2026,now))

    def test_response_cache_is_live_only_and_avoids_double_fetch(self):
        import httpx
        calls=[]
        with tempfile.TemporaryDirectory() as folder:
            client=VlrClient(folder,delay_seconds=0)
            client.client.close()
            client.client=httpx.Client(transport=httpx.MockTransport(lambda request:(calls.append(str(request.url)) or httpx.Response(200,text='<html/>'))))
            try:
                self.assertFalse(client._cache_responses)
                client.fetch('/legacy')
                client.fetch('/legacy')
                self.assertEqual(len(calls),2)
                client._cache_responses=True
                client.fetch('/live')
                client.fetch('/live')
                self.assertEqual(len(calls),3)
            finally:
                client.close()


class EligibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.db=Database(Path(self.temp.name)/'isolated.sqlite3')
        self.db.initialize()
        with self.db.connect() as conn:
            conn.execute("INSERT INTO data_sources(source_id,name,base_url,source_type,authority_level,enabled,created_at,updated_at) VALUES('vlr','VLR','https://www.vlr.gg','community','secondary',1,'2026-09-03T00:00:00Z','2026-09-03T00:00:00Z')")
            for team in ('a','b'):
                conn.execute("INSERT INTO teams(team_id,name,region,matches_played,updated_at) VALUES(?,?,'CN',5,'2026-09-03T00:00:00Z')",(team,team))
            conn.execute("""INSERT INTO fixtures(fixture_id,source_id,external_match_id,external_event_id,event,region,classification,
                scheduled_at,series_format,patch_provenance,team_a_id,team_b_id,team_a_name,team_b_name,map_pool_json,
                map_pool_provenance,source_url,content_hash,fetched_at,status,quality_status,blocker_json,created_at,updated_at)
                VALUES('f1','vlr','1','event','Test','CN','regional','2026-09-04T00:00:00Z','bo3','unavailable',
                'a','b','a','b','["ascent","bind","haven"]','observed','https://example.test/1','hash',
                '2026-09-03T00:00:00Z','scheduled','ready','[]','2026-09-03T00:00:00Z','2026-09-03T00:00:00Z')""")
        self.fixture={'fixture_id':'f1','external_match_id':'1','source_id':'vlr','scheduled_at':'2026-09-04T00:00:00Z',
            'fetched_at':'2026-09-03T00:00:00Z','event':'Test','region':'CN','classification':'regional','stage':None,
            'series_format':'bo3','patch':None,'patch_provenance':'unavailable','team_a_id':'a','team_b_id':'b',
            'map_pool':['ascent','bind','haven'],'map_pool_provenance':'observed','source_url':'https://example.test/1',
            'content_hash':'hash','raw_path':None}

    def tearDown(self):
        self.temp.cleanup()

    def test_secondary_with_good_data_may_predict_but_not_primary_training(self):
        self.fixture['classification']='secondary'
        now=datetime(2026,9,3,12,tzinfo=timezone.utc)
        self.assertEqual(_quality(self.db,self.fixture,now),('ready',[]))
        with self.db.connect() as conn:
            conn.execute("UPDATE fixtures SET classification='secondary' WHERE fixture_id='f1'")
        _record_prospective_snapshot(self.db,self.fixture,'ready',[],now)
        with self.db.connect() as conn:
            conn.execute("UPDATE prospective_snapshots SET outcome_status='resolved'")
        self.assertEqual(_prospective_stats(self.db)['gold_training_eligible'],0)
        with self.db.connect() as conn:
            self.assertEqual(state_payload(conn,[])['learning']['trainingEligible'],0)

    def test_secondary_real_pair_frozen_but_not_c1_gate(self):
        self.fixture['classification']='secondary'
        now=datetime(2026,9,3,12,tzinfo=timezone.utc)
        with self.db.connect() as conn:
            conn.execute("UPDATE fixtures SET classification='secondary' WHERE fixture_id='f1'")
        _record_prospective_snapshot(self.db,self.fixture,'ready',[],now)
        result=_lock_ready_predictions(self.db,now,48)
        self.assertEqual(result['predictions_locked'],1,result)
        self.assertEqual(result['challenger_predictions_frozen'],1,result)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT eligible FROM challenger_predictions').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT source FROM predictions').fetchone()[0],'system_auto_secondary')

    def test_primary_gate_unchanged(self):
        _record_prospective_snapshot(self.db,self.fixture,'ready',[],datetime(2026,9,3,tzinfo=timezone.utc))
        with self.db.connect() as conn:
            conn.execute("UPDATE prospective_snapshots SET outcome_status='resolved'")
        self.assertEqual(_prospective_stats(self.db)['gold_training_eligible'],1)

    def test_insufficient_history_still_blocks(self):
        self.fixture['classification']='invitational'
        with self.db.connect() as conn:
            conn.execute("UPDATE teams SET matches_played=2 WHERE team_id='a'")
        state,reasons=_quality(self.db,self.fixture,datetime(2026,9,3,tzinfo=timezone.utc))
        self.assertEqual(state,'blocked')
        self.assertIn('team_history_below_three_series',reasons)

    def test_map_and_format_gates_unchanged(self):
        self.fixture['classification']='qualification'
        self.fixture['map_pool']=[]
        self.fixture['series_format']='bo1'
        state,reasons=_quality(self.db,self.fixture,datetime(2026,9,3,tzinfo=timezone.utc))
        self.assertEqual(state,'blocked')
        self.assertIn('unsupported_series_format',reasons)

    def test_unknown_region_or_exhibition_blocked(self):
        for kind,region in (('exhibition','CN'),('invitational','OTHER'),('unclassified','CN')):
            self.fixture.update(classification=kind,region=region)
            self.assertEqual(_quality(self.db,self.fixture,datetime(2026,9,3,tzinfo=timezone.utc))[0],'blocked')

    def test_watch_does_not_fabricate_fixture_or_gold(self):
        event={'external_event_id':'700','name':'Unknown Event','region':'CN','classification':'unclassified','included':False,
               'scan_matches':True,'status':'upcoming','source_url':'https://www.vlr.gg/event/700/event',
               'fetched_at':'2026-09-03T00:00:00Z'}
        class WatchClient:
            retry_count=0
            retry_log=[]
            discovery_report={'indexes_complete':True,'index_failures':[]}
            link_observations={}
            def discover_live_events(self,now): return [event]
            def event_match_links(self,value): return ['/900/tbd/'],FetchResult('https://www.vlr.gg/event/matches/700/event','',event['fetched_at'],'hash','synthetic')
            def parse_fixture(self,*args): raise AssertionError('observe-only competition must not fetch detail')
            def close(self): pass
        with self.db.connect() as conn:
            conn.execute('DELETE FROM fixtures')
        with patch('vct_prediction.automation.VlrClient',return_value=WatchClient()):
            result=run_daily_automation(self.db,Path(self.temp.name)/'raw',now=datetime(2026,9,3,tzinfo=timezone.utc))
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['fixtures_observed_only'],1)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM fixtures').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM prospective_snapshots').fetchone()[0],0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM source_records WHERE entity_type='fixture_watch'").fetchone()[0],1)

    def test_region_detail_budget_does_not_starve_other_regions(self):
        calls=[]
        regions=('CN','EMEA','AMERICAS','PACIFIC','INTERNATIONAL')
        events=[{'external_event_id':str(i),'name':'Test '+r,'region':r,'classification':'regional' if r!='INTERNATIONAL' else 'international',
                 'included':True,'scan_matches':True,'status':'upcoming','source_url':'https://example.test/event/'+str(i),
                 'fetched_at':'2026-09-03T00:00:00Z'} for i,r in enumerate(regions,1)]
        class BudgetClient:
            retry_count=0
            retry_log=[]
            discovery_report={'indexes_complete':True,'index_failures':[]}
            link_observations={}
            def discover_live_events(self,now): return events
            def event_match_links(self,event):
                return [f"/{event['external_event_id']}{i:03d}/test/" for i in range(30)],FetchResult('https://example.test/event','',event['fetched_at'],'hash','synthetic')
            def parse_fixture(self,href,event):
                calls.append(event['region'])
                return None,{'reason':'scheduled_at_missing','source_url':'https://www.vlr.gg'+href,
                    'content_hash':'hash','fetched_at':'2026-09-03T00:00:00Z','raw_path':'synthetic'}
            def close(self): pass
        with self.db.connect() as conn:
            conn.execute('DELETE FROM fixtures')
        with patch('vct_prediction.automation.VlrClient',return_value=BudgetClient()):
            result=run_daily_automation(self.db,Path(self.temp.name)/'raw',now=datetime(2026,9,3,tzinfo=timezone.utc))
        self.assertEqual({r:calls.count(r) for r in regions},{r:24 for r in regions})
        self.assertEqual(result['detail_budget_deferred'],30)
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'],'partial')

    def test_unobserved_old_secondary_result_does_not_consume_detail_budget(self):
        event={'external_event_id':'701','name':'Challengers','region':'PACIFIC','classification':'secondary','included':True,
               'scan_matches':True,'status':'ongoing','source_url':'https://example.test/event/701','fetched_at':'2026-09-03T00:00:00Z'}
        class PastClient:
            retry_count=0
            retry_log=[]
            discovery_report={'indexes_complete':True,'index_failures':[]}
            link_observations={'/900/past/':{'source_status':'completed','source_url':'https://example.test/900',
                'content_hash':'hash','fetched_at':'2026-09-03T00:00:00Z','raw_path':'synthetic'}}
            def discover_live_events(self,now): return [event]
            def event_match_links(self,event): return ['/900/past/'],FetchResult('https://example.test/event','',event['fetched_at'],'hash','synthetic')
            def parse_fixture(self,*args): raise AssertionError('must not backfill past secondary match')
            def close(self): pass
        with self.db.connect() as conn:
            conn.execute('DELETE FROM fixtures')
        with patch('vct_prediction.automation.VlrClient',return_value=PastClient()):
            result=run_daily_automation(self.db,Path(self.temp.name)/'raw',now=datetime(2026,9,3,tzinfo=timezone.utc))
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['fixture_detail_reads'],0)
        self.assertEqual(result['results_inserted'],0)


if __name__=='__main__': unittest.main()
