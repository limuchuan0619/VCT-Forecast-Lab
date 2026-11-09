import json
import unittest
from pathlib import Path

import test_shadow_challenger as fixture_module
from vct_prediction.cohort_evaluation import evaluate_cohorts
from vct_prediction.evidence import EvidenceLedger
from vct_prediction.settlement_checks import comparison_issue, quarantined_results, reconcile_confirmed_results
from vct_prediction.shadow import settle_shadow_predictions, prospective_metrics
from bridge.vct_public_bridge import synchronize


class SettlementRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.case=fixture_module.ShadowChallengerTests('test_frozen_artifact_loads_without_training_api')
        self.case.setUp()
        self.db=self.case.db

    def tearDown(self): self.case.tearDown()

    def prepare(self, *, qualification=False):
        if qualification:
            self.case.fixture['classification']='qualification'
            with self.db.connect() as c:
                c.execute("UPDATE predictions SET source='system_auto_qualification'")
        self.case._resolve_pair()
        facts={'external_match_id':'100','series_format':'bo3','team_a_id':'team-a','team_b_id':'team-b',
            'winner_id':'team-a','team_a_maps':2,'team_b_maps':0,'maps':[
                {'map_order':1,'map':'lotus','team_a_rounds':13,'team_b_rounds':7},
                {'map_order':2,'map':'bind','team_a_rounds':13,'team_b_rounds':8}]}
        with self.db.connect() as c:
            c.execute("UPDATE predictions SET status='locked',actual_winner_id=NULL,actual_score=NULL,resolved_match_id=NULL")
            c.execute("UPDATE fixtures SET completed_match_id='result-1',status='completed'")
            for m in facts['maps']:
                c.execute('INSERT INTO map_results(match_id,map_order,map_id,team_a_rounds,team_b_rounds) VALUES(?,?,?,?,?)',
                    ('result-1',m['map_order'],m['map'],m['team_a_rounds'],m['team_b_rounds']))
            c.execute("INSERT INTO result_candidates VALUES('vlr','100','hash',?,'2026-09-04T02:00:00Z','2026-09-04T02:10:00Z',2,'FINAL_CONFIRMED',NULL,1)",(json.dumps(facts),))
        return facts

    def test_recovery_is_idempotent_and_never_updates_rating_or_freeze(self):
        self.prepare()
        with self.db.connect() as c:
            before=dict(c.execute('SELECT * FROM predictions').fetchone())
            teams=[dict(r) for r in c.execute('SELECT * FROM teams ORDER BY team_id')]
        result=reconcile_confirmed_results(self.db)
        self.assertEqual(result['settlements_recovered'],1)
        self.assertEqual(reconcile_confirmed_results(self.db)['settlements_recovered'],0)
        self.assertEqual(settle_shadow_predictions(self.db)['challenger_settled'],1)
        with self.db.connect() as c:
            after=dict(c.execute('SELECT * FROM predictions').fetchone())
            self.assertEqual(teams,[dict(r) for r in c.execute('SELECT * FROM teams ORDER BY team_id')])
            self.assertEqual(c.execute('SELECT COUNT(*) FROM rating_history').fetchone()[0],0)
        for key in set(before)-{'status','actual_score','actual_winner_id','resolved_match_id'}:
            self.assertEqual(before[key],after[key],key)

    def test_recovery_requires_second_confirmation(self):
        self.prepare()
        with self.db.connect() as c: c.execute('UPDATE result_candidates SET confirmation_count=1')
        self.assertEqual(reconcile_confirmed_results(self.db)['settlements_recovered'],0)

    def test_conflicting_source_ids_cannot_recover(self):
        facts=self.prepare(); facts['team_a_id']='another-team'
        with self.db.connect() as c: c.execute('UPDATE result_candidates SET candidate_json=?',(json.dumps(facts),))
        self.assertEqual(reconcile_confirmed_results(self.db)['blocked'][0]['reason'],'source_canonical_result_conflict')

    def test_target_map_and_source_must_both_be_terminal(self):
        facts=self.prepare(); facts['maps'][1]['team_a_rounds']=5; facts['maps'][1]['team_b_rounds']=7
        with self.db.connect() as c:
            c.execute('UPDATE result_candidates SET candidate_json=?',(json.dumps(facts),))
            c.execute("UPDATE map_results SET team_a_rounds=5,team_b_rounds=7 WHERE map_order=2")
        self.assertEqual(reconcile_confirmed_results(self.db)['blocked'][0]['reason'],'incomplete_map_score')

    def test_after_actual_start_is_not_recovered(self):
        self.prepare()
        with self.db.connect() as c: c.execute("UPDATE matches SET played_at='2026-09-03T11:00:00Z'")
        self.assertEqual(reconcile_confirmed_results(self.db)['blocked'][0]['reason'],'prediction_not_before_actual_match')

    def test_qualification_gets_separate_metrics_not_primary_gate(self):
        self.prepare(qualification=True)
        reconcile_confirmed_results(self.db);settle_shadow_predictions(self.db)
        self.assertEqual(prospective_metrics(self.db)['eligible_resolved_matches'],0)
        with self.db.connect() as c: report=evaluate_cohorts(c,model=fixture_module.FrozenLogisticC1(fixture_module.ARTIFACT),bootstrap_samples=20)
        self.assertEqual(report['valid_resolved_matches'],1)
        self.assertEqual(report['cohorts'][0]['cohort'],'qualification:CN')
        self.assertEqual(report['cohorts'][0]['primary_gate_contribution'],0)

    def test_legacy_bo3_vs_bo5_is_preserved_quarantined_and_not_posted(self):
        self.prepare()
        with self.db.connect() as c:
            c.execute("UPDATE predictions SET status='resolved',actual_winner_id='team-b',actual_score='2-3',resolved_match_id='result-1'")
            c.execute("UPDATE matches SET series_format='bo5',team_a_maps=2,team_b_maps=3,winner_id='team-b'")
        self.assertEqual(settle_shadow_predictions(self.db)['challenger_settled'],0)
        calls=[]
        def poster(base,path,key,payload,**kwargs): calls.append((path,payload));return {'accepted':True}
        with self.db.connect() as c:
            before=dict(c.execute('SELECT * FROM predictions').fetchone())
            report=synchronize(c,base_url='https://example.test',key='test-only',source='system',limit=None,ai_timeout=30,poster=poster)
            self.assertEqual(before,dict(c.execute('SELECT * FROM predictions').fetchone()))
        self.assertEqual(report['counters']['results']['quarantined'],1)
        self.assertEqual(report['counters']['results']['failed'],0)
        self.assertEqual(report['status'],'SUCCESS')
        self.assertFalse(any(p=='/api/automation/results' for p,body in calls))
        state=next(body for p,body in calls if p=='/api/automation/state')
        self.assertEqual(len(state['resultQuarantines']),1)
        ledger=EvidenceLedger(Path(self.case.temporary.name)/'evidence.sqlite3',reserve_bytes=0)
        ledger.sync_main_records(self.db);ledger.sync_main_records(self.db)
        with ledger.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM observations WHERE kind='result_quarantine'").fetchone()[0],1)

    def test_legal_and_illegal_series_scores(self):
        for fmt,scores in [('bo3',['2-0','0-2','2-1','1-2']),('bo5',['3-0','0-3','3-1','1-3','3-2','2-3'])]:
            for score in scores: self.assertIsNone(comparison_issue(fmt,fmt,score))
        for score in ('2-2','1-0','2-3','a-b'):
            self.assertIsNotNone(comparison_issue('bo3','bo3',score))

if __name__=='__main__': unittest.main()
