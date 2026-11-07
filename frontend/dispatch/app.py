import csv
import json
import os
import uuid
import secrets
import hmac
import time
from collections import defaultdict
from urllib.parse import urlparse
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.responses import FileResponse
from threading import Lock
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
from .maps import Maps, fallback_route
from .routing import solve

app = FastAPI(title='Fieldnote 배차 데모')
runs = {}
run_lock = Lock()
mapper = Maps()
HQ_ADDRESS = '전라남도 나주시 왕곡면 혁신산단6길 9'
HQ_COORDINATES = [126.6928956, 34.969903]
sessions = {}
login_attempts = defaultdict(list)

def session_for(request):
    token=request.cookies.get('fieldnote_manager', '')
    if sessions.get(token, 0) <= time.time():
        sessions.pop(token, None)
        return False
    return True

def require_manager(request: Request):
    if not session_for(request):
        raise HTTPException(401, '관리자 비밀번호로 로그인해 주세요.')

class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=128)

@app.post('/api/manager/login')
def manager_login(body: LoginBody, request: Request, response: Response):
    origin=request.headers.get('origin')
    if request.headers.get('sec-fetch-site')=='cross-site':
        raise HTTPException(403, '같은 사이트에서 로그인해 주세요.')
    if origin and urlparse(origin).netloc not in {request.headers.get('host'), request.headers.get('x-forwarded-host')}:
        raise HTTPException(403, '접속 주소를 확인해 주세요.')
    ip=request.client.host if request.client else 'unknown'
    now=time.time()
    login_attempts[ip]=[stamp for stamp in login_attempts[ip] if now-stamp<60]
    if len(login_attempts[ip])>=5:raise HTTPException(429,'1분 후 다시 시도해 주세요.')
    configured=os.getenv('MANAGER_PASSWORD','')
    if not configured:raise HTTPException(503,'서버 관리자 비밀번호를 설정해 주세요.')
    login_attempts[ip].append(now)
    if not hmac.compare_digest(body.password.encode(), configured.encode()):raise HTTPException(401,'관리자 비밀번호가 맞지 않습니다.')
    login_attempts[ip]=[]
    for token,expiry in list(sessions.items()):
        if expiry<=now:sessions.pop(token,None)
    token=secrets.token_urlsafe(32)
    sessions[token]=now+8*3600
    response.set_cookie('fieldnote_manager',token,httponly=True,samesite='strict',max_age=8*3600,secure=request.url.scheme=='https')
    return {'authenticated':True,'role':'manager'}

@app.get('/api/manager/session')
def manager_session(request: Request):
    return {'authenticated':session_for(request),'role':'manager' if session_for(request) else None}

@app.post('/api/manager/logout')
def manager_logout(request: Request,response: Response):
    sessions.pop(request.cookies.get('fieldnote_manager',''),None)
    response.delete_cookie('fieldnote_manager')
    return {'authenticated':False}



def load_data():
    with (ROOT/'data/as_requests.csv').open(encoding='utf-8-sig') as file:
        rows = list(csv.DictReader(file))
    with (ROOT/'data/technicians.csv').open(encoding='utf-8-sig') as file:
        techs = list(csv.DictReader(file))
    if len(rows)>100 or len(techs)>20:
        raise HTTPException(422, '접수 100건·기사 20명 이하로 입력해 주세요.')
    today = datetime.now(ZoneInfo('Asia/Seoul')).date().isoformat()
    jobs = [{'id':r['접수ID'], 'date':r['접수일'], 'address':r['주소'], 'model':r['모델'], 'symptom':r['증상(고객 말)'], 'requiredPart':r['필요파트'], 'priority':{'상':'high','중':'normal','하':'low'}.get(r['긴급도'],'normal')} for r in rows if r['접수일']<=today]
    technicians = [{'id':t['기사ID'], 'name':t['이름'], 'specialties':[]} for t in techs]
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
        headquarters.update(coordinates=HQ_COORDINATES,fallback=False)
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


@app.get('/api/dispatch/config')
def config(authorized=Depends(require_manager)):
    return {'clientId':os.getenv('NCP_CLIENT_ID',''),'hqAddress':HQ_ADDRESS,'hqCoordinates':HQ_COORDINATES,'demo':True}

@app.post('/api/dispatch/geocode')
def geocode_api(authorized=Depends(require_manager)):
    data=geocode_stage();ident=uuid.uuid4().hex
    if len(runs)>=32:runs.pop(next(iter(runs)))
    runs[ident]=data
    return {**data,'runId':ident,'stage':'geocoded'}


def run(ident):
    if ident not in runs:raise HTTPException(404,'새 배차를 실행해 주세요.')
    return runs[ident]

@app.post('/api/dispatch/plan/{ident}')
def plan_api(ident:str, authorized=Depends(require_manager)):
    with run_lock:
        data=run(ident)
        if data.get('stage') not in ('planned','finished'):runs[ident]=plan_stage(data)
        return {**runs[ident],'runId':ident}

@app.post('/api/dispatch/directions/{ident}')
def directions_api(ident:str, authorized=Depends(require_manager)):
    with run_lock:
        runs[ident]=directions_stage(run(ident))
        return {**runs[ident],'runId':ident}

@app.post('/api/dispatch/run')
def full_pipeline(authorized=Depends(require_manager)):
    return directions_stage(plan_stage(geocode_stage()))

@app.get('/dispatch/')
def dispatch_page(request: Request):return FileResponse(ROOT/('index.html' if session_for(request) else 'login.html'))

@app.get('/')
def fieldnote():return FileResponse(ROOT.parent/'index.html')

# An explicit file allowlist prevents .env, Python source, CSV and caches being served.
PUBLIC={p.name:p for p in ROOT.parent.iterdir() if p.suffix in ('.js','.css') and p.is_file()}
@app.get('/{filename}')
def public_file(filename:str):
    if filename not in PUBLIC:raise HTTPException(404)
    return FileResponse(PUBLIC[filename])
