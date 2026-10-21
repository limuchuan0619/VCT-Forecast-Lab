import json
import sqlite3
import unittest
from bridge.vct_public_bridge import prematch_reader_context


class PrematchReaderContextTests(unittest.TestCase):
    def fixture(self):
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
        db.executescript('''CREATE TABLE teams(team_id TEXT,name TEXT);
          CREATE TABLE matches(match_id TEXT,team_a_id TEXT,team_b_id TEXT,team_a_maps INT,team_b_maps INT,played_at TEXT,inserted_at TEXT,processed INT);
          CREATE TABLE source_records(canonical_id TEXT,source_id TEXT,entity_type TEXT,fetched_at TEXT,source_url TEXT);
          INSERT INTO teams VALUES('a','A'),('b','B'),('c','C');''')
        for mid,played,inserted,source in [('1','2026-10-14','2026-10-15','2026-10-15'),('2','2026-10-17','2026-10-17','2026-10-17'),
                                         ('3','2026-10-14','2026-10-18','2026-10-15'),('4','2026-10-14','2026-10-15','2026-10-18')]:
            db.execute('INSERT INTO matches VALUES(?,?,?,?,?,?,?,1)',('vlr_match_'+mid,'a','c',2,1,played+'T00:00:00Z',inserted+'T00:00:00Z'))
            db.execute('INSERT INTO source_records VALUES(?,\'vlr\',\'match\',?,?)',('vlr_match_'+mid,source+'T00:00:00Z','https://www.vlr.gg/'+mid+'/example'))
        row={'status':'locked','locked_at':'2026-10-17T00:00:00Z','team_a_id':'a','team_b_id':'b','team_a_name':'A','team_b_name':'B',
             'factor_snapshot_json':json.dumps({'recent_form':{'team_a':{'components':[{'match_id':'vlr_match_'+str(i)} for i in range(1,5)]}}})}
        return db,row

    def test_only_frozen_ids_with_exclusive_played_inserted_and_source_times_are_exported(self):
        db,row=self.fixture();before=json.dumps(row);changes=db.total_changes
        result=prematch_reader_context(db,row)
        self.assertEqual([m['matchId'] for m in result['recentMatches']],['vlr_match_1'])
        self.assertEqual(result['recentMatches'][0]['reference'],'history:team_a:vlr_match_1')
        self.assertEqual(json.dumps(row),before);self.assertEqual(db.total_changes,changes);db.close()

    def test_results_missing_schema_or_unseen_histories_do_not_block_sync(self):
        db,row=self.fixture();row['status']='resolved';self.assertIsNone(prematch_reader_context(db,row))
        row['status']='locked';row['factor_snapshot_json']='{}';self.assertIsNone(prematch_reader_context(db,row))
        db.close();broken=sqlite3.connect(':memory:');row['factor_snapshot_json']=json.dumps({'recent_form':{'team_a':{'components':[{'match_id':'vlr_match_1'}]}}})
        self.assertIsNone(prematch_reader_context(broken,row));broken.close()
