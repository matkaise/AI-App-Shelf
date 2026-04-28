# AI App Shelf

Zentrale Ablage für KI-generierte Single-File-HTML-Apps aus ChatGPT Canvas, Claude, Gemini und ähnlichen Tools. Gedacht für den Betrieb zu Hause auf einem NAS oder kleinen Homeserver.

## Funktionen

- Apps als vollständigen HTML-Code speichern
- React/JSX-Code aus ChatGPT Canvas automatisch ausführen
- Galerie mit isolierten Live-Vorschauen
- Editor mit Entwurfs-Vorschau
- Suche über Name, Beschreibung und Tags
- Optionaler GitHub-Sync über eine `apps.json`
- SQLite-Datenbank im Docker-Volume
- Basic-Auth standardmäßig erforderlich

## Docker Compose

Lege zuerst eine `.env` neben deiner `docker-compose.yml` an:

```env
APP_USERNAME=admin
APP_PASSWORD=bitte-ein-langes-passwort-setzen
PUID=1000
PGID=1000
```

Auf einem NAS kannst du `PUID` und `PGID` auf die UID/GID deines NAS-Benutzers setzen, damit `./data` beschreibbar bleibt.

Speichere dann diese `docker-compose.yml`:

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
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Start:

```bash
docker compose up -d
```

Danach öffnest du:

```text
http://NAS-IP:3456
```

## Updates

```bash
docker compose pull
docker compose up -d
```

Die Daten bleiben in `./data/apps.db` erhalten.

## GitHub Sync

Der Sync speichert alle Apps als JSON-Datei in einem GitHub-Repo. In der Oberfläche hinterlegst du:

- Repo: `owner/name`
- Branch: zum Beispiel `main`
- Datei: zum Beispiel `apps.json`
- Personal Access Token mit Schreibrechten auf dieses Repo

Sicherer ist es, den Token nicht in der Datenbank zu speichern, sondern im Compose-File als Environment Variable zu setzen:

```yaml
environment:
  GITHUB_TOKEN: ghp_xxx
```

Wenn `GITHUB_TOKEN` gesetzt ist, wird dieser Token bevorzugt verwendet und nicht an die Oberfläche zurückgegeben.

Wenn du den Token in der Oberfläche einträgst, wird er in SQLite gespeichert. Behandle `./data/apps.db` und Backups davon entsprechend wie ein Geheimnis.

## Sicherheit

Die App startet ohne `APP_PASSWORD` nicht offen, sondern gesperrt. Für lokale Experimente kannst du bewusst ohne Auth starten:

```bash
ALLOW_UNAUTHENTICATED=true npm start
```

Für NAS- oder Reverse-Proxy-Betrieb sollte immer `APP_PASSWORD` gesetzt sein.

Gespeicherte HTML-Apps werden mit Browser-Sandbox und Content-Security-Policy ausgeliefert. Zusätzlich müssen schreibende API-Requests einen internen Header senden. Dieser Header ist keine Authentifizierung, erzwingt im Browser aber einen CORS-Preflight und blockiert einfache Cross-Site-Formular-/Script-Requests.

## React-Code aus Canvas

Du kannst neben vollständigem HTML auch typische React/JSX-Snippets aus ChatGPT Canvas einfügen, zum Beispiel Code mit:

```js
import React, { useState } from "react";

export default function App() {
  return <div className="p-6">Hallo</div>;
}
```

AI App Shelf erkennt solche Snippets automatisch und lädt dafür React, ReactDOM, Babel und Tailwind im Sandbox-Frame. Einfache React/Tailwind-Apps funktionieren dadurch direkt.

Wichtig: Beliebige Imports aus npm-Paketen werden nicht automatisch gebündelt. Wenn eine Canvas-App zum Beispiel `lucide-react`, `recharts` oder lokale UI-Komponenten importiert, muss dafür später gezielt Support ergänzt oder der Code als vollständige HTML-Datei exportiert werden.

## Entwicklung

```bash
npm install
npm run check
```

PowerShell:

```powershell
$env:APP_PASSWORD = "dev-password"
npm start
```

Bash:

```bash
APP_PASSWORD=dev-password npm start
```

Standard-Port:

```text
http://localhost:3000
```

## Techstack

- Node.js und Express
- Vanilla HTML/CSS/JS
- SQLite über `better-sqlite3`
- Docker und GitHub Container Registry
