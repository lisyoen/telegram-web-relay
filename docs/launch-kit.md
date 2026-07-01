# Launch Kit: telegram-web-relay

한국어는 아래에 있습니다.

## English

### One-line Positioning

Self-hosted Telegram Web relay: run Telegram connectivity on your own server and use a browser UI that talks only to your relay.

### Short Description

`telegram-web-relay` is a TDLib-based relay server for a self-hosted Telegram Web setup. It keeps the authenticated Telegram session on the server side and exposes it to a companion browser client over HTTP and Socket.IO.

### Show HN Draft

Title:

```text
Show HN: Self-hosted Telegram Web relay powered by TDLib
```

Body:

```text
I built telegram-web-relay, a self-hosted Telegram Web relay server powered by TDLib.

The idea is simple: the server owns the Telegram connection and authenticated TDLib session, while the browser UI only talks to your relay over HTTP and Socket.IO. The companion client is a fork of Telegram Web A / Telegram-tt adapted for the relay protocol.

Server: https://github.com/lisyoen/telegram-web-relay
Client: https://github.com/lisyoen/telegram-web-relay-client
Release: https://github.com/lisyoen/telegram-web-relay/releases/tag/v0.1.0

It is early, but it already includes bilingual docs, PM2 examples, Docker/Compose examples, and a quickstart flow.
```

### Reddit Draft

```text
I released telegram-web-relay, a self-hosted Telegram Web relay server powered by TDLib.

It runs the Telegram session on your own server and serves a browser UI that communicates with the relay over Socket.IO. The client is a Telegram Web A / Telegram-tt fork adapted for this relay.

Server: https://github.com/lisyoen/telegram-web-relay
Client: https://github.com/lisyoen/telegram-web-relay-client
Release: https://github.com/lisyoen/telegram-web-relay/releases/tag/v0.1.0

Feedback from self-hosters and Telegram client hackers would be very welcome.
```

### Suggested GitHub Topics

```text
telegram, telegram-web, tdlib, self-hosted, socket-io, relay, web-client, nodejs, express, mtproto
```

## 한국어

### 한 줄 포지셔닝

Self-hosted Telegram Web relay: 텔레그램 연결은 내 서버에서 처리하고, 브라우저 UI는 내 relay 서버에만 접속합니다.

### 짧은 소개

`telegram-web-relay`는 TDLib 기반 self-hosted Telegram Web relay 서버입니다. 인증된 Telegram 세션은 서버 측에 유지하고, companion 브라우저 클라이언트는 HTTP와 Socket.IO로 relay와 통신합니다.

### GeekNews / OKKY 초안

```text
TDLib 기반 self-hosted Telegram Web relay를 오픈소스로 공개했습니다.

서버가 Telegram 연결과 인증 세션을 보유하고, 브라우저 UI는 HTTP/Socket.IO로 relay 서버와만 통신하는 구조입니다. 클라이언트는 Telegram Web A / Telegram-tt를 relay 프로토콜에 맞게 수정한 포크입니다.

Server: https://github.com/lisyoen/telegram-web-relay
Client: https://github.com/lisyoen/telegram-web-relay-client
Release: https://github.com/lisyoen/telegram-web-relay/releases/tag/v0.1.0

아직 초기 공개 버전이라 피드백을 받고 싶습니다. self-hosted Telegram Web, TDLib, Telegram client 구조에 관심 있는 분들께 도움이 되면 좋겠습니다.
```

### LinkedIn / X 초안

```text
TDLib 기반 self-hosted Telegram Web relay를 공개했습니다.

Telegram 연결은 서버에서 처리하고, 브라우저 UI는 Socket.IO로 내 relay와 통신합니다. 서버는 MIT, 클라이언트는 Telegram Web A / Telegram-tt 기반 GPL-3.0-or-later입니다.

https://github.com/lisyoen/telegram-web-relay
https://github.com/lisyoen/telegram-web-relay-client
https://github.com/lisyoen/telegram-web-relay/releases/tag/v0.1.0
```
