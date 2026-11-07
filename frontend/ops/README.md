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

상담·현장 기록은 `/data/Documents/Codex/.runtime/fieldnote/data/records.sqlite3`에,
사진·서명은 같은 폴더의 `media/`에 저장됩니다. 기록은 같은 서비스 주소를 사용하는
기기 사이에서 공유되며 3초마다 변경을 확인합니다. 역할·선택 화면과 전송 대기 캐시는
브라우저 localStorage에 남지만, 저장 완료된 기록의 기준은 서버입니다.

기존 브라우저 기록은 해당 브라우저에서 새 버전 서비스를 열면 자동으로 이전됩니다.
다른 기기가 먼저 저장한 동일 ID는 덮어쓰지 않고, 다른 이전 사본은 SQLite의
`legacy_archive` 테이블에 보관합니다. `records`는 접수별 버전으로 동시 수정을
감지합니다. 실패/충돌 시 상단 안내를 확인하고, 저장 완료 표시 전에는 창을 닫지 않습니다.
매일 생성되는 기본 합성 데이터는 소스에서 생성하고, 실제 변경된 데모 기록만 서버에
날짜별로 저장하므로 다음 날 시드 갱신이 사용자 접수 기록을 지우지 않습니다.

현재 서비스는 심사위원 체험을 위한 하나의 공유 데모 공간입니다. 팀장 비밀번호는
화면 진입용 데모 장치이며 서버 사용자 인증·권한 분리는 구현하지 않았습니다.
운영용 인증·접근 권한·보관 기간은 실제 기업 적용 시 별도 구성해야 합니다.

## 최초 등록 / 호스트 재생성 후 복구

아래는 현재 호스트 경로 기준입니다. 먼저 같은 포트의 수동 uvicorn이 없는지 확인하고,
가상환경과 `.env`가 존재하는 상태에서 저장소 루트에서 실행합니다.
다른 프로세스가 8501을 사용하면 해당 프로세스를 확인한 후 전환하세요.

```sh
sudo install -d -m 755 /etc/sv/fieldnote/log
sudo install -d -o ubuntu -g ubuntu -m 700 /data/Documents/Codex/.runtime/fieldnote/logs
sudo install -d -o ubuntu -g ubuntu -m 700 /data/Documents/Codex/.runtime/fieldnote/data
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
