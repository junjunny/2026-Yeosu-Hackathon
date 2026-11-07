# 작업 인계 · 2026-11-07

## 현재 기준

- 작업 브랜치: `codex/dispatch-route-prototype`
- 수정 범위: `frontend/`만 사용
- 로그인 없이 실행하는 2일 해커톤용 최소 데모
- 실행 서버: `frontend.dispatch.app:app`

## 구현됨

- 상담사 메시지 → FastAPI `/api/agentstream/chat` → AgentStream 서버 호출 구조
- AgentStream 키와 네이버 Client Secret을 `.env`에서만 읽는 구조
- 합성 접수 20건과 전문 파트가 다른 기사 4명
- Geocoding, SQLite 캐시, 주소 오류 목록
- 전문 파트 일치, 기사당 최대 5건, 긴급도 penalty를 반영한 OR-Tools CVRP
- Haversine×1.3, 평균 40km/h 기반 계산
- 배차 확정 후 기사당 Directions 5 한 번 호출
- 본점 출발 후 마지막 방문지 종료
- 지도 마커·기사별 경로·순서 카드·미배정 목록
- 모든 외부 호출 실패 시 직선 `대체 경로`
- 상담사 → 팀장 → 엔지니어 현장 완료 흐름과 견적·사진·두 차례 서명

## 연결 전 확인

- `.env`의 `AGENTSTREAM_URL`: 키만 제공되어 실제 호출 URL은 아직 확인되지 않음
- AgentStream 요청/응답 계약: 현재 `message`, `conversation_id`, `history`와 Bearer 인증을 기본값으로 사용
- 네이버 지도 Web Dynamic Map의 현재 접속 호스트 등록
- 실제 회사 고객·접수 데이터와 브라우저 상담 기록의 서버 저장

공개 저장소에는 합성 데이터만 사용합니다. `.env`와 `dispatch/.private/`는 Git에서 제외됩니다.
