import os
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from frontend.dispatch.maps import Maps, fallback_route
from frontend.dispatch.routing import solve
from frontend.dispatch import app as service


class DispatchTests(unittest.TestCase):
    def test_capacity_specialty_urgent(self):
        jobs=[{'id':str(i),'coordinates':[126.7+i*.001,35.0],'requiredPart':'전장','priority':'high' if i==6 else 'low'} for i in range(7)]
        jobs.append({'id':'unsupported','coordinates':[126.8,35.0],'requiredPart':'유압','priority':'high'})
        techs=[{'id':'T1','name':'기사','specialties':['전장']}]
        result=solve([126.7,35.0],jobs,techs,seconds=1)
        assigned=result['routes'][0]['jobs']
        self.assertEqual(len(assigned),5)
        self.assertIn('6',[j['id'] for j in assigned])
        self.assertTrue(any(j['id']=='unsupported' for j in result['unassigned']))
        self.assertTrue(all(j['requiredPart']=='전장' for j in assigned))
        self.assertEqual(len(assigned)+len(result['unassigned']),len(jobs))

    def test_geocode_cache_and_secret_header(self):
        calls=[]
        def reply(request):
            calls.append(request)
            self.assertEqual(request.headers['x-ncp-apigw-api-key'],'test-secret')
            return httpx.Response(200,json={'status':'OK','addresses':[{'x':'126.7','y':'35.0'}]})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{'NCP_CLIENT_ID':'test-id','NCP_CLIENT_SECRET':'test-secret'}):
            maps=Maps(directory+'/cache.sqlite',httpx.Client(transport=httpx.MockTransport(reply)))
            self.assertEqual(maps.geocode('시연 주소'),[126.7,35.0]);maps.geocode('시연 주소')
            self.assertEqual(len(calls),1)

    def test_directions_one_call_no_return(self):
        calls=[]
        def reply(request):
            calls.append(request)
            self.assertEqual(request.url.params['goal'],'126.72,35.02')
            self.assertEqual(request.url.params['waypoints'],'126.71,35.01')
            return httpx.Response(200,json={'code':0,'route':{'trafast':[{'summary':{'distance':2000,'duration':120000},'path':[[126.7,35.0],[126.72,35.02]]}]}})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{'NCP_CLIENT_ID':'test-id','NCP_CLIENT_SECRET':'test-secret'}):
            maps=Maps(directory+'/cache.sqlite',httpx.Client(transport=httpx.MockTransport(reply)))
            route=maps.directions([126.7,35.0],[[126.71,35.01],[126.72,35.02]])
            self.assertEqual(route['durationSeconds'],120)
            self.assertEqual(len(calls),1)

    def test_pipeline_api_failure_and_paths_private(self):
        client=TestClient(service.app)
        with patch.object(service.mapper,'geocode',side_effect=RuntimeError('API failed')):
            data=client.post('/api/dispatch/geocode').json()
        self.assertEqual(len(data['jobs']),20)
        self.assertEqual(len(data['addressErrors']),21)
        ident=data['runId'];result=client.post('/api/dispatch/plan/'+ident)
        self.assertEqual(result.status_code,200)
        result=client.post('/api/dispatch/directions/'+ident).json()
        self.assertEqual(result['stage'],'finished')
        self.assertEqual(sum(len(r['jobs']) for r in result['routes'])+len(result['unassigned']),20)
        self.assertTrue(all(r['fallback'] for r in result['routes']))
        self.assertTrue(all(len(r['jobs'])<=5 for r in result['routes']))
        for route in result['routes']:
            self.assertTrue(all(j['requiredPart'] in route['technician']['specialties'] for j in route['jobs']))
        for path in ['/dispatch/.env','/.env','/dispatch/app.py','/.gitignore','/dispatch/.private/geocoding.sqlite']:
            self.assertEqual(client.get(path).status_code,404)
        self.assertEqual(client.get('/dispatch/').status_code,200)
        self.assertNotIn('secret',client.get('/api/dispatch/config').json())

    def test_failed_real_address_is_not_invented(self):
        with patch.object(service,'load_data',return_value=([{'id':'REAL-1','address':'확인 안 된 주소'}],[])),patch.object(service.mapper,'geocode',side_effect=RuntimeError()):
            data=service.geocode_stage()
        self.assertEqual(data['jobs'],[])
        self.assertTrue(any(e['id']=='REAL-1' for e in data['addressErrors']))

    def test_directions_retry_once_and_fallback(self):
        data={'headquarters':{'coordinates':[126.7,35.0],'fallback':False},'routes':[{'jobs':[{'id':'A','coordinates':[126.8,35.1]}],**fallback_route([126.7,35.0],[{'coordinates':[126.8,35.1]}])}],'stage':'planned'}
        with patch.object(service.mapper,'directions',side_effect=RuntimeError()) as call:
            result=service.directions_stage(data);again=service.directions_stage(result)
        self.assertEqual(call.call_count,1)
        self.assertTrue(again['routes'][0]['fallback'])
        self.assertIn('대체 경로',again['routes'][0]['label'])

if __name__=='__main__':unittest.main()
