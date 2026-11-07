# Fieldnote 해커톤 데모

상담사 접수부터 농기계 AS 기사 배차, 현장 완료까지 한 화면에서 시연하는 프런트엔드 중심 프로토타입입니다. 브라우저 UI는 빌드 없는 HTML/CSS/JavaScript이고, 비밀키 보호와 배차 계산을 위한 FastAPI 코드도 `frontend/dispatch/` 안에 둡니다.

## 실행

현재 원격 호스트의 8501 배포는 세션과 독립된 runit 서비스로 실행합니다.
상태 확인·재시작·호스트 복구 절차는 [서비스 운영 안내](ops/README.md)를 따릅니다.
아래 명령은 로컬 개발용이며, 운영 중인 8501 서비스와 중복 실행하지 않습니다.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r frontend/dispatch/requirements.txt && cp -n frontend/dispatch/.env.example frontend/dispatch/.env
uvicorn frontend.dispatch.app:app --host 0.0.0.0 --port 8501
```

- 상담·현장 화면: `http://localhost:8501/`
- 배차 지도: `http://localhost:8501/dispatch/`
- 공개 데모: `https://devopen-gpu.jntp-ax.or.kr/i/XUYja4vr7_KF-hZ5/`
- 환경 변수와 단계별 API: [dispatch/README.md](dispatch/README.md)

## 구현 흐름

1. 상담사가 고객 요청을 원문에 가깝게 채팅합니다.
2. 브라우저가 `/api/agentstream/chat`을 호출하고 FastAPI가 `.env`의 AgentStream 키로 외부 요청을 보냅니다.
3. 통화 종료 전 ERP 정보와 방문 요청·주행 불가·자가조치 희망을 확정합니다.
4. 팀장 화면에서 오늘 접수 상담을 검토·우선순위 확정한 뒤 배차합니다. 엔지니어 A/B/C는 동일한 통합 역량입니다.
5. Geocoding → OR-Tools → 기사별 Directions 5 1회 → 지도 표시 순서로 처리합니다.
6. 기사는 체크리스트, 수리 전후 사진, 부품 견적, 수리 동의와 최종 서명을 기록합니다.

배차 계산은 Haversine×1.3과 평균 40km/h를 사용합니다. 기사당 최대 5건이고 긴급 건에 더 높은 미배정 penalty를 적용합니다. 모든 기사는 본점에서 출발하며 마지막 방문지에서 경로가 끝납니다. 전문 파트가 없거나 주소를 확인하지 못한 건은 별도 목록에 표시합니다.

## 데이터와 보안

- 지도 입력: `dispatch/data/as_requests.csv`(오늘 수리 예약 12건), `dispatch/data/technicians.csv`(엔지니어 3명)
- 팀장 데모 고객: `data/farmingboy_customers_100.json`(최근 30일 100명)
- 주소 캐시: `dispatch/.private/geocoding.sqlite`
- 비밀키: `dispatch/.env`에만 저장하며 Git과 HTTP 공개 경로에서 제외
- 공개 저장소에는 `.env.example`만 포함
- 상담·현장 기록은 현재 같은 브라우저의 `localStorage`에 저장

제공된 키를 코드, README, 테스트, 커밋에 넣지 마세요. 외부 API가 실패하면 지도는 `대체 경로` 점선으로 계속 동작합니다.

팀장 데모 비밀번호는 `1234`입니다. 오늘 접수 고객은 오늘 수리 예약과 분리되어 있으며, 현재 데모는 오늘 예약 12명 중 7명 완료·5명 예정으로 시드됩니다.

## 검증

새 상담은 작업 영역 중앙에 표시합니다. 900px 이하에서는 오늘 접수/담당 현장 목록을
펼쳐 선택하고, 1200px 이하의 Help는 현재 작업을 보존하는 화면 내 패널로 엽니다.
넓은 화면에서는 작업과 Help를 나란히 표시합니다.

반응형 브라우저 검증은 실행 중인 8501 서비스와 Node 22+, Playwright를 사용합니다.
`FIELDNOTE_QA_PACKAGE`는 Playwright가 설치된 프로젝트의 `package.json` 경로입니다.
실제 모바일 기기의 키보드 동작은 별도 확인 대상이며, 아래 검증은 Chromium의
320/390/768/1024/1440/1920px 화면과 축소된 뷰포트에서 실행합니다.

```bash
FIELDNOTE_QA_PACKAGE=/path/to/qa/package.json node --experimental-default-type=module frontend/tests/responsive-smoke.mjs
```

```bash
python3 -m unittest discover -s frontend/dispatch/tests -v
node frontend/tests/workflow.test.mjs
node --check frontend/app.js && node --check frontend/services.js
```

AgentStream의 실제 호출 URL과 정확한 요청/응답 계약은 주최 측 설정값을 `.env`에 입력해 최종 확인해야 합니다. 현재 프록시는 `message`, `conversation_id`, `history` JSON과 Bearer 인증을 기본 계약으로 사용합니다.
