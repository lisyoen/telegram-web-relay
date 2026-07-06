# Reverse Proxy Examples

Use a reverse proxy when you expose `telegram-web-relay` through HTTPS on a public domain.

The examples below assume:

- `telegram-web-relay` listens on `127.0.0.1:9087`
- your public host is `relay.example.com`
- HTTP requests and the Socket.IO polling endpoint both go through the proxy

The relay currently serves Socket.IO on the default `/socket.io/` path.

## nginx

```nginx
server {
    listen 80;
    server_name relay.example.com;

    # Redirect plain HTTP to HTTPS after you have TLS configured.
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    client_max_body_size 100m;

    location /socket.io/ {
        proxy_pass http://127.0.0.1:9087/socket.io/;
        proxy_http_version 1.1;

        # Socket.IO polling requests are long-lived and include query strings
        # such as /socket.io/?EIO=4&transport=polling.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Harmless for polling, and useful if websocket transport is enabled later.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:9087;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Reload nginx after testing the configuration:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

## Caddy

```caddyfile
relay.example.com {
    encode gzip zstd

    @socketio path /socket.io/ /socket.io/*
    reverse_proxy @socketio 127.0.0.1:9087 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_timeout 300s
            write_timeout 300s
        }
    }

    reverse_proxy 127.0.0.1:9087 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_timeout 300s
            write_timeout 300s
        }
    }
}
```

Caddy provisions and renews HTTPS certificates automatically when the domain points to the server.

## Quick Checks

After the proxy is active, verify the relay from a browser:

```sh
curl -I https://relay.example.com/
curl -I "https://relay.example.com/socket.io/?EIO=4&transport=polling"
```

The second command should reach the Socket.IO polling path through the proxy. A non-404 Socket.IO response confirms that the route is being forwarded to the relay.
