# 농기계 AS 기사 배차·동선 데모

FastAPI가 CSV 접수를 Geocoding하고, 동일한 통합 역량의 기사에게 OR-Tools CVRP로 배정한 뒤 기사별로 Directions 5를 한 번 호출합니다. 모든 기사는 본점에서 출발하며 마지막 방문지에서 경로가 끝납니다.

## 실행 3줄

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r server/requirements.txt
mkdir -p frontend/dispatch
cp -n config/.env.example frontend/dispatch/.env
uvicorn server.app:app --host 0.0.0.0 --port 8501
```

`.env`에 `NCP_CLIENT_ID`, `NCP_CLIENT_SECRET`을 넣고 `http://localhost:8501/dispatch/`를 엽니다. 네이버 지도 Web 서비스 URL에는 실제 접속 호스트를 등록해야 합니다. 키가 없거나 외부 호출이 실패해도 합성 좌표와 직선 경로로 전체 데모가 계속 동작합니다.

상담사 AgentStream 연결에는 `AGENTSTREAM_BASE_URL`, `AGENTSTREAM_CHATBOT_ID`, `AGENTSTREAM_API_KEY`를 설정합니다. 서버가 health 확인 → 세션 생성 → 세션 메시지 스트림 순서로 호출하고 `X-API-Key`를 외부 요청에만 보냅니다. 브라우저에는 키를 내려보내지 않으며, 방문자 쿠키와 접수 ID별로 AgentStream 세션을 격리합니다. `.env`는 Git에 커밋하지 마세요.

## 입력

- `data/as_requests.csv`: `접수ID, 접수일, 주소, 모델, 증상(고객 말), 필요파트, 긴급도`
- `data/technicians.csv`: `기사ID, 이름, 전문파트`
- 전문파트 열은 기존 형식 호환용이며 배차 제약에 사용하지 않습니다.
- 기본 입력은 합성 방문 예약 12건과 엔지니어 A/B/C 3명입니다. 팀장 화면은 내일 방문 대상의 배차 계획을 별도로 구성합니다.

## 단계별 API

1. `POST /api/dispatch/geocode` — 주소→좌표, SQLite 캐시, 주소 오류 수집
2. `POST /api/dispatch/plan/{runId}` — Haversine×1.3, 40km/h 행렬과 OR-Tools 배차
3. `POST /api/dispatch/directions/{runId}` — 기사별 최대 1회 Directions 5 호출
4. 브라우저 지도 표시 — 실제 도로선 또는 `대체 경로` 점선

전체 실행은 `POST /api/dispatch/run`입니다. 상담 채팅은 `POST /api/agentstream/chat`을 사용합니다.

## AgentStream 스트리밍

`POST /api/agentstream/chat`은 AgentStream의 NDJSON을 브라우저로 전달합니다. 프런트는 UTF-8 청크 경계와 여러 JSON 줄을 안전하게 처리하고 `assistant.delta`만 답변으로 합칩니다. `thinking`, `reasoning`, `tool` 블록은 표시하지 않으며 `turn.completed`가 없는 종료, 실패 이벤트, 잘못된 JSON, 취소·타임아웃을 오류로 표시합니다.

## 검증

```bash
python3 -m unittest discover -s tests/server -v
node --experimental-default-type=module --check web/app.js && node --experimental-default-type=module --check web/services.js
```

`.env`, Geocoding SQLite 캐시, Python 소스, CSV는 FastAPI의 공개 파일 경로에서 제공하지 않습니다.


## 완료 기록 내보내기

- `GET /api/reports/repairs.xlsx`: 최신 서버 완료 이력과 기본 합성 이력을 합친 실제 Excel 통합 문서.
- `GET /api/reports/repairs/{case_id}.pdf`: 저장된 완료 고객의 안내서. 미완료/없는 ID는 404.
- 응답은 `Cache-Control: private, no-store`와 UTF-8 다운로드 파일명을 사용합니다.
- PDF는 저장소의 해시 파일명 이미지와 명시적으로 허용한 합성 증빙만 읽습니다. 입력된 외부 URL·로컬 경로를 따라가지 않습니다.
- 이 프로젝트의 로그인 없는 공유 데모 접근 방식은 그대로입니다. 문서 다운로드가 별도의 실제 운영 권한 체계를 제공하지는 않습니다.
- 설치/사용/저장 경로는 상위 README의 누적 이력 엑셀·고객용 PDF 안내를 따릅니다.
