# 팀장 지도·배차 대시보드

저장소 루트에서 Python 3.11 이상으로 실행합니다.

```bash
python3 -m pip install -r frontend/dispatch/requirements.txt
cp -n frontend/dispatch/.env.example frontend/dispatch/.env
python3 -m uvicorn frontend.dispatch.app:app --host 0.0.0.0 --port 8501
```

`.env`에 제공된 `NCP_CLIENT_ID`, `NCP_CLIENT_SECRET`을 입력합니다. `MANAGER_PASSWORD=1234`로 시작합니다. `/`의 팀장 버튼을 누르고 비밀번호를 입력하면 대시보드 안에서 지도·방문 순서·실적을 볼 수 있습니다. `/dispatch/` 직접 접근도 같은 관리자 비밀번호를 요구합니다. 서버 재시작 시 세션이 초기화되므로 다시 로그인합니다. 주최 측 환경에서도 Python 정적 서버 대신 위 FastAPI 명령을 사용합니다.

## 지도 배경이 안 뜰 때: 현재 확인 결과와 조치

실제 키로 Geocoding과 Directions 호출은 성공했습니다. 그러나 실제 Chromium의 Web JS 지도 인증 요청은 HTTP 401로 거절되었습니다. 신·구 SDK 키 파라미터를 모두 확인했으며, 정적 지도도 별도 권한 거절을 받았습니다. 따라서 브라우저 지도 서비스 활성화·도메인 등록은 네이버 계정 소유자가 확인해야 합니다. API 키만으로 콘솔 설정을 변경하지는 않았습니다.

