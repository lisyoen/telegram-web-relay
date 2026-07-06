# telegram-web-relay

[![Release](https://img.shields.io/github/v/release/lisyoen/telegram-web-relay?style=flat-square)](https://github.com/lisyoen/telegram-web-relay/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

[English](./README.md) | 한국어

TDLib 기반 self-hosted Telegram Web relay입니다. 텔레그램 연결은 사용자가 관리하는 서버에서 처리하고, 브라우저 UI는 HTTP와 Socket.IO로 relay 서버에만 접속합니다.

이 저장소는 **서버**입니다. 브라우저 UI는 [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)에 있습니다.

![telegram-web-relay 구조](./docs/architecture.svg)

## 무엇을 하나요

`telegram-web-relay`는 서버 측에서 [TDLib](https://core.telegram.org/tdlib)로 텔레그램에 로그인하고, 인증된 세션을 해당 호스트에 유지한 뒤, 브라우저 클라이언트가 사용할 수 있는 Socket.IO API를 제공합니다.

```
브라우저 UI  --HTTP + Socket.IO-->  telegram-web-relay  --TDLib/MTProto-->  Telegram
```

브라우저가 텔레그램 API 엔드포인트에 직접 연결하지 않아도 되는 self-hosted Telegram Web 환경이 필요할 때 사용할 수 있습니다. relay 서버는 텔레그램 세션, 정적 파일 서빙, 파일 다운로드, 업데이트 스트림, 선택적 채팅 아카이브를 담당합니다.

## 저장소 구성

| 저장소 | 역할 | 라이선스 |
| --- | --- | --- |
| `telegram-web-relay` | Node.js TDLib relay 서버, 웹 UI 정적 파일 호스트 | MIT |
| [`telegram-web-relay-client`](https://github.com/lisyoen/telegram-web-relay-client) | Socket.IO relay를 사용하도록 수정한 Telegram Web A / Telegram-tt 포크 | GPL-3.0-or-later |

두 프로젝트는 서로 다른 라이선스를 가진 별도 프로세스이며, 네트워크를 통해서만 통신합니다.

## Docker로 실행

```sh
git clone https://github.com/lisyoen/telegram-web-relay.git
cd telegram-web-relay
cp .env.example .env
```

my.telegram.org에서 발급한 Telegram API 자격증명을 `.env`에 입력합니다.

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
SESSION_SECRET=replace-this
PORT=9087
```

Relay를 실행합니다.

```sh
docker compose up -d
```

브라우저에서 `http://localhost:9087`을 엽니다. TDLib 세션 데이터, 다운로드 파일, 선택적 아카이브 DB는 `./data/` 아래에 보관됩니다.

빌드된 v2 클라이언트를 서빙하려면 `dist/` 디렉터리를 `./client-dist`로 복사하거나 마운트하고, `.env`에 `V2_DIST_PATH=/app/client-dist`를 설정하십시오. `docker-compose.yml`에 대응되는 볼륨 예시가 주석으로 포함되어 있습니다.

## 빠른 시작

### 1. 클라이언트 빌드

```sh
git clone https://github.com/lisyoen/telegram-web-relay-client.git
cd telegram-web-relay-client
cp .env.example .env
npm install
npm run build:production
```

클라이언트 빌드 결과는 `telegram-web-relay-client/dist`에 생성됩니다.

### 2. Relay 실행

```sh
git clone https://github.com/lisyoen/telegram-web-relay.git
cd telegram-web-relay
cp .env.example .env
npm install
npm start
```

실행 전에 `.env`를 수정합니다.

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
SESSION_SECRET=replace-this
PORT=9087
V2_DIST_PATH=../telegram-web-relay-client/dist
```

브라우저에서 `http://localhost:9087`을 열고 텔레그램 계정으로 로그인합니다.

## 설정

모든 설정은 환경 변수입니다.

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `TELEGRAM_API_ID` | 예 | 빈 값 | my.telegram.org에서 발급한 Telegram API ID |
| `TELEGRAM_API_HASH` | 예 | 빈 값 | my.telegram.org에서 발급한 Telegram API hash |
| `SESSION_SECRET` | 권장 | 개발용 fallback | Express 세션 쿠키 secret |
| `PORT` | 아니오 | `9087` | HTTP 포트 |
| `V2_DIST_PATH` | 아니오 | `../telegram-web-relay-client/dist` | 빌드된 클라이언트 `dist/` 경로 |
| `V1_HOST` | 아니오 | 빈 값 | 설정 시 요청 host가 일치하면 `public/`의 레거시 UI 서빙 |
| `ARCHIVE_DB_PATH` | 아니오 | `./db/chat-archive.sqlite` | 선택적 채팅 아카이브 SQLite 경로 |
| `TARGET_CHATS` | 아니오 | 빈 값 | 선택적 아카이브 수집 대상 chat ID 목록 |
| `MAIN_CHATS` | 아니오 | 빈 값 | 선택적 main-chat 기능용 chat ID 목록 |

## 보안 주의사항

- relay는 인증된 Telegram 세션을 보유합니다. 개인 메시징 백엔드처럼 보호해야 합니다.
- 운영 환경에서는 HTTPS, 접근 제어, 강한 `SESSION_SECRET` 없이 공개하지 마십시오.
- TDLib 데이터베이스와 다운로드 파일에는 개인 계정 데이터가 포함될 수 있습니다. 영구 보관/백업/삭제 정책을 명확히 하십시오.
- 이 프로젝트는 사용자의 Telegram 계정/세션을 self-hosted 환경에서 사용하기 위한 도구입니다. Telegram 약관과 현지 규칙 준수 책임은 사용자에게 있습니다.

## 개발

```sh
npm install
npm start
```

`better-sqlite3`, `tdl`, `prebuilt-tdlib` 같은 네이티브 모듈은 Node.js ABI와 맞아야 합니다. 특히 PM2로 실행할 때는 빌드와 실행 Node 버전을 맞추십시오.

## 홍보 자료

- 릴리스 노트 초안: [docs/release-v0.1.0.md](./docs/release-v0.1.0.md)
- 홍보문 초안: [docs/launch-kit.md](./docs/launch-kit.md)
- 이슈 봇 가이드: [docs/issue-bot.md](./docs/issue-bot.md)

## 이슈 봇

새 이슈가 열리면 자동으로 한/영 triage 댓글을 남기고 `needs-triage` 라벨을 붙입니다. 관리자는 향후 AI 코딩 에이전트가 처리하기 좋은 이슈에 `ai-candidate` 라벨을 붙일 수 있습니다.

## 라이선스

[MIT](./LICENSE) (c) ChangYeon Lee.

브라우저 클라이언트는 GPL-3.0-or-later로 배포되는 별도 프로젝트입니다. [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)를 참조하십시오.
