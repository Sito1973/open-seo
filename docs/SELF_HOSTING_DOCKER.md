# Docker Self-Hosting

Run OpenSEO locally with Docker.

In Docker mode, OpenSEO uses `AUTH_MODE=local_noauth` (no auth checks, local admin user `admin@localhost`). Only expose it behind your own auth-protected reverse proxy, tunnel, or private network, or set an [access key](#protect-a-public-server-with-an-access-key).

The default `compose.yaml` uses the published GHCR image:

- `ghcr.io/every-app/open-seo:latest`

## Prerequisites

- Docker Desktop (or Docker Engine + Docker Compose)
- A DataForSEO API key (see [`DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md))

## Quickstart

```bash
cp .env.example .env
```

Set `DATAFORSEO_API_KEY` in `.env` using the [DataForSEO setup guide](./DATAFORSEO_API_KEY.md), then start OpenSEO:

```bash
docker compose up -d
```

Open `http://localhost:<PORT>` (default `3001`). The first start builds the app and may take 1-2 minutes; follow progress with `docker compose logs -f`.

Optional env values:

- `PORT` (defaults to `3001`)
- `ALLOWED_HOST` (single reverse-proxy hostname to allow in Vite preview)
- `AUTH_MODE=local_noauth` (already set in compose)
- `OPEN_SEO_IMAGE` (defaults to `ghcr.io/every-app/open-seo:latest`)
- `DATAFORSEO_SCOPE=backlinks` (use DataForSEO for backlinks only, at most `DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS` requests a month, 300 by default, so at most $18 a month; every other feature runs as without a DataForSEO key. See the [free Google APIs guide](./SELF_HOSTING_GOOGLE_APIS.md#dataforseo-for-backlinks-only))

AI Visibility uses your `DATAFORSEO_API_KEY` and sends tracked questions to DataForSEO. Set `OPENROUTER_API_KEY` for setup research and generated prompt suggestions. You pay providers directly; the app shows the collection cost before a check or schedule starts. Keep the container running for background answers and daily, weekly, or monthly tracking. The built-in scheduler checks for due work every five minutes; no host cron setup is required. See the [AI Visibility guide](https://openseo.so/docs/ai-visibility).

If you are putting Docker behind a reverse proxy or a temporary tunnel, remember that Docker self-hosting runs with app auth disabled. Only expose it behind your own auth-protected reverse proxy, tunnel, or private network, or set an [access key](#protect-a-public-server-with-an-access-key), and add the public hostname before restarting:

```bash
ALLOWED_HOST=yourdomain.com docker compose up -d
```

You can also persist it in `.env`.

## Protect a public server with an access key

Set `SELFHOST_ACCESS_KEY` to require a key for the web app and the MCP server:

```bash
echo "SELFHOST_ACCESS_KEY=$(openssl rand -hex 32)" >> .env
docker compose pull open-seo && docker compose up -d open-seo
```

Once the container is up, `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/` prints `401`. If it prints `200`, the image predates the access key (pull it, or rebuild it if you build your own) or the key did not reach the container.

- The browser asks for a login. Use any username and the key as the password.
- MCP clients send the key as `Authorization: Bearer <key>`, for example `claude mcp add --transport http openseo https://yourdomain.com/mcp --header "Authorization: Bearer <key>"`. Clients that only take a URL, such as Claude.ai custom connectors, use `https://yourdomain.com/mcp?key=<key>` with the OAuth fields left empty. Prefer the header when the client supports it, because URLs can end up in proxy logs.
- `/api/health` stays public. It reports setup status only.
- Serve the app over HTTPS: the key travels with every request.
- If your proxy rewrites the `Host` header to the container's address (nginx does by default unless you set `proxy_set_header Host $host`), block `/cdn-cgi/` at the proxy. The container refuses those internal routes on normal requests, but the local runtime still checks only the `Host` header on WebSocket upgrades.

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. Telemetry also includes failed setup check names and statuses, never values or error messages. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

Heartbeats are triggered by requests to the app or MCP server. Requests to `/api/health`, including Docker's automatic health checks, do not trigger telemetry.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` (or `DO_NOT_TRACK=1`) in `.env`, then run `docker compose up -d --force-recreate open-seo`.

## Pin to a specific image tag

Set `OPEN_SEO_IMAGE` in `.env` and restart:

```bash
OPEN_SEO_IMAGE=ghcr.io/every-app/open-seo:v1.2.3
docker compose up -d
```

## Build your own image locally

If you are testing local code changes, build and run a local tag:

```bash
docker build -f deploy/docker/Dockerfile -t open-seo:local .
OPEN_SEO_IMAGE=open-seo:local docker compose up -d
```

## Common commands

- Restart service after env changes:

```bash
docker compose up -d open-seo
```

- Pull latest published image and restart:

```bash
docker compose pull && docker compose up -d
```

- Stop:

```bash
docker compose down
```

## Health and troubleshooting

Startup checks appear in `docker compose logs` before the build. Once running, `/api/health` reports configuration and database status, and `docker compose ps` reports container health. Scheduler failures appear as `[scheduler]` messages in container logs. The pinned Cloudflare Vite runtime exposes `/cdn-cgi/handler/scheduled`; the container calls it only at `127.0.0.1` using the configured `PORT`. It passes the five-minute cron expression without overriding the clock. Newer Cloudflare versions may use a different local route; the [Cron Triggers documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally) describes the local handler mechanism.

## Troubleshooting environment variables

To confirm Docker Compose is using the expected environment variables:

```bash
docker compose config
```

Check that `AUTH_MODE=local_noauth`, and that `DATAFORSEO_API_KEY` is the base64
encoded value of your DataForSEO email and API password in this format:
`email:password`.

If you changed `.env`, recreate the container so Compose reapplies it:

```bash
docker compose up -d --force-recreate open-seo
```
