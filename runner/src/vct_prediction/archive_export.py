"""Authenticated SSH-only bounded read-only journal export. No HTTP endpoint."""
from __future__ import annotations

import argparse
import gzip
import json
import os
from pathlib import Path
import sqlite3
import sys

from .evidence import VERSION, canonical, utcnow


def export_batch(path, *, after=0, limit=250):
    if after < 0 or not 1 <= limit <= 500:
        raise ValueError('invalid_archive_bounds')
    c = sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
    c.row_factory = sqlite3.Row
    try:
        c.execute('BEGIN')
        stream = c.execute("SELECT value FROM journal_meta WHERE key='stream_id'").fetchone()[0]
        maximum = c.execute('SELECT COALESCE(MAX(seq),0) FROM observations').fetchone()[0]
        if after > maximum:
            raise ValueError('archive_cursor_ahead_of_cloud_stream')
        rows, size = [], 0
        for row in c.execute('SELECT * FROM observations WHERE seq>? ORDER BY seq LIMIT ?',(after,limit)):
            item = dict(row)
            item_size = len(canonical(item).encode())
            if rows and size+item_size > 1_500_000:
                break
            rows.append(item)
            size += item_size
        last = rows[-1]['seq'] if rows else after
        envelope = {'schema':VERSION,'stream_id':stream,'after_sequence':after,'last_sequence':last,
                    'maximum_sequence':maximum,'has_more':last<maximum,'exported_at':utcnow(),'rows':rows}
        return gzip.compress(canonical(envelope).encode(),compresslevel=3,mtime=0)
    finally:
        c.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--after',type=int,default=0)
    parser.add_argument('--limit',type=int,default=250)
    args = parser.parse_args()
    path = Path(os.getenv('VCT_DB_PATH','/data/vct.sqlite3')).with_name('evidence-ledger.sqlite3')
    sys.stdout.buffer.write(export_batch(path,after=args.after,limit=args.limit))


if __name__ == '__main__':
    main()
