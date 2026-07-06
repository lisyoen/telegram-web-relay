# telegram-web-relay

[![Release](https://img.shields.io/github/v/release/lisyoen/telegram-web-relay?style=flat-square)](https://github.com/lisyoen/telegram-web-relay/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

English | [한국어](./README.ko.md)

Self-hosted Telegram Web relay powered by TDLib. Run Telegram connectivity on a server you control, then use a browser UI that talks only to your relay over HTTP and Socket.IO.

This repository is the **server**. The browser UI lives in [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client).

![telegram-web-relay architecture](./docs/architecture.svg)

## What It Does

`telegram-web-relay` signs in to Telegram on the server side with [TDLib](https://core.telegram.org/tdlib), keeps the authenticated session on that host, and exposes a browser-friendly Socket.IO API to the web client.

```
Browser UI  --HTTP + Socket.IO-->  telegram-web-relay  --TDLib/MTProto-->  Telegram
```

This is useful when you want a self-hosted Telegram Web experience where the browser does not need to connect to Telegram API endpoints directly. The relay host owns the Telegram session, static assets, file downloads, update stream, and optional chat archive.

## Repository Split

| Repository | Role | License |
| --- | --- | --- |
| `telegram-web-relay` | Node.js TDLib relay server, static host for the web UI | MIT |
| [`telegram-web-relay-client`](https://github.com/lisyoen/telegram-web-relay-client) | Telegram Web A / Telegram-tt fork rewritten to use this relay over Socket.IO | GPL-3.0-or-later |

The two projects are separate processes under separate licenses. They communicate over the network only.

## Run with Docker

```sh
git clone https://github.com/lisyoen/telegram-web-relay.git
cd telegram-web-relay
cp .env.example .env
```

Edit `.env` with your Telegram API credentials from my.telegram.org:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
SESSION_SECRET=replace-this
PORT=9087
```

Start the relay:

```sh
docker compose up -d
```

Open `http://localhost:9087` in your browser. TDLib session data, downloaded files, and the optional archive database are persisted under `./data/`.

To serve a prebuilt v2 client, copy or mount its `dist/` directory as `./client-dist` and set `V2_DIST_PATH=/app/client-dist` in `.env`; `docker-compose.yml` includes the matching commented volume line.

## Quickstart

### 1. Build the Client

```sh
git clone https://github.com/lisyoen/telegram-web-relay-client.git
cd telegram-web-relay-client
cp .env.example .env
npm install
npm run build:production
```

The client build is written to `telegram-web-relay-client/dist`.

### 2. Start the Relay

```sh
git clone https://github.com/lisyoen/telegram-web-relay.git
cd telegram-web-relay
cp .env.example .env
npm install
npm start
```

Edit `.env` before starting:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
SESSION_SECRET=replace-this
PORT=9087
V2_DIST_PATH=../telegram-web-relay-client/dist
```

Open `http://localhost:9087` and sign in with your Telegram account.

## Configuration

All settings are environment variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_API_ID` | yes | empty | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | yes | empty | Telegram API hash from my.telegram.org |
| `SESSION_SECRET` | recommended | development fallback | Express session cookie secret |
| `PORT` | no | `9087` | HTTP port |
| `V2_DIST_PATH` | no | `../telegram-web-relay-client/dist` | Built client `dist/` path |
| `V1_HOST` | no | empty | If set and the request host matches, serve the legacy static UI in `public/` |
| `ARCHIVE_DB_PATH` | no | `./db/chat-archive.sqlite` | SQLite path for optional chat archive |
| `TARGET_CHATS` | no | empty | Comma-separated chat IDs for optional archive collection |
| `MAIN_CHATS` | no | empty | Comma-separated chat IDs for optional main-chat features |

## Security Notes

- The relay owns the authenticated Telegram session. Protect it like any other private messaging backend.
- Do not expose a production relay without HTTPS, access control, and a strong `SESSION_SECRET`.
- TDLib database and downloaded files may contain private account data. Persist and back them up carefully, or delete them deliberately.
- This project is for self-hosted access to your own Telegram account/session. You are responsible for complying with Telegram's terms and your local rules.

## Development

```sh
npm install
npm start
```

Native modules such as `better-sqlite3`, `tdl`, and `prebuilt-tdlib` must match your Node.js ABI. Build and run with the same Node version, especially under PM2.

## Launch Materials

- Release note draft: [docs/release-v0.1.0.md](./docs/release-v0.1.0.md)
- Launch post drafts: [docs/launch-kit.md](./docs/launch-kit.md)
- Issue bot guide: [docs/issue-bot.md](./docs/issue-bot.md)

## Issue Bot

New issues receive an automated bilingual triage response and the `needs-triage` label. Maintainers can add `ai-candidate` when an issue is suitable for a future AI coding-agent workflow.

## License

[MIT](./LICENSE) (c) ChangYeon Lee.

The browser client is a separate GPL-3.0-or-later project. See [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client).
