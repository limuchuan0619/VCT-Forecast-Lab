from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from vct_prediction.archive_export import export_batch
from vct_prediction.db import Database
from vct_prediction.evidence import EvidenceLedger, canonical
from vct_prediction.history_preparation import protected_digest
from vct_prediction.local_archive import LocalArchive, run_sync
from vct_prediction.sources.vlr import FetchResult,VlrClient

TIME='2026-10-20T10:00:00+00:00'
EVENT={'external_event_id':'1','name':'Isolated CN qualifier','region':'CN','classification':'qualification'}
PARTIAL='''<a class="match-header-link" href="/team/1/a">A</a><a class="match-header-link" href="/team/2/b">B</a>
<span data-utc-ts="2026-10-19 08:00:00"></span><div class="match-header-vs-score"><div class="sp-hide">2 : 1</div>Bo3</div>
<div class="match-header-vs-note">final</div>'''


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.ledger=EvidenceLedger(self.root/'evidence.sqlite3',reserve_bytes=0)

    def tearDown(self):
        self.temp.cleanup()

    def append(self,value=1,at=TIME):
        return self.ledger.append('match_source','1',{'score':value},observed_at=at)

    def test_identical_facts_deduplicate_but_reversion_is_preserved(self):
        self.assertTrue(self.append(1))
        self.assertFalse(self.append(1,'2026-10-20T11:00:00Z'))
        self.append(2)
        self.append(1)
        with self.ledger.connect() as c:
            rows=c.execute('SELECT * FROM observations ORDER BY seq').fetchall()
        self.assertEqual(len(rows),3)
        self.assertEqual(rows[1]['previous_id'],rows[0]['evidence_id'])
        self.assertEqual(rows[2]['previous_id'],rows[1]['evidence_id'])
        self.assertEqual(rows[0]['observed_at'],TIME)
        self.assertNotEqual(rows[0]['archived_at'],TIME)

    def test_team_listing_perspectives_do_not_create_false_revisions(self):
        client=VlrClient(self.root/'raw',delay_seconds=0)
        page=FetchResult('https://www.vlr.gg/team/1/a','<a class="m-item" href="/7/past"><div class="m-item-result">2:1</div>A vs B</a>',TIME,'hash','unused')
        try:
            soup=client.soup(page)
            self.ledger.observe_team_page(page,soup,'1')
            self.ledger.observe_team_page(page,soup,'2')
            self.ledger.observe_team_page(page,soup,'1')
        finally:
            client.close()
        self.assertEqual(self.ledger.summary()['records'],2)

    def test_partial_score_preserved_without_passing_formal_finality(self):
        client=VlrClient(self.root/'raw',delay_seconds=0)
        client.evidence_store=self.ledger
        client.fetch=lambda path:FetchResult('https://www.vlr.gg/1/example',PARTIAL,TIME,'hash','unused')
        try:
            record,issue=client.parse_match('/1/example',EVENT)
        finally:
            client.close()
        self.assertIsNone(record)
        self.assertEqual(issue['reason'],'map_evidence_missing')
        with self.ledger.connect() as c:
            row=c.execute('SELECT * FROM observations').fetchone()
        facts=json.loads(row['payload_json'])
        self.assertEqual(facts['source_series_score'],[2,1])
        self.assertEqual(facts['maps'],[])
        self.assertIn('maps',facts['missing_fields'])
        self.assertEqual(facts['authority'],'SOURCE_OBSERVED_NOT_FORMAL')
        self.assertEqual(row['observed_at'],TIME)

    def test_incomplete_map_and_missing_statistics_are_not_zero_or_final(self):
        body=PARTIAL+'''<div class="vm-stats-game" data-game-id="10"><div class="vm-stats-game-header">
            <div class="map">Bind</div><div class="team"><div class="score">5</div></div>
            <div class="team"><div class="score">7</div></div></div>
            <table class="ovw-table"><tr class="ovw-row"><th>header</th></tr><tr class="ovw-row"><td><a href="/player/7/a">Player</a></td>
            <td data-col="adr"><span class="side mod-both">-</span></td></tr></table></div>'''
        client=VlrClient(self.root/'raw',delay_seconds=0)
        client.evidence_store=self.ledger
        client.fetch=lambda path:FetchResult('https://www.vlr.gg/1/example',body,TIME,'hash','unused')
        try:
            record,issue=client.parse_match('/1/example',EVENT)
        finally:
            client.close()
        self.assertIsNone(record)
        self.assertEqual(issue['reason'],'incomplete_map_score')
        with self.ledger.connect() as c:
            data=json.loads(c.execute('SELECT payload_json FROM observations').fetchone()[0])
        self.assertEqual(data['maps'][0]['score'],[5,7])
        self.assertEqual(data['maps'][0]['map_name_zh'],'源工重镇')
        self.assertIsNone(data['maps'][0]['players'][0]['source_statistics']['adr'])

    def test_failed_journal_does_not_change_formal_parse_outcome(self):
        client=VlrClient(self.root/'raw',delay_seconds=0)
        client.evidence_store=self.ledger
        client.fetch=lambda path:FetchResult('https://www.vlr.gg/1/example',PARTIAL,TIME,'hash','unused')
        try:
            with patch.object(self.ledger,'observe_match',side_effect=OSError('isolated storage failure')):
                record,issue=client.parse_match('/1/example',EVENT)
        finally:
            client.close()
        self.assertIsNone(record)
        self.assertEqual(issue['reason'],'map_evidence_missing')
        self.assertEqual(self.ledger.summary()['status'],'DEGRADED')

    def test_disk_reserve_never_prunes_existing_evidence(self):
        self.append()
        self.ledger.reserve_bytes=10**30
        self.assertFalse(self.ledger.safe_append('match_source','2',{},observed_at=TIME))
        self.assertEqual(self.ledger.summary()['records'],1)
        self.assertEqual(self.ledger.summary()['status'],'DEGRADED')

    def test_cached_team_scores_preserved_without_network_or_fabricated_map(self):
        from vct_prediction.readiness import PreparedVlrClient,ReadinessStore
        from datetime import datetime,timezone
        store=ReadinessStore(self.root/'cache.sqlite3')
        page={'url':'https://www.vlr.gg/team/1/a','text':'<h1>A</h1><a class="m-item" href="/7/past"><div class="m-item-result">2:1</div>A vs B National Tournament</a>',
              'content_hash':'source-hash','fetched_at':TIME}
        store.cache(page['url'],page,0,1)
        client=PreparedVlrClient(self.root/'raw',store,now=datetime.now(timezone.utc))
        try:
            with patch.object(client.client,'get',side_effect=AssertionError('no network allowed')):
                self.ledger.bootstrap_cached_teams(client)
                self.ledger.bootstrap_cached_teams(client)
        finally:
            client.close()
        with self.ledger.connect() as c:
            rows=c.execute("SELECT * FROM observations WHERE kind='team_result_listing'").fetchall()
        self.assertEqual(len(rows),1)
        facts=json.loads(rows[0]['payload_json'])
        self.assertEqual(facts['source_series_score'],[2,1])
        self.assertIsNone(facts['maps'])
        self.assertNotIn('winner_id',facts)
        self.assertEqual(rows[0]['observed_at'],TIME)

    def test_copying_existing_main_rows_does_not_mutate_main_or_create_predictions(self):
        db=Database(self.root/'main.sqlite3')
        db.initialize()
        before=hashlib.sha256(db.path.read_bytes()).hexdigest()
        with db.connect() as c:
            frozen=protected_digest(c)
        self.ledger.sync_main_records(db)
        self.assertEqual(hashlib.sha256(db.path.read_bytes()).hexdigest(),before)
        with db.connect() as c:
            self.assertEqual(protected_digest(c),frozen)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM predictions').fetchone()[0],0)

    def test_snapshot_copy_keeps_prematch_and_result_labels_separate(self):
        from test_competition_coverage import EligibilityTests
        from vct_prediction.automation import _record_prospective_snapshot
        from datetime import datetime,timezone
        fixture=EligibilityTests()
        fixture.setUp()
        try:
            _record_prospective_snapshot(fixture.db,fixture.fixture,'blocked',['isolated_missing'],
                datetime(2026,9,3,tzinfo=timezone.utc))
            self.ledger.sync_main_records(fixture.db)
            with fixture.db.connect() as c:
                c.execute("UPDATE prospective_snapshots SET outcome_status='resolved'")
            self.ledger.sync_main_records(fixture.db)
            with self.ledger.connect() as c:
                rows=c.execute("SELECT * FROM observations WHERE kind='prematch_snapshot'").fetchall()
            self.assertEqual(len(rows),1)
            data=json.loads(rows[0]['payload_json'])
            self.assertNotIn('outcome_status',data)
            self.assertNotIn('resolved_match_id',data)
            self.assertEqual(data['observed_at'],fixture.fixture['fetched_at'])
        finally:
            fixture.tearDown()


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.cloud=EvidenceLedger(self.root/'cloud.sqlite3',reserve_bytes=0)
        self.local=LocalArchive(self.root/'local')
        for i in range(5):
            self.cloud.append('match_source',str(i),{'value':i,'missing':None},observed_at=TIME)

    def tearDown(self):
        self.temp.cleanup()

    def test_incremental_export_resume_and_local_verification(self):
        before=hashlib.sha256(self.cloud.path.read_bytes()).hexdigest()
        first=self.local.accept(export_batch(self.cloud.path,limit=2))
        self.assertEqual(first['records'],2)
        self.assertTrue(first['has_more'])
        second=self.local.accept(export_batch(self.cloud.path,after=2,limit=2))
        third=self.local.accept(export_batch(self.cloud.path,after=4,limit=2))
        self.assertFalse(third['has_more'])
        self.assertEqual(self.local.verify()['records'],5)
        self.assertEqual(hashlib.sha256(self.cloud.path.read_bytes()).hexdigest(),before)
        self.assertEqual(self.cloud.summary()['records'],5)

    def test_repeated_batch_does_not_duplicate_or_advance_cursor(self):
        blob=export_batch(self.cloud.path,limit=2)
        self.local.accept(blob)
        with self.assertRaisesRegex(ValueError,'cursor_mismatch'):
            self.local.accept(blob)
        self.assertEqual(self.local.verify()['records'],2)

    def test_corrupted_fact_fails_before_cursor_commit(self):
        data=json.loads(gzip.decompress(export_batch(self.cloud.path)))
        data['rows'][0]['payload_json']=canonical({'value':'tampered'})
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):
            self.local.accept(gzip.compress(canonical(data).encode()))
        self.assertEqual(self.local.position()[1],0)
        self.assertEqual(self.local.verify()['files'],0)

    def test_failed_local_write_does_not_advance_or_delete_cloud(self):
        with patch('vct_prediction.local_archive.os.replace',side_effect=OSError('isolated full local disk')):
            with self.assertRaises(OSError):
                self.local.accept(export_batch(self.cloud.path))
        self.assertEqual(self.local.position()[1],0)
        self.assertEqual(self.cloud.summary()['records'],5)

    def test_cloud_stream_identity_change_requires_review(self):
        self.local.accept(export_batch(self.cloud.path,limit=2))
        other=EvidenceLedger(self.root/'different.sqlite3',reserve_bytes=0)
        for i in range(3):
            other.append('match_source',str(i),{'value':i},observed_at=TIME)
        with self.assertRaisesRegex(ValueError,'stream_changed'):
            self.local.accept(export_batch(other.path,after=2))
        self.assertEqual(self.local.position()[1],2)

    def test_sequence_gap_cannot_be_acknowledged(self):
        data=json.loads(gzip.decompress(export_batch(self.cloud.path)))
        data['rows'].pop(0)
        with self.assertRaisesRegex(ValueError,'sequence_gap'):
            self.local.accept(gzip.compress(canonical(data).encode()))

    def test_download_transport_failure_keeps_cursor_and_cloud_unchanged(self):
        settings=self.root/'settings.json'
        settings.write_text(json.dumps({'archive_root':str(self.local.root)}))
        with patch('vct_prediction.local_archive.ssh_export',side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                run_sync(settings)
        self.assertEqual(self.local.position()[1],0)
        self.assertEqual(self.cloud.summary()['records'],5)

    def test_modified_archive_file_is_detected_on_verify(self):
        self.local.accept(export_batch(self.cloud.path))
        file=next(self.local.files.glob('*.json.gz'))
        file.write_bytes(b'isolated corruption')
        with self.assertRaisesRegex(ValueError,'file_hash_mismatch'):
            self.local.verify()

    def test_export_bounds_and_cursor_are_checked(self):
        for after,limit in ((-1,10),(0,501),(10,5)):
            with self.assertRaises(ValueError):
                export_batch(self.cloud.path,after=after,limit=limit)


if __name__=='__main__':
    unittest.main()
