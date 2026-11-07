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
- 상담·현장 기록: `/data/Documents/Codex/.runtime/fieldnote/data/records.sqlite3`
- 수리 사진·서명 이미지: `/data/Documents/Codex/.runtime/fieldnote/data/media/`
- 브라우저는 역할·선택 화면·전송 대기 캐시를 보관하며, 서버 저장 완료 후 다른 기기에서 공유

이전 브라우저 기록은 그 브라우저에서 서비스를 다시 열면 자동으로 이전됩니다.
접수별 버전 검사로 동시 수정 덮어쓰기를 막고, 상단에서 저장/오류/충돌 상태를
확인할 수 있습니다. 같은 주소에 접속하는 공유 데모 공간이며 서버 인증·권한 분리는
아직 구현하지 않았습니다. 자세한 저장·복구 절차는 [운영 안내](ops/README.md)를 확인하세요.

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

AgentStream은 서버에서 X-API-Key 인증으로 health 확인 → 세션 생성 → 메시지 스트리밍을 호출합니다. 실제 연결 설정은 `dispatch/.env`에만 둡니다.


## 누적 이력 엑셀 · 고객용 PDF (2026-11-08)

- 팀장 화면의 **누적 수리 이력 → 최신 누적 이력 엑셀 다운로드**: 서버의 전체 완료 기록을 `.xlsx`로 생성합니다. 기본 합성 고객 이력 뒤에 직접 접수하고 수리를 완료한 고객이 들어갑니다. 미완료·원격 종료는 제외하며 접수 ID로 중복을 방지합니다.
- `누적 수리 이력`, `사용 부품 상세`, `읽어 주세요` 시트로 나누고 금액은 계산 가능한 숫자로 저장합니다. 부품 단가는 공임 포함이며 별도 공임을 중복 합산하지 않습니다. 고객 입력을 엑셀 수식으로 실행하지 않습니다.
- 엔지니어 **현장 완료 보고 → 수리 완료 안내서 PDF**: 고객·제품·주소, 접수 증상, 점검·수리 결과, 부품 수량·비용, 출장비, 도착·완료 시각, 두 서명과 전후 최대 5장씩을 담습니다. 한글 글꼴을 포함한 A4 문서로 생성합니다. 합성 데모는 명시하고 없는 증빙은 지어내지 않습니다.
- 버튼은 서버 저장 완료를 기다립니다. 미저장·동시 수정 충돌 시 다운로드하지 않고 안내합니다. 파일은 매번 최신 서버 스냅샷에서 생성하며 **이미 다운로드한 파일 자체가 자동 변경되지는 않습니다**. 고객에게 자동 발송하지 않습니다.
- 원본 상담·수리 기록은 `/data/Documents/Codex/.runtime/fieldnote/data/records.sqlite3`, 사진·서명은 같은 폴더의 `media/`에 유지합니다. 파일 다운로드는 메모리에서 생성하므로 서버에 오래된 사본을 쌓지 않습니다. 휴대폰에 내려받은 파일은 해당 기기의 다운로드 목록/파일 앱에 저장됩니다.
- 기본 데모는 화면과 동일한 날짜 이동·배정·부품 기준으로 서버에서도 구성합니다. 실제 입력 기록은 SQLite의 전체 누적 이력을 사용하고, 같은 ID의 저장된 데모 수정본은 기본값보다 우선합니다. `report-demo-smoke.mjs`가 화면/내보내기 일치를 검증합니다.
- 상담사 AgentStream은 **as 상담사 전용 챗봇_3팀_김보경**, ID `9a6cceca-fe96-4054-864c-802b534e74ba`로 변경했습니다. 엔지니어 Help ID와 API 키는 유지합니다. 키는 `frontend/dispatch/.env`에만 둡니다.

PDF 서버 의존성 (Ubuntu, 기존 runit/8501 유지):

```bash
sudo apt-get install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-noto-cjk
/data/.venvs/2026-Yeosu-Hackathon/bin/pip install -r frontend/dispatch/requirements.txt
sudo sv -w 20 restart /etc/service/fieldnote
```

검증:

```bash
pip install -r frontend/dispatch/tests/requirements.txt
python -m unittest discover -s frontend/dispatch/tests -q
FIELDNOTE_PYTHON=/data/.venvs/2026-Yeosu-Hackathon/bin/python FIELDNOTE_QA_PACKAGE=/tmp/fieldnote-qa/package.json node --experimental-default-type=module frontend/tests/report-demo-smoke.mjs
```

`shared-records-smoke.mjs`는 3개 브라우저 컨텍스트의 상담→팀장 확정→기사 수리·서명과 모바일 PDF/엑셀 다운로드를 검증합니다. 명시적 `FIELDNOTE_E2E_WRITE=1`이 필요하며 출력된 테스트 ID만 정리해야 합니다. 실제 고객 기록을 일괄 삭제하면 안 됩니다. Chromium 화면 크기 검증은 실제 iOS 기기 검증을 대체하지 않습니다.


## 접수·최종 컨펌과 배차 한도의 구분

상담사 A/B/C의 접수와 팀장의 최종 컨펌에는 5건 제한이 없습니다. 시연용 현장 전달 담당자의 진행 중 업무가 5건이면 최종 컨펌은 저장하고 `배차 대기`로 유지합니다. 기사 일정이 비면 팀장 화면의 `배차 재시도`로 전달하며, 컨펌 시각은 보존합니다. 기사 배차 한도와 OR-Tools의 기사당 최대 5건 규칙은 유지합니다.
