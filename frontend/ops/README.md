# 8501 상시 서비스

현재 호스트는 systemd 대신 `my_init` + runit을 사용합니다. 실행 도구의 터미널에
uvicorn을 연결하면 해당 세션이 끝날 때 서버도 종료될 수 있으므로, runit의
`fieldnote` 서비스로 실행합니다. uvicorn이 종료되면 runit이 자동 재시작합니다.

- 저장소 및 실행 위치: `/data/Documents/Codex/2026-11-07/2026-Yeosu-Hackathon`
- 리슨 주소: `0.0.0.0:8501`
- 비밀키: 저장소 내 `frontend/dispatch/.env` (Git 제외)
- 서버 로그: `/data/Documents/Codex/.runtime/fieldnote/logs` (저장소 외부, 자동 순환)
- 실행 계정: `ubuntu`
- 공개 주소: https://devopen-gpu.jntp-ax.or.kr/i/XUYja4vr7_KF-hZ5/

브라우저 상담·사진·서명은 기존처럼 각 브라우저의 localStorage에 보관됩니다.
서비스 재시작은 브라우저 데이터를 초기화하지 않습니다.

## 최초 등록 / 호스트 재생성 후 복구

아래는 현재 호스트 경로 기준입니다. 먼저 같은 포트의 수동 uvicorn이 없는지 확인하고,
가상환경과 `.env`가 존재하는 상태에서 저장소 루트에서 실행합니다.
다른 프로세스가 8501을 사용하면 해당 프로세스를 확인한 후 전환하세요.

```sh
sudo install -d -m 755 /etc/sv/fieldnote/log
sudo install -d -o ubuntu -g ubuntu -m 700 /data/Documents/Codex/.runtime/fieldnote/logs
sudo install -m 755 frontend/ops/runit/run /etc/sv/fieldnote/run
sudo install -m 755 frontend/ops/runit/log/run /etc/sv/fieldnote/log/run
sudo ln -s /etc/sv/fieldnote /etc/service/fieldnote
```

마지막 링크 등록은 최초 한 번만 수행합니다. runit이 새 서비스를 인식하면 자동으로
시작합니다. 컨테이너 자체가 삭제·재생성된 경우에는 `/etc`의 서비스 등록도 다시
필요합니다. 파일과 로그는 `/data/Documents/Codex` 아래에 유지합니다.

## 운영 확인

```sh
sudo sv status /etc/service/fieldnote
sudo sv -w 20 restart /etc/service/fieldnote
curl --fail http://127.0.0.1:8501/ -o /dev/null
curl --fail https://devopen-gpu.jntp-ax.or.kr/i/XUYja4vr7_KF-hZ5/ -o /dev/null
```

프런트엔드 정적 파일 수정은 즉시 반영됩니다. Python 서버 코드를 수정하면 위의
restart 명령으로 적용합니다. 같은 포트에 별도 uvicorn을 중복 실행하지 않습니다.
