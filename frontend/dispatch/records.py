"""Shared demo workspace persistence. Runtime records never live in the Git checkout."""
import base64
import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from contextlib import contextmanager

from fastapi import HTTPException

SETTINGS = {'staff', 'catalog', 'catalogSource', 'routePlans', 'originAddress'}
ID = re.compile(r'^[A-Za-z0-9_-]{1,120}$')
MEDIA = re.compile(r'^([a-f0-9]{64})\.(png|jpg|webp)$')
DEMO_MEDIA = {'charging-before-after.png', 'fuse-before-after.png', 'signatures.png'}


def today():
    return datetime.now(ZoneInfo('Asia/Seoul')).date().isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


class RecordStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.database = self.directory / 'records.sqlite3'
        self.media = self.directory / 'media'

    @contextmanager
    def connect(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.media.mkdir(exist_ok=True, mode=0o700)
        db = sqlite3.connect(self.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS records(id TEXT, day TEXT, revision INTEGER NOT NULL,
                data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(id, day));
            CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO meta VALUES(1, 0);
            CREATE TABLE IF NOT EXISTS legacy_archive(digest TEXT PRIMARY KEY, data TEXT NOT NULL, imported_at TEXT NOT NULL);
        ''')
        self.database.chmod(0o600)
        try:
            with db:
                yield db
        finally:
            db.close()

    def image(self, value):
        if not value:
            return value
        if not isinstance(value, str):
            raise HTTPException(422, '사진·서명 형식을 확인해 주세요.')
        if value.startswith('./assets/demo-repairs/') and value.rsplit('/', 1)[-1] in DEMO_MEDIA:
            return value
        prefix = './api/records/media/'
        if value.startswith(prefix) and MEDIA.fullmatch(value[len(prefix):]):
            if not (self.media / value[len(prefix):]).is_file():
                raise HTTPException(422, '서버에서 사진 파일을 찾을 수 없습니다.')
            return value
        match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)', value)
        if not match or len(value) > 6_000_000:
            raise HTTPException(422, '사진·서명은 PNG/JPEG/WebP 이미지로 저장해 주세요.')
        try:
            data = base64.b64decode(match[2], validate=True)
        except ValueError:
            raise HTTPException(422, '이미지 인코딩을 확인해 주세요.')
        kind = match[1]
        valid = ((kind == 'png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or
                 (kind == 'jpeg' and data.startswith(b'\xff\xd8\xff')) or
                 (kind == 'webp' and data.startswith(b'RIFF') and data[8:12] == b'WEBP'))
        if not valid or len(data) > 4_000_000:
            raise HTTPException(422, '올바른 이미지 파일(최대 4MB)을 사용해 주세요.')
        extension = 'jpg' if kind == 'jpeg' else kind
        name = hashlib.sha256(data).hexdigest() + '.' + extension
        path = self.media / name
        # Content-addressed, exclusive writes prevent duplicate files and partial overwrites.
        if not path.exists():
            import os
            import tempfile
            fd, temporary = tempfile.mkstemp(dir=self.media)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return prefix + name

    def prepare(self, raw):
        if not isinstance(raw, dict) or not ID.fullmatch(str(raw.get('id', ''))):
            raise HTTPException(422, '접수 ID를 확인해 주세요.')
        record = json.loads(encode(raw))
        record.pop('_serverRevision', None)
        record.pop('_pendingServer', None)
        day = record.get('demoDay', '') if record['id'].startswith('FARMINGBOY-') else ''
        if record['id'].startswith('FARMINGBOY-') and day != today():
            raise HTTPException(409, '데모 날짜가 바뀌었습니다. 새로고침해 주세요.')
        for key in ('beforePhotos', 'afterPhotos'):
            photos = record.get(key, [])
            if not isinstance(photos, list) or len(photos) > 5:
                raise HTTPException(422, '수리 전후 사진은 각각 최대 5장입니다.')
            record[key] = [self.image(photo) for photo in photos]
        for key in ('beforePhoto', 'afterPhoto'):
            if record.get(key):
                record[key] = self.image(record[key])
        for key in ('approvalSignature', 'finalSignature'):
            if record.get(key) and not isinstance(record[key], dict):
                raise HTTPException(422, '서명 형식을 확인해 주세요.')
            if record.get(key) and record[key].get('image'):
                record[key]['image'] = self.image(record[key]['image'])
        return record, day

    @staticmethod
    def row_record(row):
        return {**json.loads(row['data']), '_serverRevision': row['revision']}

    def snapshot(self, since=None):
        with self.connect() as db:
            db.execute('BEGIN')
            revision = db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0]
            if since == revision:
                return {'revision': revision, 'unchanged': True}
            cases = [self.row_record(r) for r in db.execute("SELECT * FROM records WHERE day='' OR day=? ORDER BY id", (today(),))]
            settings = {r['name']: {'value': json.loads(r['data']), 'revision': r['revision']} for r in db.execute('SELECT * FROM settings')}
            return {'revision': revision, 'cases': cases, 'settings': settings}

    def sync(self, changes, settings):
        if not isinstance(changes, list) or len(changes) > 200 or not isinstance(settings, dict) or not set(settings) <= SETTINGS:
            raise HTTPException(422, '저장 요청 범위를 확인해 주세요.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            prepared = []
            conflicts = []
            keys = set()
            for change in changes:
                if not isinstance(change, dict) or not isinstance(change.get('baseRevision'), int) or change['baseRevision'] < 0:
                    raise HTTPException(422, '접수 버전을 확인해 주세요.')
                raw = change.get('record', {})
                record, day = self.prepare(raw)
                key = (record['id'], day)
                if key in keys:
                    raise HTTPException(422, '중복 접수 ID입니다.')
                keys.add(key)
                existing = db.execute('SELECT * FROM records WHERE id=? AND day=?', key).fetchone()
                version = existing['revision'] if existing else 0
                # A retry after a lost response is idempotent.
                identical = bool(existing and existing['data'] == encode(record))
                if change.get('baseRevision') != version and not identical:
                    conflicts.append(record['id'])
                prepared.append((record, day, version, identical))
            for name, change in settings.items():
                if not isinstance(change, dict) or not isinstance(change.get('baseRevision'), int) or change['baseRevision'] < 0 or 'value' not in change:
                    raise HTTPException(422, '설정 버전을 확인해 주세요.')
                existing = db.execute('SELECT * FROM settings WHERE name=?', (name,)).fetchone()
                version = existing['revision'] if existing else 0
                if change.get('baseRevision') != version and not (existing and existing['data'] == encode(change.get('value'))):
                    conflicts.append('settings:' + name)
            if conflicts:
                raise HTTPException(409, {'message': '다른 기기에서 먼저 수정했습니다. 서버 기록을 확인해 주세요.', 'conflicts': conflicts})
            saved = []
            changed = False
            for record, day, version, identical in prepared:
                if not identical:
                    version += 1
                    db.execute('INSERT OR REPLACE INTO records VALUES(?,?,?,?,?)', (record['id'], day, version, encode(record), datetime.now().isoformat()))
                    changed = True
                saved.append({**record, '_serverRevision': version})
            saved_settings = {}
            for name, change in settings.items():
                existing = db.execute('SELECT * FROM settings WHERE name=?', (name,)).fetchone()
                version = existing['revision'] if existing else 0
                if not existing or existing['data'] != encode(change['value']):
                    version += 1
                    db.execute('INSERT OR REPLACE INTO settings VALUES(?,?,?)', (name, version, encode(change['value'])))
                    changed = True
                saved_settings[name] = {'value': change['value'], 'revision': version}
            if changed:
                db.execute('UPDATE meta SET revision=revision+1 WHERE id=1')
            return {'cases': saved, 'settings': saved_settings}

    def import_legacy(self, records):
        if not isinstance(records, list) or len(records) > 1000:
            raise HTTPException(422, '이전 접수 기록 수를 확인해 주세요.')
        imported = archived = 0
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for raw in records:
                record, day = self.prepare(raw)
                existing = db.execute('SELECT * FROM records WHERE id=? AND day=?', (record['id'], day)).fetchone()
                encoded = encode(record)
                if not existing:
                    db.execute('INSERT INTO records VALUES(?,?,?,?,?)', (record['id'], day, 1, encoded, datetime.now().isoformat()))
                    imported += 1
                elif existing['data'] != encoded:
                    digest = hashlib.sha256(encoded.encode()).hexdigest()
                    db.execute('INSERT OR IGNORE INTO legacy_archive VALUES(?,?,?)', (digest, encoded, datetime.now().isoformat()))
                    archived += 1
            if imported:
                db.execute('UPDATE meta SET revision=revision+1 WHERE id=1')
        return {'imported': imported, 'archived': archived}
