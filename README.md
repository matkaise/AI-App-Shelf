# AI App Shelf

AI App Shelf is a self-hosted dashboard for AI-generated mini apps. Paste HTML, React, or TSX from Claude, ChatGPT, Gemini, or similar tools, save it to your shelf, and open each app in a sandboxed runner.

It includes:

- A clean app dashboard with search, tags, favorites, and screenshot thumbnails
- A paste-and-preview flow for new apps
- Editing saved app source code
- Support for single-file HTML, React, and TSX apps
- Bundling for supported npm imports through `esm.sh`
- A runner debug console for logs and runtime errors
- Optional GitHub sync through an `apps.json` file
- SQLite storage in a Docker volume

## Install With Docker Compose

Create a project folder and add a `.env` file:

```env
APP_USERNAME=admin
APP_PASSWORD=change-this-password
APP_SECRET=change-this-to-a-long-random-secret
PUID=1000
PGID=1000
```

`APP_PASSWORD` protects the web UI. `APP_SECRET` encrypts GitHub tokens that are saved through the settings dialog. Use a long random value for both.

Then create `docker-compose.yml`:

```yaml
services:
  ai-app-shelf:
    image: ghcr.io/matkaise/ai-app-shelf:latest
    container_name: ai-app-shelf
    restart: unless-stopped
    ports:
      - "3456:3000"
    volumes:
      - ./data:/data
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      DATA_DIR: /data
      PORT: 3000
      APP_USERNAME: ${APP_USERNAME:-admin}
      APP_PASSWORD: ${APP_PASSWORD:?Set APP_PASSWORD in .env before starting AI App Shelf}
      APP_SECRET: ${APP_SECRET:?Set APP_SECRET in .env before starting AI App Shelf}
      # TRUST_PROXY: "1"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Start the app:

```bash
docker compose up -d
```

Open it in your browser:

```text
http://localhost:3456
```

If Docker runs on another machine, replace `localhost` with that machine's IP address or hostname.

## Update

```bash
docker compose pull
docker compose up -d
```

Your apps are stored in `./data/apps.db` and remain available across container updates.

## Optional GitHub Sync

Open Settings in the app and enter:

- Repository: `owner/name`
- Branch: for example `main`
- File: for example `apps.json`
- A Personal Access Token with write access to that repository

Instead of saving the token in SQLite, you can provide it through Docker Compose:

```yaml
environment:
  GITHUB_TOKEN: ghp_xxx
```

When `GITHUB_TOKEN` is set, it is used for sync and is not returned to the UI.
