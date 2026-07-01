# telegram-web-relay

[English](./README.md) | 한국어

텔레그램 API 엔드포인트가 차단된 네트워크에서도 텔레그램 웹 클라이언트를 사용할 수 있게 해 주는 self-host 중계 서버입니다.

`telegram-web-relay`는 **서버 측**에서 [TDLib](https://core.telegram.org/tdlib)(`tdl` 및 `prebuilt-tdlib` 패키지 사용)로 텔레그램에 접속하고, 그 세션을 HTTP와 [Socket.IO](https://socket.io/)로 브라우저에 노출합니다. 브라우저는 텔레그램과 직접 통신하지 않으며 모든 MTProto 트래픽은 사용자가 운영하는 호스트에서 종단됩니다. 따라서 `*.telegram.org`에 접근할 수 없는 환경이라도 중계 서버에 도달할 수 있는 네트워크라면 클라이언트가 정상 동작합니다.

브라우저 프런트엔드는 별도 저장소에 있습니다: **[telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)**.

## 배경

일부 기업, 학내, 국가 단위 방화벽은 텔레그램 API 엔드포인트를 차단하여 공식 웹/데스크톱 클라이언트의 접속을 막습니다. 도달 가능한 장비에 이 중계 서버를 올리면 텔레그램 접속이 서버 측으로 옮겨지므로, 클라이언트 측 프록시나 VPN 없이도 일반 브라우저에서 사용자 자신의 인프라를 통해 텔레그램에 접근할 수 있습니다.

## 아키텍처

```
브라우저  --HTTP + Socket.IO-->  telegram-web-relay (이 저장소, MIT)
                                        |
                                        v
                                TDLib (tdl / prebuilt-tdlib)
                                        |
                                        v
                                텔레그램 서버 (MTProto)
```

- **이 저장소(서버, MIT):** Express, `express-session`, Socket.IO, `better-sqlite3` 기반의 Node.js 프로세스(`server.js`)입니다. TDLib 클라이언트를 직접 소유하여 인증된 세션을 유지하고, 브라우저와 업데이트를 주고받는 중계를 담당합니다.
- **클라이언트(GPL-3.0-or-later):** [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client). [Telegram-tt](https://github.com/Ajaxy/telegram-tt)의 포크로, 텔레그램에 직접 접속하지 않고 이 중계 서버와 Socket.IO로 통신하도록 재작성되었습니다.
- 두 구성요소는 Socket.IO 규약을 통해 **느슨하게(arm's length)** 통신합니다. 서버가 빌드된 클라이언트를 서빙합니다. `V2_DIST_PATH`를 클라이언트의 `dist/` 출력 경로로 지정하면 중계 서버가 이를 웹 UI로 제공합니다.

서버와 클라이언트는 **각각 별도 라이선스를 가진 별도 프로세스**입니다(서버는 MIT, 클라이언트는 GPL-3.0-or-later). 둘은 네트워크로만 상호 동작하며 한쪽이 다른 쪽에 링크되지 않습니다.

## 요구 사항

- Node.js — `tdl` / `prebuilt-tdlib` 및 `better-sqlite3` 네이티브 모듈은 Node ABI에 맞아야 하므로 빌드와 실행을 동일한 Node 버전으로 진행합니다.
- [my.telegram.org](https://my.telegram.org)에서 발급한 텔레그램 **API ID**와 **API hash**.

## 설치

1. 의존성 설치:
   ```sh
   npm install
   ```
2. [my.telegram.org](https://my.telegram.org)에서 API ID / API hash 발급.
3. `.env` 파일 또는 PM2 ecosystem 설정 중 하나로 구성:
   - **`.env`:** `.env.example`을 `.env`로 복사한 뒤 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 기입.
   - **PM2:** `ecosystem.config.example`을 `ecosystem.config.js`로 복사한 뒤 동일한 값 기입.
4. 프런트엔드를 빌드하고([telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client) 참조) `V2_DIST_PATH`를 그 `dist/` 경로로 지정.
5. 서버 실행:
   ```sh
   npm start
   ```
   또는 PM2:
   ```sh
   pm2 start ecosystem.config.js
   ```
6. 브라우저로 중계 서버에 접속(기본 `http://<host>:9087`)하여 텔레그램 계정으로 로그인.

## 설정

모든 설정은 환경 변수입니다(`.env.example` 참조):

| 변수 | 필수 | 설명 |
|------|------|------|
| `TELEGRAM_API_ID` | 예 | my.telegram.org에서 발급한 텔레그램 API ID |
| `TELEGRAM_API_HASH` | 예 | my.telegram.org에서 발급한 텔레그램 API hash |
| `PORT` | 아니오 | HTTP 포트(기본 `9087`) |
| `V2_DIST_PATH` | 아니오 | 빌드된 클라이언트 `dist/` 경로(예: `../telegram-web-relay-client/dist`) |
| `V1_HOST` | 아니오 | 설정 시 요청 호스트가 일치하면 `public/`의 레거시 정적 UI를 서빙. 미설정 시 항상 최신 클라이언트 서빙 |
| `ARCHIVE_DB_PATH` | 아니오 | 채팅 아카이브 SQLite 경로(기본 `./db/chat-archive.sqlite`, 런타임 생성) |
| `TARGET_CHATS` / `MAIN_CHATS` | 아니오 | 선택적 target / main-chat 기능용 쉼표 구분 chat ID. 비우면 비활성화 |

## 라이선스

[MIT](./LICENSE) (c) ChangYeon Lee.

브라우저 클라이언트는 GPL-3.0-or-later로 배포되는 별도 프로젝트입니다. [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)를 참조하십시오.
