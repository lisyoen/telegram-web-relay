# telegram-web-relay

English | [한국어](./README.ko.md)

A self-hosted relay server that lets you use a Telegram web client from networks where the public Telegram API endpoints are blocked.

`telegram-web-relay` connects to Telegram on the **server side** using [TDLib](https://core.telegram.org/tdlib) (via the `tdl` and `prebuilt-tdlib` packages) and exposes that session to a browser over HTTP and [Socket.IO](https://socket.io/). The browser never talks to Telegram directly — all MTProto traffic terminates on the host you control — so the client keeps working from any network that can reach your relay, even when `*.telegram.org` is unreachable.

The browser front-end lives in a separate repository: **[telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)**.

## Why

Some corporate, campus, or national firewalls block the Telegram API endpoints, which stops the official web and desktop clients from connecting. Running this relay on a reachable machine moves the Telegram connection to the server side, so an ordinary browser can reach Telegram through your own infrastructure — no client-side proxy or VPN required.

## Architecture

```
Browser  --HTTP + Socket.IO-->  telegram-web-relay (this repo, MIT)
                                        |
                                        v
                                TDLib (tdl / prebuilt-tdlib)
                                        |
                                        v
                                Telegram servers (MTProto)
```

- **This repo (server, MIT):** a Node.js process (`server.js`) built on Express, `express-session`, Socket.IO, and `better-sqlite3`. It owns the TDLib client, holds the authenticated session, and relays updates to and from the browser.
- **Client (GPL-3.0-or-later):** [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client), a fork of [Telegram-tt](https://github.com/Ajaxy/telegram-tt) rewritten to speak to this relay over Socket.IO instead of connecting to Telegram itself.
- The two pieces communicate **at arm's length** over a Socket.IO contract. The server serves the built client: point `V2_DIST_PATH` at the client's `dist/` output and the relay serves it as the web UI.

The server and the client are **separate processes under separate licenses** (MIT for the server, GPL-3.0-or-later for the client). They interoperate over the network only; neither is linked into the other.

## Requirements

- Node.js — the `tdl` / `prebuilt-tdlib` and `better-sqlite3` native modules must match your Node ABI, so build and run with the same Node version.
- A Telegram **API ID** and **API hash** from [my.telegram.org](https://my.telegram.org).

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Obtain an API ID / API hash from [my.telegram.org](https://my.telegram.org).
3. Configure with either a `.env` file or the PM2 ecosystem config:
   - **`.env`:** copy `.env.example` to `.env` and fill in `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
   - **PM2:** copy `ecosystem.config.example` to `ecosystem.config.js` and fill in the same values.
4. Build the front-end (see [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client)) and point `V2_DIST_PATH` at its `dist/` directory.
5. Start the server:
   ```sh
   npm start
   ```
   or under PM2:
   ```sh
   pm2 start ecosystem.config.js
   ```
6. Open the relay in a browser (default `http://<host>:9087`) and log in with your Telegram account.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_API_ID` | yes | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | yes | Telegram API hash from my.telegram.org |
| `PORT` | no | HTTP port (default `9087`) |
| `V2_DIST_PATH` | no | Path to the built client `dist/` (for example `../telegram-web-relay-client/dist`) |
| `V1_HOST` | no | If set and the request host matches, serve the legacy static UI in `public/`; otherwise the modern client is always served |
| `ARCHIVE_DB_PATH` | no | SQLite path for the chat archive (defaults to `./db/chat-archive.sqlite`, created at runtime) |
| `TARGET_CHATS` / `MAIN_CHATS` | no | Comma-separated chat IDs for optional target / main-chat features; empty disables them |

## License

[MIT](./LICENSE) (c) ChangYeon Lee.

The browser client is a separate project under GPL-3.0-or-later. See [telegram-web-relay-client](https://github.com/lisyoen/telegram-web-relay-client).
