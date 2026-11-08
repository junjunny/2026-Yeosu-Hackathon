> 이 문서는 11월 7일 초기 인계 기록입니다. 아래 커밋·데모 수치·연결 전 항목은 과거 상태입니다.
> 현재 서비스 실행·데이터 저장·기능은 [README](README.md), 최종 검증은 [제출 점검 기록](docs/submission-check.md)을 기준으로 확인하세요.

# 작업 인계 · 2026-11-07

## 현재 기준

- 작업 브랜치: `codex/dispatch-route-prototype`
- `main`과 위 브랜치는 커밋 `5451c0f`에서 동일
- 수정 범위: `frontend/`만 사용
- 로그인 없이 실행하는 2일 해커톤용 최소 데모
- 실행 서버: `frontend.dispatch.app:app`

## 구현됨

- 상담사 메시지 → FastAPI `/api/agentstream/chat` → AgentStream 서버 호출 구조
- AgentStream 키와 네이버 Client Secret을 `.env`에서만 읽는 구조
- `data/farmingboy_customers_100.json` 기반 최근 30일 고객 100명
- 오늘 접수 6명은 왼쪽 목록과 팀장 상담 요약에만 표시하며 오늘 수리로 자동 배정하지 않음
- 완료 이력 88건은 엔지니어 A/B/C에게 배정하고, 오늘 예약 12건은 7건 완료·5건 예정으로 표시
- 엔지니어 A/B/C는 모두 통합 역량이며, 배차는 전문 파트가 아닌 거리·시간 효율만 최적화
- Geocoding, SQLite 캐시, 주소 오류 목록
- 기사당 최대 5건, 긴급도 penalty를 반영한 OR-Tools CVRP
- Haversine×1.3, 평균 40km/h 기반 계산
- 배차 확정 후 기사당 Directions 5 한 번 호출
- 본점 출발 후 마지막 방문지 종료
- 지도 마커·기사별 경로·순서 카드·미배정 목록
- 모든 외부 호출 실패 시 직선 `대체 경로`
- 상담사 → 팀장 → 엔지니어 현장 완료 흐름과 견적·사진·두 차례 서명
- 팀장 화면 비밀번호 데모값은 `1234`이며, 상담 완료 건은 팀장 확인/배차 대기 목록에 쌓임
- 오늘 접수 상담 요약에서 우선순위(상·중·하)를 팀장이 확인·확정
- 배차 지도 입력은 12건·엔지니어 3명이며, Directions 5 실제 도로 경로를 우선 사용

## 연결 전 확인

- `.env`의 `AGENTSTREAM_BASE_URL`, `AGENTSTREAM_CHATBOT_ID`, `AGENTSTREAM_API_KEY`로 AgentStream 공개 API를 설정
- AgentStream 요청/응답 계약: health → 세션 생성 → 세션 messages 순서, `X-API-Key` 인증, NDJSON 스트리밍
- 네이버 지도 Web Dynamic Map의 현재 접속 호스트 등록
- 실제 회사 고객·접수 데이터와 브라우저 상담 기록의 서버 저장

공개 저장소에는 합성 데이터만 사용합니다. `.env`와 `dispatch/.private/`는 Git에서 제외됩니다.

## 이어서 작업할 때

1. `git clone` 후 `main`을 기준으로 작업합니다. 현재 최신 커밋은 `5451c0f`입니다.
2. `frontend/dispatch/.env.example`을 복사해 `.env`를 만들고 실제 키는 새 계정의 환경에서 입력합니다.
3. `uvicorn frontend.dispatch.app:app --host 0.0.0.0 --port 8501`로 실행합니다.
4. 공개 데모 주소는 `https://devopen-gpu.jntp-ax.or.kr/i/XUYja4vr7_KF-hZ5/`입니다.
5. 브라우저가 `oapi.map.naver.com`을 차단하면 네이버 SDK 대신 Directions 좌표 기반 `대체 경로`가 표시됩니다. 서버 API 자체는 12건·3기사·주소 오류 0건으로 확인된 상태입니다.
