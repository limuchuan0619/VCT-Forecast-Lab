from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from vct_prediction.automation import observe_result_candidate
from vct_prediction.db import Database


def result(last_score: tuple[int, int] = (14, 12)) -> dict:
    maps = [(7, 13), (13, 11), (14, 12), (1, 13), last_score]
    return {
        "external_match_id": "734308", "series_format": "bo5",
        "team_a_id": "vlr_team_120", "team_b_id": "vlr_team_6961",
        "winner_id": "vlr_team_120" if last_score[0] > last_score[1] else "vlr_team_6961",
        "team_a_maps": 3 if last_score[0] > last_score[1] else 2,
        "team_b_maps": 2 if last_score[0] > last_score[1] else 3,
        "maps": [
            {"map_order": index, "map": f"map_{index}", "team_a_rounds": scores[0], "team_b_rounds": scores[1]}
            for index, scores in enumerate(maps, start=1)
        ],
    }


class ResultFinalityTests(unittest.TestCase):
    def test_second_identical_observation_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            db = Database(Path(temporary) / "test.sqlite3")
            db.initialize()
            self.assertEqual(observe_result_candidate(db, result(), "2026-09-06T04:00:00Z"), (False, "REVISION_PENDING"))
            self.assertEqual(observe_result_candidate(db, result(), "2026-09-06T04:02:00Z"), (True, "FINAL_CONFIRMED"))

    def test_changed_candidate_is_versioned_and_quarantined_before_reconfirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            db = Database(Path(temporary) / "test.sqlite3")
            db.initialize()
            observe_result_candidate(db, result((5, 7)), "2026-09-06T04:00:00Z")
            self.assertEqual(observe_result_candidate(db, result((14, 12)), "2026-09-06T04:02:00Z"), (False, "RESULT_INCONSISTENT"))
            self.assertEqual(observe_result_candidate(db, result((14, 12)), "2026-09-06T04:04:00Z"), (True, "FINAL_CONFIRMED"))
            with db.connect() as connection:
                candidate = connection.execute("SELECT * FROM result_candidates WHERE external_match_id='734308'").fetchone()
                revisions = connection.execute("SELECT * FROM result_candidate_revisions WHERE external_match_id='734308'").fetchall()
            self.assertEqual(candidate["status"], "FINAL_CONFIRMED")
            self.assertEqual(candidate["revision_no"], 2)
            self.assertEqual(len(revisions), 1)
            self.assertEqual(revisions[0]["reason"], "SOURCE_RESULT_REVISED")


if __name__ == "__main__":
    unittest.main()
