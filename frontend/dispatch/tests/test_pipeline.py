import os
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from frontend.dispatch import app as service
from frontend.dispatch.maps import Maps, fallback_route
from frontend.dispatch.routing import solve


class DispatchTests(unittest.TestCase):
    def client(self):
        return TestClient(service.app)

    def test_specialty_capacity_and_urgent_priority(self):
        jobs = [
            {'id': str(i), 'coordinates': [126.7 + i * .001, 35.0], 'requiredPart': '전장',
             'priority': 'high' if i == 6 else 'low'}
            for i in range(7)
        ]
        jobs.append({'id': 'unsupported', 'coordinates': [126.8, 35.0], 'requiredPart': '유압', 'priority': 'high'})
        techs = [{'id': 'T1', 'name': '기사', 'specialties': ['전장']}]
        result = solve([126.7, 35.0], jobs, techs, seconds=1)
        assigned = result['routes'][0]['jobs']
        self.assertEqual(len(assigned), 5)
        self.assertIn('6', [job['id'] for job in assigned])
        self.assertNotIn('unsupported', [job['id'] for job in assigned])
        self.assertTrue(any(job['id'] == 'unsupported' and '전문 파트' in job['reason'] for job in result['unassigned']))
        self.assertEqual(len(assigned) + len(result['unassigned']), len(jobs))

    def test_geocode_cache_and_secret_header(self):
        calls = []

        def reply(request):
            calls.append(request)
            self.assertEqual(request.headers['x-ncp-apigw-api-key'], 'test-secret')
            return httpx.Response(200, json={'status': 'OK', 'addresses': [{'x': '126.7', 'y': '35.0'}]})

        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {'NCP_CLIENT_ID': 'test-id', 'NCP_CLIENT_SECRET': 'test-secret'}
        ):
            maps = Maps(directory + '/cache.sqlite', httpx.Client(transport=httpx.MockTransport(reply)))
            self.assertEqual(maps.geocode('시연 주소'), [126.7, 35.0])
            maps.geocode('시연 주소')
            self.assertEqual(len(calls), 1)

    def test_directions_uses_last_visit_as_goal(self):
        calls = []

        def reply(request):
            calls.append(request)
            self.assertEqual(request.url.params['goal'], '126.72,35.02')
            self.assertEqual(request.url.params['waypoints'], '126.71,35.01')
            return httpx.Response(200, json={'code': 0, 'route': {'trafast': [{
                'summary': {'distance': 2000, 'duration': 120000},
                'path': [[126.7, 35.0], [126.71, 35.01], [126.72, 35.02]],
            }]}})

        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {'NCP_CLIENT_ID': 'test-id', 'NCP_CLIENT_SECRET': 'test-secret'}
        ):
            maps = Maps(directory + '/cache.sqlite', httpx.Client(transport=httpx.MockTransport(reply)))
            route = maps.directions([126.7, 35.0], [[126.71, 35.01], [126.72, 35.02]])
            self.assertEqual(route['durationSeconds'], 120)
            self.assertEqual(len(calls), 1)

    def test_pipeline_api_failure_uses_fallback_and_private_files_stay_private(self):
        client = self.client()
        with patch.object(service.mapper, 'geocode', side_effect=RuntimeError('API failed')):
            data = client.post('/api/dispatch/geocode').json()
        self.assertEqual(len(data['jobs']), 20)
        ident = data['runId']
        planned = client.post('/api/dispatch/plan/' + ident).json()
        result = client.post('/api/dispatch/directions/' + ident).json()
        self.assertEqual(result['stage'], 'finished')
        self.assertEqual(sum(len(route['jobs']) for route in result['routes']) + len(result['unassigned']), 20)
        self.assertTrue(all(len(route['jobs']) <= 5 for route in result['routes']))
        self.assertTrue(any(job['id'] == 'DEMO-020' for job in result['unassigned']))
        for route in result['routes']:
            if route['jobs']:
                self.assertNotEqual(route['path'][0], route['path'][-1])
                self.assertTrue(route['fallback'])
        self.assertEqual(planned['stage'], 'planned')
        for path in ['/dispatch/.env', '/.env', '/dispatch/app.py', '/.gitignore', '/dispatch/.private/geocoding.sqlite']:
            self.assertEqual(client.get(path).status_code, 404)
        self.assertEqual(client.get('/dispatch/').status_code, 200)
        config = client.get('/api/dispatch/config')
        self.assertEqual(config.status_code, 200)
        self.assertNotIn('secret', config.text.lower())

    def test_path_gateway_prefix_is_stripped_without_breaking_local_routes(self):
        prefix = '/i/team-service'
        with patch.dict(os.environ, {'APP_BASE_PATH': prefix}):
            self.assertEqual(self.client().get(prefix + '/').status_code, 200)
            self.assertEqual(self.client().get(prefix + '/dispatch/').status_code, 200)
            self.assertEqual(self.client().get(prefix + '/api/dispatch/config').status_code, 200)
            self.assertEqual(self.client().get('/').status_code, 200)

    def test_failed_real_address_is_not_invented(self):
        with patch.object(service, 'load_data', return_value=([{'id': 'REAL-1', 'address': '확인 안 된 주소'}], [])), patch.object(
            service.mapper, 'geocode', side_effect=RuntimeError()
        ):
            data = service.geocode_stage()
        self.assertEqual(data['jobs'], [])
        self.assertTrue(any(error['id'] == 'REAL-1' for error in data['addressErrors']))

    def test_agentstream_proxy_keeps_key_server_side(self):
        request = httpx.Request('POST', 'https://agent.example/chat')
        response = httpx.Response(200, request=request, json={'answer': '안전한 장소에 정차했는지 확인해 주세요.'})
        with patch.dict(os.environ, {
            'AGENTSTREAM_URL': 'https://agent.example/chat',
            'AGENTSTREAM_API_KEY': 'server-only-key',
        }), patch.object(service.httpx, 'post', return_value=response) as post:
            result = self.client().post('/api/agentstream/chat', json={
                'caseId': 'CASE-1', 'message': '시동이 안 걸려요', 'history': []
            })
        self.assertEqual(result.status_code, 200)
        self.assertIn('정차', result.json()['reply'])
        self.assertEqual(post.call_args.kwargs['headers']['Authorization'], 'Bearer server-only-key')
        self.assertNotIn('server-only-key', self.client().get('/api/dispatch/config').text)

    def test_fallback_route_stops_at_last_visit(self):
        route = fallback_route([126.7, 35.0], [{'coordinates': [126.8, 35.0]}])
        self.assertEqual(route['path'], [[126.7, 35.0], [126.8, 35.0]])


if __name__ == '__main__':
    unittest.main()
