import json
import math
import os
import sqlite3
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent

class Maps:
    def __init__(self, cache_path=None, client=None):
        self.cache = Path(cache_path or ROOT / '.private' / 'geocoding.sqlite')
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.cache) as db:
            db.execute('CREATE TABLE IF NOT EXISTS geocodes(address TEXT PRIMARY KEY, lng REAL, lat REAL)')
        self.client = client or httpx.Client(timeout=8, follow_redirects=False)
        self.host = os.getenv('NCP_MAPS_HOST', 'maps.apigw.ntruss.com')
        if self.host not in ('maps.apigw.ntruss.com', 'naveropenapi.apigw.ntruss.com'):
            raise ValueError('NCP_MAPS_HOST must be an official Maps host')

    def headers(self):
        client_id, secret = os.getenv('NCP_CLIENT_ID'), os.getenv('NCP_CLIENT_SECRET')
        if not client_id or not secret:
            raise ValueError('지도 키 미설정')
        return {'x-ncp-apigw-api-key-id': client_id, 'x-ncp-apigw-api-key': secret}

    def geocode(self, address):
        with sqlite3.connect(self.cache) as db:
            row = db.execute('SELECT lng,lat FROM geocodes WHERE address=?', (address.strip(),)).fetchone()
        if row:
            return list(row)
        response = self.client.get(f'https://{self.host}/map-geocode/v2/geocode', params={'query': address, 'count': 2}, headers=self.headers())
        response.raise_for_status()
        result = response.json()
        if result.get('status') != 'OK' or len(result.get('addresses', [])) != 1:
            raise ValueError('주소를 하나로 확인할 수 없음')
        point = [float(result['addresses'][0]['x']), float(result['addresses'][0]['y'])]
        if not all(math.isfinite(x) for x in point) or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90:
            raise ValueError('좌표 오류')
        with sqlite3.connect(self.cache) as db:
            db.execute('INSERT OR REPLACE INTO geocodes VALUES(?,?,?)', (address.strip(), *point))
        return point

    def directions(self, origin, stops):
        if not stops or len(stops) > 5:
            raise ValueError('방문지는 1~5개 필요')
        params = {'start': ','.join(map(str, origin)), 'goal': ','.join(map(str, stops[-1])), 'option': 'trafast'}
        if len(stops) > 1:
            params['waypoints'] = '|'.join(','.join(map(str, point)) for point in stops[:-1])
        response = self.client.get(f'https://{self.host}/map-direction/v1/driving', params=params, headers=self.headers())
        response.raise_for_status()
        result = response.json()
        if result.get('code') != 0:
            raise ValueError('도로 경로 없음')
        route = result['route']['trafast'][0]
        distance, duration, path = route['summary']['distance'], route['summary']['duration'], route['path']
        if not all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0 for x in (distance, duration)) or len(path) < 2:
            raise ValueError('경로 응답 오류')
        if any(not isinstance(p, list) or len(p) != 2 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in p) for p in path):
            raise ValueError('경로 좌표 오류')
        return {'path': path, 'distanceMeters': distance, 'durationSeconds': duration / 1000, 'fallback': False, 'label': '네이버 도로 경로'}


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    value = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(value)))


def fallback_route(origin, jobs, factor=1.3, speed=40):
    points = [origin] + [job['coordinates'] for job in jobs]
    distance = sum(haversine(a, b)*factor for a, b in zip(points, points[1:]))
    return {'path': points, 'distanceMeters': distance, 'durationSeconds': distance/(speed*1000/3600), 'fallback': True, 'label': '대체 경로 · 보정 직선거리'}
