"""Verified private H-drive archive. Standard library only; no cloud writes/deletes."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

from .evidence import VERSION, canonical, utcnow


class LocalArchive:
    def __init__(self, root):
        self.root = Path(root)
        self.files = self.root/'batches'
        self.files.mkdir(parents=True,exist_ok=True)
        with self.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS receipts(
                sha256 TEXT PRIMARY KEY,stream_id TEXT NOT NULL,after_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,
                records INTEGER NOT NULL,file_name TEXT NOT NULL,received_at TEXT NOT NULL);
            ''')

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.root/'archive-index.sqlite3',timeout=5)
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

    def position(self):
        with self.connect() as c:
            values = dict(c.execute('SELECT key,value FROM state'))
        return values.get('stream_id'), int(values.get('last_sequence',0))

    def accept(self, blob):
        if len(blob)>5_000_000:
            raise ValueError('archive_batch_too_large')
        with gzip.GzipFile(fileobj=io.BytesIO(blob)) as stream:
            content = stream.read(2_000_001)
        if len(content)>2_000_000:
            raise ValueError('archive_uncompressed_batch_too_large')
        envelope = json.loads(content)
        if envelope.get('schema') != VERSION:
            raise ValueError('archive_schema_mismatch')
        stream_id = str(uuid.UUID(envelope['stream_id']))
        rows = envelope['rows']
        if not isinstance(rows,list) or len(rows)>500:
            raise ValueError('archive_invalid_row_count')
        expected = envelope['after_sequence']
        for row in rows:
            if row['seq'] != expected+1:
                raise ValueError('archive_sequence_gap')
            expected = row['seq']
            digest = hashlib.sha256(row['payload_json'].encode()).hexdigest()
            if digest != row['facts_hash']:
                raise ValueError('archive_facts_hash_mismatch')
            identifier = hashlib.sha256(canonical([row['kind'],row['source_id'],row['external_id'],
                digest,row['observed_at'],row['previous_id']]).encode()).hexdigest()
            if identifier != row['evidence_id']:
                raise ValueError('archive_evidence_hash_mismatch')
        if expected != envelope['last_sequence'] or expected > envelope['maximum_sequence']:
            raise ValueError('archive_invalid_end_sequence')
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            state = dict(c.execute('SELECT key,value FROM state'))
            if state.get('stream_id') not in (None,stream_id):
                raise ValueError('archive_stream_changed_requires_review')
            if int(state.get('last_sequence',0)) != envelope['after_sequence']:
                raise ValueError('archive_cursor_mismatch')
            if rows:
                digest = hashlib.sha256(blob).hexdigest()
                name = f"{rows[0]['seq']:012d}-{expected:012d}-{digest[:16]}.json.gz"
                target = self.files/name
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(dir=self.files,prefix='.receiving-',delete=False) as out:
                        temporary = Path(out.name)
                        out.write(blob)
                        out.flush()
                        os.fsync(out.fileno())
                    if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                        raise IOError('archive_local_readback_failed')
                    os.replace(temporary,target)
                    temporary = None
                    c.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)',
                        (digest,stream_id,envelope['after_sequence'],expected,len(rows),name,utcnow()))
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)  # Only our incomplete temporary download.
            c.execute('INSERT OR REPLACE INTO state VALUES(?,?)',('stream_id',stream_id))
            c.execute('INSERT OR REPLACE INTO state VALUES(?,?)',('last_sequence',str(expected)))
        return {'records':len(rows),'last_sequence':expected,'has_more':bool(envelope['has_more']),
                'stream_id':stream_id}

    def verify(self):
        count = 0
        with self.connect() as c:
            rows = c.execute('SELECT sha256,file_name,records FROM receipts ORDER BY after_seq').fetchall()
        for digest,name,records in rows:
            blob = (self.files/name).read_bytes()
            if hashlib.sha256(blob).hexdigest() != digest:
                raise ValueError('archive_existing_file_hash_mismatch')
            payload = json.loads(gzip.decompress(blob))
            if len(payload['rows']) != records:
                raise ValueError('archive_existing_file_count_mismatch')
            count += records
        return {'status':'VERIFIED','files':len(rows),'records':count,'last_sequence':self.position()[1]}


def ssh_export(settings, *, after, limit=250):
    # Use the already installed/authenticated CLI, no npx/install/login fallback.
    cli = subprocess.run([settings['railway_cli'],'ssh','config','--dry-run','-s',settings['service_id']],
        capture_output=True,text=True,encoding='utf-8',timeout=25,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if cli.returncode:
        raise RuntimeError('railway_auth_or_connection_unavailable')
    host = re.search(r'^\s*HostName\s+(\S+)\s*$',cli.stdout,re.M)
    user = re.search(r'^\s*User\s+([a-zA-Z0-9-]+)\s*$',cli.stdout,re.M)
    if not host or host[1]!='ssh.railway.com' or not user:
        raise RuntimeError('railway_ssh_identity_unverified')
    command = [settings['ssh'],'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
               '-o','ConnectTimeout=12','-o','IdentitiesOnly=yes','-i',settings['identity_file']]
    proxy = settings.get('proxy')
    if proxy:
        # Only an explicitly configured loopback proxy and existing connect tool.
        address,port = proxy.rsplit(':',1)
        if address not in {'127.0.0.1','localhost'} or not port.isdigit():
            raise ValueError('archive_proxy_must_be_loopback')
        try:
            with socket.create_connection((address,int(port)),timeout=1):
                pass
            connector = settings['proxy_connector'].replace('\\','/')
            command += ['-o',f'ProxyCommand="{connector}" -H {proxy} %h %p']
        except OSError:
            pass
    command += [f'{user[1]}@{host[1]}',f'python -m vct_prediction.archive_export --after {int(after)} --limit {int(limit)}']
    result = subprocess.run(command,capture_output=True,timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:
        # Do not store full command/auth/environment/provider response bodies.
        error = result.stderr.decode('utf-8',errors='replace')
        category = 'host_verification' if 'Host key verification failed' in error else 'authorization' if 'Permission denied' in error else 'transport_or_remote_export'
        raise RuntimeError('archive_ssh_'+category)
    return result.stdout


def run_sync(settings_path, *, max_batches=3):
    settings = json.loads(Path(settings_path).read_text(encoding='utf-8-sig'))
    archive = LocalArchive(settings['archive_root'])
    start = time.monotonic()
    records, batches, last = 0,0,None
    for _ in range(max_batches):
        if time.monotonic()-start>240:
            break
        _,after = archive.position()
        last = archive.accept(ssh_export(settings,after=after))
        records += last['records']
        batches += 1
        if not last['has_more']:
            break
    return {'status':'CAUGHT_UP' if last and not last['has_more'] else 'BACKLOG_PENDING',
            'new_records':records,'batches':batches,'last_sequence':archive.position()[1],
            'cloud_write_or_delete':False,'checked_at':utcnow()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--settings',required=True)
    parser.add_argument('--max-batches',type=int,default=3,choices=range(1,11))
    parser.add_argument('--verify',action='store_true')
    args = parser.parse_args()
    settings = json.loads(Path(args.settings).read_text(encoding='utf-8-sig'))
    root = Path(settings['archive_root'])
    root.mkdir(parents=True,exist_ok=True)
    try:
        report = LocalArchive(root).verify() if args.verify else run_sync(args.settings,max_batches=args.max_batches)
        code = 0
    except Exception as exc:
        report = {'status':'SYNC_PENDING','reason':str(exc)[:180],'checked_at':utcnow(),
                  'cloud_operation_unaffected':True,'cloud_write_or_delete':False}
        code = 2
    temporary = root/'archive-status.json.tmp'
    temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    os.replace(temporary,root/'archive-status.json')
    if sys.stdout is not None:
        print(json.dumps(report,ensure_ascii=False))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
