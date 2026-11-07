import csv
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from threading import Lock
from pydantic import BaseModel, Field
import httpx

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
from .maps import Maps, fallback_route
from .routing import solve

app = FastAPI(title='Fieldnote 배차 데모')
runs = {}
run_lock = Lock()
mapper = Maps()
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


def agentstream_text(payload):
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ''
    for key in ('reply', 'answer', 'output', 'content', 'message', 'text'):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            nested = agentstream_text(value)
            if nested:
                return nested
    choices = payload.get('choices')
    if isinstance(choices, list) and choices:
        return agentstream_text(choices[0])
    data = payload.get('data')
    return agentstream_text(data)


@app.post('/api/agentstream/chat')
def agentstream_chat(body: AgentChatBody):
    url = os.getenv('AGENTSTREAM_URL', '').strip()
    api_key = os.getenv('AGENTSTREAM_API_KEY', '').strip()
    if not url or not api_key:
        raise HTTPException(503, 'AgentStream URL과 API 키를 .env에 설정해 주세요.')
    header_name = os.getenv('AGENTSTREAM_AUTH_HEADER', 'Authorization').strip()
    scheme = os.getenv('AGENTSTREAM_AUTH_SCHEME', 'Bearer').strip()
    auth_value = f'{scheme} {api_key}'.strip()
    request_body = {
        'message': body.message,
        'conversation_id': body.caseId,
        'history': body.history[-20:],
    }
    try:
        response = httpx.post(
            url,
            json=request_body,
            headers={header_name: auth_value, 'Accept': 'application/json'},
            timeout=30,
            follow_redirects=False,
        )
        response.raise_for_status()
        reply = agentstream_text(response.json())
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(502, 'AgentStream 호출에 실패했습니다.') from error
    if not reply:
        raise HTTPException(502, 'AgentStream 응답에서 답변 텍스트를 찾지 못했습니다.')
    return {'reply': reply, 'provider': 'agentstream'}


@app.get('/api/dispatch/config')
def config():
    return {'clientId':os.getenv('NCP_CLIENT_ID',''),'hqAddress':HQ_ADDRESS,'hqCoordinates':HQ_COORDINATES,'demo':True}

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
@app.get('/{filename}')
def public_file(filename:str):
    if filename not in PUBLIC:raise HTTPException(404)
    return FileResponse(PUBLIC[filename])
