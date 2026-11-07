# Fieldnote 배차·지도 데모

저장소 루트에서 실행합니다. Python 3.11 이상을 사용하세요.

```bash
python3 -m pip install -r frontend/dispatch/requirements.txt
cp frontend/dispatch/.env.example frontend/dispatch/.env
python3 -m uvicorn frontend.dispatch.app:app --host 0.0.0.0 --port 8501
```

브라우저에서 `http://127.0.0.1:8501/dispatch/`를 엽니다. `/`는 기존 상담 화면입니다. 주최 측 컨테이너에서 실행하면 서비스 URL 뒤에 `dispatch/`를 붙여 접속합니다. `python -m http.server`로는 배차 API가 실행되지 않습니다.

`.env`에 전달받은 지도 ID/Secret을 각각 `NCP_CLIENT_ID`, `NCP_CLIENT_SECRET`으로 입력합니다. 키는 커밋하지 않습니다. `.env`와 캐시는 HTTP로 제공하지 않습니다. Web JS 지도는 Client ID가 필요하므로 config API는 **ID만** 공개하며 Secret은 서버에만 있습니다. 네이버 콘솔에서 Geocoding, Directions 5, Web Dynamic Map을 활성화하고 로컬/주최 측 웹 URL을 등록해야 합니다. 구형 앱 키라면 NCP_MAPS_HOST를 `naveropenapi.apigw.ntruss.com`으로 설정할 수 있습니다.

단계별 엔드포인트는 `/docs`에서 실행할 수 있습니다.

1. `POST /api/dispatch/geocode` → 본점·고객 주소 좌표화, SQLite 캐시, `runId` 반환.
2. `POST /api/dispatch/plan/{runId}` → API 호출 없이 보정 Haversine 거리/40km/h 시간 행렬로 OR-Tools CVRP 계산.
3. `POST /api/dispatch/directions/{runId}` → 확정 방문 순서로 기사당 최대 1회 Directions. 같은 실행의 재요청은 결과 재사용.
4. `/dispatch/` → 기사별 색상/번호 마커·경로선, 미배정·주소 오류 표시.

한 번에 `POST /api/dispatch/run`도 가능합니다. 데이터 입력은 data/as_requests.csv, data/technicians.csv입니다. 전문파트 여러 개는 `구동|전장`처럼 구분합니다. 기사 수는 CSV 행 수로 결정됩니다. 일일 한도는 5건 이하입니다. 긴급도 상/중/하에 차등 disjunction penalty를 사용하며 파트 미일치·한도 초과는 미배정입니다. 더미 종료점을 사용해 복귀 비용을 0으로 둡니다. Directions의 경유지는 마지막 방문지를 제외한 최대 4개이며 도착은 마지막 방문지입니다.

샘플은 고객 A/B/C가 섞인 접수 20건·기사 4명·의도적인 미지원 유압 사례를 포함합니다. 데이터는 합성이며 실제 고객/서비스 위치가 아닙니다. 기본 본점은 나주시청 주소를 이용한 시연 설정입니다. 환경변수 HQ_ADDRESS를 실제 본점 주소로 바꾸세요. 키/주소 조회가 실패하면 샘플 ID만 data/demo_coordinates.json의 합성 좌표를 쓰고 주소 확인 목록에도 남깁니다. 실제 입력 주소가 실패하면 좌표를 지어내지 않고 배차에서 제외합니다. 본점 조회 실패 시 기본 시연 본점에만 합성 좌표를 허용합니다. 다른 본점이 실패하면 주소 수정 전까지 배차하지 않습니다.

도로 API 실패는 보정 직선 경로로 대체하고, 지도 JS 실패/키 미설정은 SVG 좌표도로 대신 표시합니다. 지도 API의 도로 정보는 일반 자동차 기준이며 농기계 통행 가능성을 보장하지 않습니다. 표시 시간은 이동 시간만 포함합니다. 날짜가 오늘 이후인 접수는 제외하고 미처리 과거 접수는 포함합니다. OR-Tools에는 2초 탐색 제한을 두며 전역 최적해를 보장하지 않습니다.

현재 로그인 없는 해커톤 데모이며 공개 시 합성 데이터만 사용합니다. API 키가 있는 서버는 공개 접근에 대한 사용량 제한/권한을 실제 운영 전 별도로 적용해야 합니다. 상담 RAG/AgentStream은 별개이며 아직 호출 URL·에이전트 ID·요청 명세가 없어 연결하지 않았습니다.

검증: `python3 -m unittest discover -s frontend/dispatch/tests -v`.

실제 연결 확인: 제공된 키로 나주시청 주소 Geocoding 성공을 확인했습니다. 지도 SDK의 브라우저 도메인 등록은 이 테스트와 별개입니다. 키는 이 작업 환경의 로컬 .env에만 있으며 Git으로 받는 다른 PC에는 자동 전송되지 않습니다. 해당 PC의 .env에도 별도로 설정하세요.

- 실제 Directions 5도 공개 주소 간 1회 호출로 성공했습니다 (도로 경로선·거리·밀리초→초 변환 확인). 브라우저 지도 SDK 렌더링과는 별도 검증입니다.

공식 명세: [네이버 Geocoding](https://api.ncloud-docs.com/docs/en/application-maps-geocoding), [Directions 5](https://api.ncloud-docs.com/docs/en/application-maps-directions5), [Web JS 지도](https://navermaps.github.io/maps.js.ncp/docs/tutorial-2-Getting-Started.html), [OR-Tools CVRP](https://developers.google.com/optimization/routing/cvrp), [미방문 패널티](https://developers.google.com/optimization/routing/penalties).
