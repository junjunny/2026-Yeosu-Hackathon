# Fieldnote · 농기계 AS 현장 서비스 데스크

상담 접수 → 팀장 우선순위 검토 → 배차 계획 → 현장 점검·견적·서명 → 수리 완료까지 연결하는 해커톤 프로토타입입니다.

## 바로 체험하기

- [공개 배포 서비스](https://devopen-gpu.jntp-ax.or.kr/i/XUYja4vr7_KF-hZ5/)
- 별도 계정 없이 상담사·팀장·엔지니어 역할을 선택합니다. 팀장 화면의 **체험용 비밀번호는 `1234`**이며 화면에도 안내됩니다. 실제 계정 비밀번호가 아닙니다.
- 새 상담 → 통화 종료와 ERP 확인 → 팀장 우선순위 확정·최종 컨펌 → 엔지니어 현장 작업 순서로 체험합니다.
- 입력칸을 선택하면 시연용 보기를 사용할 수 있습니다. 오늘 접수와 오늘 수리 예약은 구분됩니다.
- 모든 방문자가 같은 데모 공간을 공유합니다. 시크릿 창에서도 저장된 기록을 볼 수 있습니다. **합성 정보만 입력하고 실제 고객 정보·사진·서명은 넣지 마세요.**

## 주요 기능

- AgentStream 상담 챗봇과 작업 화면 안의 엔지니어 Help
- OR-Tools 배차 계산 및 네이버 지도: 보정 직선거리로 순서를 계산하고 도로 경로 조회, 실패 시 대체 경로 표시
- 모바일 체크리스트, 전후 사진 각 5장, 견적과 두 차례 고객 서명
- 최신 누적 수리 이력 Excel과 고객용 PDF 다운로드. 사내 비고는 Excel에만 포함
- SQLite와 서버 이미지 파일을 통한 기기 간 기록 공유

## 실행

Python 3.12 기준, 저장소 루트에서 실행합니다. PDF 생성에는 Ubuntu의 Pango 라이브러리와 한글 글꼴이 필요합니다.

```bash
sudo apt-get install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-noto-cjk
python3 -m venv .venv
source .venv/bin/activate
pip install -r frontend/dispatch/requirements.txt
cp -n frontend/dispatch/.env.example frontend/dispatch/.env
# 외부 API 키는 frontend/dispatch/.env에만 입력
uvicorn frontend.dispatch.app:app --host 0.0.0.0 --port 8501
```

브라우저에서 `http://localhost:8501/`을 엽니다. API 키가 없으면 챗봇 연결 오류가 표시되고 지도는 대체 경로를 사용합니다.

- 기록 기본 경로: `/data/Documents/Codex/.runtime/fieldnote/data/records.sqlite3`
- 사진·서명: 같은 폴더의 `media/`
- 다른 환경에서는 `.env`의 `FIELDNOTE_DATA_DIR`로 쓰기 가능한 데이터 폴더를 지정합니다.
- 서버 사용자 인증·권한 분리는 아직 구현하지 않은 공개 합성 데이터 데모입니다.

[상세 실행·검증 안내](frontend/README.md) · [8501 서비스 운영·복구](frontend/ops/README.md)

## 구조

- `frontend/`: HTML·CSS·Vanilla JavaScript 화면
- `frontend/dispatch/`: 현재 배포에 사용하는 FastAPI, 기록 저장, 배차, 보고서 API
- `backend/`: 팀 공동 작업 영역
