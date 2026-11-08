import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from server import app as service
from server.records import RecordStore

PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII='


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = RecordStore(self.temp.name)
        self.patch = patch.object(service, 'record_store', self.store)
        self.patch.start()
        self.client = TestClient(service.app)

    def tearDown(self):
        self.client.close()
        self.patch.stop()
        self.temp.cleanup()

    def record(self, id='TEST-1', **kwargs):
        return {'id': id, 'customerName': '합성 검증 고객', 'stage': 'counseling', 'transcript': [], 'beforePhotos': [], 'afterPhotos': [], **kwargs}

    def save(self, record, revision=0):
        return self.client.post('/api/records/sync', json={'changes': [{'record': record, 'baseRevision': revision}]})

    def test_images_signatures_persist_across_clients_and_store_restart(self):
        record = self.record(beforePhotos=[PNG]*5, afterPhotos=[PNG]*5, finalSignature={'image': PNG, 'typedName': '합성 고객'})
        response = self.save(record)
        self.assertEqual(response.status_code, 200)
        saved = response.json()['cases'][0]
        self.assertEqual(saved['_serverRevision'], 1)
        url = saved['finalSignature']['image']
        self.assertTrue(url.startswith('./api/records/media/'))
        self.assertEqual(self.client.get(url[1:]).content, base64.b64decode(PNG.split(',')[1]))
        self.assertEqual(len(list(self.store.media.iterdir())), 1)
        with patch.object(service, 'record_store', RecordStore(self.temp.name)), TestClient(service.app) as other:
            self.assertEqual(other.get('/api/records').json()['cases'][0], saved)
        self.assertNotIn('data:image', self.store.snapshot()['cases'][0]['beforePhotos'][0])
        self.assertEqual(self.store.database.stat().st_mode & 0o777, 0o600)

    def test_concurrent_versions_and_atomic_batch(self):
        a = self.save(self.record()).json()['cases'][0]
        b = self.save(self.record('TEST-2')).json()['cases'][0]
        self.assertEqual(self.save({**a, 'stage': 'complete'}, 1).status_code, 200)
        stale = self.client.post('/api/records/sync', json={'changes': [
            {'record': {**a, 'stage': 'checklist'}, 'baseRevision': 1},
            {'record': {**b, 'stage': 'complete'}, 'baseRevision': 1}]})
        self.assertEqual(stale.status_code, 409)
        rows = {c['id']: c for c in self.store.snapshot()['cases']}
        self.assertEqual(rows['TEST-1']['stage'], 'complete')
        self.assertEqual(rows['TEST-2']['stage'], 'counseling')
        self.assertEqual(self.save({**b, 'stage': 'checklist'}, 1).status_code, 200)

    def test_lost_response_retry_is_idempotent(self):
        record = self.record(beforePhotos=[PNG])
        a = self.save(record).json()['cases'][0]
        b = self.save(record).json()['cases'][0]
        self.assertEqual(a, b)

    def test_legacy_import_preserves_winner_and_archives_different_old_copy(self):
        old = self.record()
        self.assertEqual(self.client.post('/api/records/import', json={'cases': [old]}).json()['imported'], 1)
        winner = self.save({**old, 'stage': 'complete'}, 1).json()['cases'][0]
        response = self.client.post('/api/records/import', json={'cases': [old, self.record('TEST-2')]})
        self.assertEqual(response.json(), {'imported': 1, 'archived': 1})
        self.assertEqual(self.store.snapshot()['cases'][0], winner)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM legacy_archive').fetchone()[0], 1)

    def test_daily_demo_changes_do_not_reset_real_records(self):
        with patch('server.records.today', return_value='2026-11-08'):
            self.assertEqual(self.save(self.record('FARMINGBOY-CUS-094', demoDay='2026-11-08')).status_code, 200)
            self.save(self.record())
        with patch('server.records.today', return_value='2026-11-09'):
            self.assertEqual(len(self.store.snapshot()['cases']), 1)
            self.assertEqual(self.save(self.record('FARMINGBOY-CUS-094', demoDay='2026-11-08')).status_code, 409)
            self.assertEqual(self.save(self.record('FARMINGBOY-CUS-094', demoDay='2026-11-09')).status_code, 200)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM records').fetchone()[0], 3)

    def test_settings_conflicts_poll_cursor_and_private_paths(self):
        data = {'settings': {'staff': {'baseRevision': 0, 'value': {'engineers': ['엔지니어 A']}}}}
        self.assertEqual(self.client.post('/api/records/sync', json=data).status_code, 200)
        snapshot = self.client.get('/api/records')
        self.assertEqual(snapshot.headers['cache-control'], 'no-store')
        revision = snapshot.json()['revision']
        self.assertTrue(self.client.get('/api/records', params={'since': revision}).json()['unchanged'])
        data['settings']['staff']['value']['engineers'].append('엔지니어 B')
        self.assertEqual(self.client.post('/api/records/sync', json=data).status_code, 409)
        for url in ['/api/records/media/.env', '/api/records/media/records.sqlite3', '/records.sqlite3', '/dispatch/.env']:
            self.assertEqual(self.client.get(url).status_code, 404, url)

    def test_invalid_uploads_and_shapes(self):
        for photos in [[PNG]*6, ['data:image/svg+xml;base64,PHN2Zz4='], ['https://example.com/x.png'], ['\" onerror=alert(1)'], ['data:image/png;base64,YmFk']]:
            self.assertEqual(self.save(self.record(beforePhotos=photos)).status_code, 422)
        self.assertEqual(self.save(self.record('../bad')).status_code, 422)
        self.assertEqual(self.client.post('/api/records/sync', json={'changes': [None]}).status_code, 422)
        self.assertEqual(self.client.post('/api/records/sync', json={'settings': {'staff': None}}).status_code, 422)
        self.assertEqual(self.client.post('/api/records/sync', content='[]', headers={'Content-Type': 'application/json'}).status_code, 422)
        self.assertEqual(self.client.post('/api/records/sync', content='{}').status_code, 415)
