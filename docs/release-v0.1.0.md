# telegram-web-relay v0.1.0 Release Notes

한국어는 아래에 있습니다.

## English

`telegram-web-relay` is a self-hosted Telegram Web relay server powered by TDLib. It keeps Telegram connectivity on a server you control and exposes the authenticated session to a browser UI over HTTP and Socket.IO.

### Highlights

- TDLib-backed Telegram session on the server side.
- Socket.IO API for the companion `telegram-web-relay-client` browser UI.
- Static hosting for the built client via `V2_DIST_PATH`.
- Optional chat archive support backed by SQLite.
- PM2 example, `.env.example`, Dockerfile, and Docker Compose example.
- Bilingual documentation in English and Korean.

### Companion Client

Use this server with `telegram-web-relay-client`:

https://github.com/lisyoen/telegram-web-relay-client

### Upgrade Notes

This is the first public release. Treat it as an early self-hosted release and review the security notes before exposing it to the internet.

## 한국어

`telegram-web-relay`는 TDLib 기반 self-hosted Telegram Web relay 서버입니다. 텔레그램 연결은 사용자가 관리하는 서버에서 처리하고, 인증된 세션을 HTTP와 Socket.IO로 브라우저 UI에 제공합니다.

### 주요 내용

- 서버 측 TDLib 기반 Telegram 세션.
- companion 프로젝트 `telegram-web-relay-client`를 위한 Socket.IO API.
- `V2_DIST_PATH`를 통한 빌드된 클라이언트 정적 서빙.
- SQLite 기반 선택적 채팅 아카이브.
- PM2 예시, `.env.example`, Dockerfile, Docker Compose 예시.
- 영어/한국어 양언어 문서.

### companion 클라이언트

이 서버는 `telegram-web-relay-client`와 함께 사용합니다.

https://github.com/lisyoen/telegram-web-relay-client

### 업그레이드 노트

첫 공개 릴리스입니다. 초기 self-hosted 릴리스로 보고, 인터넷에 노출하기 전에 보안 주의사항을 반드시 검토하십시오.
