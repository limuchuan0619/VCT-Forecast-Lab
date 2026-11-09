"""Evaluate saved prospective pairs only; no fit, database writes or collection."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from vct_prediction.cohort_evaluation import evaluate_cohorts

parser=argparse.ArgumentParser()
parser.add_argument('--database',type=Path,required=True)
parser.add_argument('--output',type=Path)
args=parser.parse_args()
c=sqlite3.connect(args.database.resolve().as_uri()+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
try:
    result=evaluate_cohorts(c,bootstrap_samples=2000)
finally:
    c.close()
text=json.dumps(result,ensure_ascii=False,indent=2)
if args.output:
    with args.output.open('x',encoding='utf-8') as stream: stream.write(text+'\n')
print(text)
