import csv
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from threading import Lock
from pydantic import BaseModel, Field
import httpx

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
from .maps import Maps, fallback_route, haversine
from .routing import solve

app = FastAPI(title='Fieldnote 배차 데모')
runs = {}
run_lock = Lock()
mapper = Maps()
agent_sessions = {}
agent_session_lock = Lock()
AGENTSTREAM_DEFAULT_BASE_URL = 'https://api-gateway.jntp-ax.or.kr/agentstream'
AGENTSTREAM_DEFAULT_CHATBOT_ID = '4723b84d-e559-4d5a-8d0b-7de80e5764f8'
VISITOR_COOKIE = 'fieldnote_visitor_id'
HQ_ADDRESS = os.getenv('HQ_ADDRESS', '전라남도 나주시 왕곡면 혁신산단6길 9')
HQ_COORDINATES = [
    float(os.getenv('HQ_LNG', '126.6928956')),
    float(os.getenv('HQ_LAT', '34.969903')),
]


@app.middleware('http')
async def strip_deployment_base_path(request, call_next):
    """Allow path-based gateways to forward their public prefix unchanged."""
    base_path = '/' + os.getenv('APP_BASE_PATH', '').strip('/')
    if base_path != '/' and (
        request.scope['path'] == base_path
        or request.scope['path'].startswith(base_path + '/')
    ):
        path = request.scope['path'][len(base_path):] or '/'
        request.scope['path'] = path
        request.scope['raw_path'] = path.encode('utf-8')
    return await call_next(request)

def load_data():
    with (ROOT/'data/as_requests.csv').open(encoding='utf-8-sig') as file:
        rows = list(csv.DictReader(file))
    with (ROOT/'data/technicians.csv').open(encoding='utf-8-sig') as file:
        techs = list(csv.DictReader(file))
    if len(rows)>100 or len(techs)>20:
        raise HTTPException(422, '접수 100건·기사 20명 이하로 입력해 주세요.')
    today = datetime.now(ZoneInfo('Asia/Seoul')).date().isoformat()
    jobs = [{'id':r['접수ID'], 'date':r['접수일'], 'address':r['주소'], 'model':r['모델'], 'symptom':r['증상(고객 말)'], 'requiredPart':r['필요파트'], 'priority':{'상':'high','중':'normal','하':'low'}.get(r['긴급도'],'normal')} for r in rows if r['접수일']<=today]
    technicians = [
        {
            'id': t['기사ID'],
            'name': t['이름'],
            'specialties': [part.strip() for part in t['전문파트'].split('|') if part.strip()],
        }
        for t in techs
    ]
    if len({j['id'] for j in jobs})!=len(jobs) or len({t['id'] for t in technicians})!=len(technicians):
        raise HTTPException(422, '접수/기사 ID가 중복되었습니다.')
    return jobs, technicians


def geocode_stage():
    jobs, techs = load_data()
    sample_coords = json.loads((ROOT/'data/demo_coordinates.json').read_text())
    errors, located = [], []
    address = HQ_ADDRESS
    headquarters = {'address':address,'coordinates':None,'fallback':False}
    try:
        headquarters['coordinates']=mapper.geocode(address)
    except Exception:
        headquarters.update(coordinates=HQ_COORDINATES,fallback=True)
        headquarters['cachedFixedCoordinates']=True
        errors.append({'id':'HQ','address':address,'reason':'본점 주소 확인 필요 · API 연결/권한 확인'})
    addresses=list(dict.fromkeys(j['address'] for j in jobs))
    def locate(address):
        try:return mapper.geocode(address)
        except Exception:return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        coordinates=dict(zip(addresses,pool.map(locate,addresses)))
    for job in jobs:
        point=coordinates[job['address']]
        if point is None:
            # Only explicitly bundled synthetic IDs have approximate demo coordinates.
            point=sample_coords.get(job['id']) if job['id'].startswith('DEMO-') else None
            errors.append({'id':job['id'],'address':job['address'],'reason':'주소 확인 필요'+(' · 합성 시연 좌표로 대체' if point else '')})
            job['fallbackCoordinates']=bool(point)
        job['coordinates']=point
        if point:located.append(job)
    return {'headquarters':headquarters,'jobs':located,'technicians':techs,'addressErrors':errors,'inputCount':len(jobs)}


def settings():
    factor=float(os.getenv('DISTANCE_FACTOR','1.3'));speed=float(os.getenv('AVERAGE_SPEED_KMH','40'))
    capacity=int(os.getenv('MAX_JOBS_PER_TECH','5'));seconds=int(os.getenv('SOLVER_SECONDS','2'))
    if not 1<=factor<=3 or not 1<=speed<=120 or not 1<=capacity<=5 or not 1<=seconds<=20:
        raise HTTPException(422,'보정계수·속도·일일 한도(최대 5건)·계산시간 설정을 확인해 주세요.')
    return factor,speed,capacity,seconds