1. [네이버 클라우드 콘솔](https://console.ncloud.com/)에 해당 키를 발급한 계정으로 로그인합니다.
2. Services → Application Services → Maps → Application으로 이동합니다. 기존 앱이면 AI·NAVER API → Application에도 있을 수 있습니다. **현재 사용 중인 Client ID의 앱**을 선택합니다.
3. 앱 수정 화면에서 **Web Dynamic Map / Dynamic Map**을 체크합니다. Geocoding과 Directions 5도 유지합니다.
4. Web 서비스 URL은 **포트·경로 없이 호스트만** 등록합니다. 로컬은 `http://localhost`, `http://127.0.0.1`을 등록합니다. 주최 측 주소는 대표 도메인인 `http://jntp-ax.or.kr`을 등록합니다. `:51166`, `:8501`, `/dispatch/`, `/i/...`는 넣지 않습니다.
5. 저장 후 대시보드를 새로고침하고 로그인합니다. 지도 배경이 계속 없으면 콘솔의 선택 API·등록 URL 화면과 지도 오류 안내를 확인합니다. Secret을 캡처에 포함하지 않습니다.

네이버 공식 안내는 [인증 문제 해결](https://guide.ncloud-docs.com/docs/application-maps-troubleshoot), [Application 설정](https://guide.ncloud-docs.com/docs/application-maps-app-vpc), [SDK 인증](https://navermaps.github.io/maps.js.ncp/docs/tutorial-2-Getting-Started.html)을 참고합니다. 화면에도 현재 호스트에서 등록해야 할 URL을 표시합니다. 지도 인증에 실패하면 SVG 좌표도를 보여주며 주소별 네이버 지도 검색 링크로 실제 위치를 열 수 있습니다. 좌표도를 실제 지도 배경으로 표현하지 않습니다.

## 고정 본사와 복귀

- 본사: **전라남도 나주시 왕곡면 혁신산단6길 9**.
- 실제 Geocoding으로 확인한 고정 좌표: 경도 126.6928956, 위도 34.969903.
- 모든 기사의 초기 위치는 본사입니다. 배차 계산·예상시간·실제 도로 경로·대체 경로 모두 **본사 → 방문지들 → 본사**입니다.
- Directions 5의 출발/도착을 본사로 설정하고 방문지 1~5개 전부를 경유지로 보냅니다. 배정된 기사당 한 번 호출합니다. 방문이 없는 기사에게는 호출하지 않습니다.
- 실제 GPS를 수집하지 않으며 기사의 예정 목적지와 주소 기반 도착/서명/완료 기록을 구분해 표시합니다.

## 배차 규칙과 데이터

기사들은 모두 동일 역량이며 전문파트 제한은 없습니다. data/technicians.csv는 기사ID·이름만 필요합니다. 접수 CSV의 필요파트는 증상 참고 정보로만 남깁니다. 기사당 하루 최대5건, 긴급도 상/중/하의 차등 disjunction penalty, 보정 Haversine 거리×1.3·평균40km/h로 OR-Tools CVRP를 계산합니다. 본사 복귀 비용도 목적함수에 포함합니다. 2초 탐색 제한을 두므로 전역 최적해를 보장하지 않습니다. 동일한 비용의 기사끼리 고정 우선순위를 평가 점수로 사용하지 않습니다.

샘플은 고객 A/B/C를 섞은 합성접수20건·기사4명입니다. 오늘 이후 접수는 제외하고 미처리 과거 접수는 포함합니다. 전문파트 미일치로 미배정하지 않습니다. 총량/한도 때문에 빠지는 접수는 미배정 목록에 표시합니다. 추가 용량 검증은 테스트의 초과 접수를 사용합니다.

- Geocoding 성공은 SQLite(`.private/geocoding.sqlite`)에 캐싱합니다. 본사는 검증된 고정 좌표도 보관합니다.
- 실패 주소는 주소 확인 목록에 남깁니다. 명시적인 DEMO-ID에만 합성 시연 좌표를 허용하며 실제 입력 주소는 좌표를 지어내지 않고 배차에서 제외합니다.
- 도로 API 실패는 본사 복귀를 포함한 보정 직선 경로로 대체합니다. 화면에 대체 경로를 명시합니다.
- 브라우저 지도에 필요한 공개 Client ID만 config로 전달하고 Client Secret·.env·CSV·캐시·Python 소스는 HTTP로 제공하지 않습니다.

## 관리자와 평가 참고

서버의 비밀번호 검증 후 난수 HttpOnly·SameSite 쿠키를 발급합니다. 관리자 API는 비인증 상태에서 401이며 로그아웃·8시간 만료·서버 재시작 후 재인증합니다. 비밀번호는 서버 .env에서 읽습니다. 단순 해커톤용 관리자 비밀번호이며 사용자별 계정/권한 시스템은 아닙니다. 설정값 1234는 사용자 요청에 따른 시연용 비밀번호입니다.

메인 팀장 화면은 상담·현장 실적 KPI → 통합 지도·기사별 예정 방문 → 기사별 업무 실적표 → 완료 수리/증빙 관리 순서입니다. 실적표는 오늘/7일/30일을 선택하며 완료건수, 도착~최종서명 현장 경과시간, 시간 누락 수, 견적 기준 청구액, 수리 동의/최종 서명 수, 전후 사진 기록 수와 근거 접수를 확인할 수 있습니다. 기간을 바꿔도 지도 결과는 유지합니다.

자동 점수·순위·연봉을 산출하지 않습니다. 현장 시간은 대기·점검·수리를 포함하고, 수금액·고객 만족도·재수리율·난이도 정보는 아직 수집하지 않습니다. 기록이 없으면 누락/미수집으로 표시합니다. 실적표는 브라우저에 저장된 완료 기록을 근거로 하며 CSV 예정 배차를 완료 실적으로 집계하지 않습니다. CSV 배차 입력과 브라우저 상담 기록은 아직 별도 저장소입니다.

## 단계별 확인

관리자 로그인 후 `/docs` 또는 클라이언트에서 같은 쿠키로 호출합니다.

1. `POST /api/dispatch/geocode` → 주소·캐시 확인, runId.
2. `POST /api/dispatch/plan/{runId}` → 외부 API 호출 없는 동일 기사 CVRP.
3. `POST /api/dispatch/directions/{runId}` → 기사당 한번 본사 복귀 도로 경로. 같은 runId 재요청은 저장된 결과를 재사용합니다.
4. `/dispatch/` 또는 메인 팀장 대시보드 iframe → 지도·주소·방문순서 표시.

전체 실행은 `POST /api/dispatch/run`입니다. 인증은 `POST /api/manager/login` (password 필드), `GET /api/manager/session`, `POST /api/manager/logout`입니다. 설정/배차 API는 서버에서 관리자 세션을 확인합니다. 브라우저에 저장된 상담 데이터 자체의 기기 간 보안·동기화는 별도 과제입니다.

검증 명령: `python3 -m unittest discover -s frontend/dispatch/tests -v`. 여기에 본사 복귀, 비밀번호/세션/로그아웃, 비인증 API 차단, 동일 역량 기사·긴급도·하루5건, 캐시와 실패 대체를 포함합니다. 기존 JavaScript/DOM 테스트와 실제 Chromium 로그인·대시보드 배치 확인도 수행합니다. AgentStream은 호출 URL/에이전트 명세가 아직 없어 미연결입니다.
