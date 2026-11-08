# 환경 설정 예제

`.env.example`에는 설정 이름과 공개 기본값만 포함합니다.

```bash
mkdir -p frontend/dispatch
cp -n config/.env.example frontend/dispatch/.env
```

실제 API 키는 기존에 지정한 **frontend/dispatch/.env**에만 넣습니다. 새 server/app.py도 이 경로를 읽습니다. 이 로컬 폴더는 Git에서 제외되며 HTTP 공개 경로로 제공하지 않습니다. 이름 변경 때문에 키를 옮기거나 다시 발급할 필요는 없습니다.

SQLite·사진·서명 저장 경로의 기본값은 `/data/Documents/Codex/.runtime/fieldnote/data`이며, 다른 환경에서는 `FIELDNOTE_DATA_DIR`로 지정합니다.