def plan_stage(data):
    factor,speed,capacity,seconds=settings()
    if not data['headquarters']['coordinates']:
        return {**data,'routes':[],'unassigned':[{**j,'reason':'본점 주소 확인 필요'} for j in data['jobs']],'stage':'planned'}
    result=solve(data['headquarters']['coordinates'],data['jobs'],data['technicians'],factor,speed,capacity,seconds)
    for route in result['routes']:
        route.update(fallback_route(data['headquarters']['coordinates'],route['jobs'],factor,speed))
    return {**data,**result,'stage':'planned','planningMethod':f'보정 직선거리 ×{factor} / {speed}km/h · OR-Tools CVRP'}


def directions_stage(data):
    if data.get('stage')=='finished':return data
    if data.get('stage')!='planned':raise HTTPException(409,'배차를 먼저 실행해 주세요.')
    def road(route):
        if not route['jobs']:return route
        if data['headquarters']['fallback'] or any(j.get('fallbackCoordinates') for j in route['jobs']):
            return {**route,'label':'대체 경로 · 합성 시연 좌표'}
        try:return {**route,**mapper.directions(data['headquarters']['coordinates'],[j['coordinates'] for j in route['jobs']])}
        except Exception:return {**route,'fallback':True,'label':'대체 경로 · Directions 연결/권한 확인'}
    with ThreadPoolExecutor(max_workers=4) as pool:
        routes=list(pool.map(road,data['routes']))
    return {**data,'routes':routes,'stage':'finished'}


class AgentChatBody(BaseModel):
    caseId: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list, max_length=40)


class TravelEstimateBody(BaseModel):
    address: str = Field(min_length=3, max_length=300)


def travel_fee_for(address, distance_km):
    compact = ''.join(address.split())
    if '나주시' in compact:
        return 'naju', 33000
    if any(token in compact for token in ('전라남도', '전남', '전남광주통합특별시')):
        return 'jeonnam', 55000 if distance_km < 60 else 77000 if distance_km < 100 else 100000
    return 'outside', 100000


def agentstream_settings():
    base_url = os.getenv('AGENTSTREAM_BASE_URL', AGENTSTREAM_DEFAULT_BASE_URL).strip().rstrip('/')
    chatbot_id = os.getenv('AGENTSTREAM_CHATBOT_ID', AGENTSTREAM_DEFAULT_CHATBOT_ID).strip()
    api_key = os.getenv('AGENTSTREAM_API_KEY', '').strip()
    if not base_url or not chatbot_id or not api_key:
        raise HTTPException(503, 'AgentStream 서버 설정이 없습니다. 운영자에게 연결을 요청해 주세요.')
    return base_url, chatbot_id, api_key


def agentstream_headers(api_key):
    return {'X-API-Key': api_key, 'Accept': 'application/json'}


def agentstream_http_error(response, operation):
    if response.status_code == 401:
        detail = 'AgentStream 인증 키가 없거나 유효하지 않습니다.'
    elif response.status_code == 403:
        detail = 'AgentStream 챗봇 호출 권한을 확인해 주세요.'
    elif response.status_code == 404:
        detail = 'AgentStream API 경로 또는 챗봇 설정을 확인해 주세요.'
    elif response.status_code == 422:
        detail = 'AgentStream 요청 형식을 확인해 주세요.'
    elif response.status_code in (429, 503):
        detail = 'AgentStream이 일시적으로 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    else:
        detail = f'AgentStream {operation}에 실패했습니다. (HTTP {response.status_code})'
    return HTTPException(response.status_code if response.status_code < 500 else 502, detail)


def agentstream_session(visitor_id, case_id, first_message, base_url, chatbot_id, api_key):
    key = (visitor_id, case_id)
    with agent_session_lock:
        existing = agent_sessions.get(key)
    if existing:
        return existing, False

    headers = agentstream_headers(api_key)
    try:
        health = httpx.get(
            f'{base_url}/open/v1/chatbots/{chatbot_id}/health',
            headers=headers,
            timeout=15,
        )
        if health.status_code != 200:
            raise agentstream_http_error(health, 'health 확인')
        health_payload = health.json()
        if health_payload.get('status') == 'unhealthy':
            raise HTTPException(503, 'AgentStream 챗봇이 현재 정상 상태가 아닙니다.')

        session = httpx.post(
            f'{base_url}/open/v1/chatbots/{chatbot_id}/sessions',
            json={'query': first_message},
            headers=headers,
            timeout=30,
        )
        if session.status_code != 201:
            raise agentstream_http_error(session, '세션 생성')
        session_id = session.json().get('session_id')
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(502, 'AgentStream 세션 ID가 응답되지 않았습니다.')
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(502, 'AgentStream 연결에 실패했습니다.') from error

    with agent_session_lock:
        if len(agent_sessions) >= 2048:
            agent_sessions.pop(next(iter(agent_sessions)))
        agent_sessions[key] = session_id
    return session_id, True


@app.post('/api/agentstream/chat')
def agentstream_chat(body: AgentChatBody, request: Request):
    base_url, chatbot_id, api_key = agentstream_settings()
    visitor_id = request.cookies.get(VISITOR_COOKIE) or uuid.uuid4().hex
    session_id, created = agentstream_session(
        visitor_id, body.caseId, body.message, base_url, chatbot_id, api_key
    )
    stream_url = f'{base_url}/open/v1/chat-sessions/{session_id}/messages'
    client = httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))
    stream = client.stream(
        'POST',
        stream_url,
        json={'message': body.message},
        headers={'X-API-Key': api_key, 'Accept': 'application/x-ndjson', 'Content-Type': 'application/json'},
    )
    try:
        upstream = stream.__enter__()
        if upstream.status_code != 200:
            error = agentstream_http_error(upstream, '메시지 전송')
            stream.__exit__(None, None, None)
            client.close()
            raise error
    except HTTPException:
        raise
    except httpx.HTTPError as error:
        client.close()
        raise HTTPException(502, 'AgentStream 메시지 연결에 실패했습니다.') from error

    def lines():
        try:
            for line in upstream.iter_lines():
                if line:
                    if isinstance(line, bytes):
                        line = line.decode('utf-8')
                    yield line if line.endswith('\n') else line + '\n'
        finally:
            stream.__exit__(None, None, None)
            client.close()

    result = StreamingResponse(lines(), media_type='application/x-ndjson')
    if not request.cookies.get(VISITOR_COOKIE):
        result.set_cookie(VISITOR_COOKIE, visitor_id, httponly=True, samesite='lax', max_age=60 * 60 * 24 * 30)
    if created:
        result.headers['X-Fieldnote-Session'] = 'created'
    return result


@app.get('/api/dispatch/config')
def config():
    return {'clientId':os.getenv('NCP_CLIENT_ID',''),'hqAddress':HQ_ADDRESS,'hqCoordinates':HQ_COORDINATES,'demo':True}


@app.post('/api/dispatch/travel-estimate')
def travel_estimate(body: TravelEstimateBody):
    address = body.address.strip()
    try:
        destination = mapper.geocode(address)
    except Exception as error:
        raise HTTPException(422, '출동 주소를 지도에서 하나로 확인할 수 없습니다.') from error
    try:
        origin = mapper.geocode(HQ_ADDRESS)
        hq_source = '본사 주소 지오코딩'
    except Exception:
        origin = HQ_COORDINATES
        hq_source = '저장된 본사 좌표'
    try:
        route = mapper.directions(origin, [destination])
        distance_meters = route['distanceMeters']
        duration_seconds = route['durationSeconds']
        source = route['label']
    except Exception:
        factor, speed, _, _ = settings()
        distance_meters = haversine(origin, destination) * factor
        duration_seconds = distance_meters / (speed * 1000 / 3600)
        source = f'대체 거리 · 보정 직선거리 ×{factor}'
    distance_km = round(distance_meters / 1000, 1)
    region, fee = travel_fee_for(address, distance_km)
    return {
        'hqAddress': HQ_ADDRESS,
        'dispatchAddress': address,
        'distanceKm': distance_km,
        'distanceMeters': round(distance_meters),
        'durationMinutes': max(1, round(duration_seconds / 60)),
        'region': region,
        'travelFee': fee,
        'source': source,
        'hqSource': hq_source,
    }

@app.post('/api/dispatch/geocode')
def geocode_api():
    data=geocode_stage();ident=uuid.uuid4().hex
    if len(runs)>=32:runs.pop(next(iter(runs)))
    runs[ident]=data
    return {**data,'runId':ident,'stage':'geocoded'}


def run(ident):
    if ident not in runs:raise HTTPException(404,'새 배차를 실행해 주세요.')
    return runs[ident]

@app.post('/api/dispatch/plan/{ident}')
def plan_api(ident:str):
    with run_lock:
        data=run(ident)
        if data.get('stage') not in ('planned','finished'):runs[ident]=plan_stage(data)
        return {**runs[ident],'runId':ident}

@app.post('/api/dispatch/directions/{ident}')
def directions_api(ident:str):
    with run_lock:
        runs[ident]=directions_stage(run(ident))
        return {**runs[ident],'runId':ident}

@app.post('/api/dispatch/run')
def full_pipeline():
    return directions_stage(plan_stage(geocode_stage()))

@app.get('/dispatch/')
def dispatch_page():return FileResponse(ROOT/'index.html')

@app.get('/')
def fieldnote():return FileResponse(ROOT.parent/'index.html')

# An explicit file allowlist prevents .env, Python source, CSV and caches being served.
PUBLIC={p.name:p for p in ROOT.parent.iterdir() if p.suffix in ('.js','.css') and p.is_file()}
PUBLIC_DATA={'farmingboy_customers_100.json': ROOT.parent/'data'/'farmingboy_customers_100.json'}
@app.get('/data/{filename}')
def public_data(filename:str):
    path=PUBLIC_DATA.get(filename)
    if not path or not path.is_file(): raise HTTPException(404)
    return FileResponse(path, media_type='application/json')

@app.get('/{filename}')
def public_file(filename:str):
    if filename not in PUBLIC:raise HTTPException(404)
    return FileResponse(PUBLIC[filename])
