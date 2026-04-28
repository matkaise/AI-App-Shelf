# AI App Shelf

Zentrale Ablage für KI-generierte Single-File-HTML-Apps aus ChatGPT Canvas, Claude, Gemini und ähnlichen Tools. Gedacht für den Betrieb zu Hause auf einem NAS oder kleinen Homeserver.

## Funktionen

- Apps als vollständigen HTML-Code speichern
- React/JSX-Code aus ChatGPT Canvas automatisch ausführen
- Galerie mit statischen Thumbnails und isolierter Live-Vorschau im Editor
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
APP_SECRET=bitte-einen-langen-zufaelligen-secret-setzen
PUID=1000
PGID=1000
```

`APP_SECRET` wird verwendet, um in der Oberfläche gespeicherte GitHub-Tokens verschlüsselt in SQLite abzulegen. Verwende dafür einen langen zufälligen Wert, nicht dein NAS-Passwort. Auf einem NAS kannst du `PUID` und `PGID` auf die UID/GID deines NAS-Benutzers setzen; `./data` muss auf dem Host für diese UID/GID beschreibbar sein.

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
      APP_SECRET: ${APP_SECRET:?Set APP_SECRET in .env before starting AI App Shelf}
      # TRUST_PROXY: "1"
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

Wenn du den Token in der Oberfläche einträgst, wird er mit `APP_SECRET` verschlüsselt in SQLite gespeichert. Der Schlüssel wird per `scrypt` mit einer in der Datenbank gespeicherten Salt abgeleitet. Ohne `APP_SECRET` lehnt die App das Speichern eines Tokens ab. Behandle `./data/apps.db`, deinen `APP_SECRET` und Backups davon trotzdem wie Geheimnisse.

Alte Klartext-Tokens werden beim Start automatisch verschlüsselt, sobald `APP_SECRET` gesetzt ist. Wenn du bewusst weiter Klartext erlauben willst, geht das nur explizit mit `ALLOW_PLAINTEXT_SECRETS=true`.

Beim Pull-Sync werden Apps aktuell über ihren Namen wiedererkannt. Wenn du eine App lokal umbenennst und dann pullst, kann dieselbe App deshalb als neue App angelegt werden.

## Sicherheit

Die App startet ohne `APP_PASSWORD` nicht offen, sondern gesperrt. Für lokale Experimente kannst du bewusst ohne Auth starten:

```bash
ALLOW_UNAUTHENTICATED=true npm start
```

Für NAS- oder Reverse-Proxy-Betrieb sollte immer `APP_PASSWORD` gesetzt sein.

Gespeicherte HTML-Apps werden mit Browser-Sandbox und Content-Security-Policy ausgeliefert. Die Hauptoberfläche blockiert Framing, und Basic-Auth-Fehlversuche werden einfach pro IP begrenzt. Zusätzlich müssen schreibende API-Requests einen internen Header senden. Dieser Header ist keine Authentifizierung, erzwingt im Browser aber einen CORS-Preflight und blockiert einfache Cross-Site-Formular-/Script-Requests.

Wenn AI App Shelf hinter einem Reverse Proxy läuft und dieser `X-Forwarded-For` korrekt setzt, kannst du `TRUST_PROXY=1` aktivieren. Dann zählt das Basic-Auth-Rate-Limit pro echter Client-IP statt pro Proxy-IP. Nutze das nur, wenn die App nicht direkt aus dem Internet erreichbar ist und der Proxy die Forwarded-Header kontrolliert.

## React-Code aus Canvas

Du kannst neben vollständigem HTML auch typische React/JSX-Snippets aus ChatGPT Canvas einfügen, zum Beispiel Code mit:

```js
import React, { useState } from "react";

export default function App() {
  return <div className="p-6">Hallo</div>;
}
```

AI App Shelf erkennt solche Snippets automatisch. Beim Speichern versucht der Server zusätzlich, React-Apps mit `esbuild` zu einem Browser-Bundle zu bauen. Bare npm-Imports werden dabei über `esm.sh` aufgelöst, ohne dass zur Laufzeit `npm install` oder npm-Install-Skripte ausgeführt werden.

Wenn der Bundle-Build erfolgreich ist, nutzt `/run/:id` das gespeicherte Bundle. Wenn der Build fehlschlägt, deaktiviert ist oder die App keinen Default-Export hat, fällt AI App Shelf auf den Browser-Renderer mit React, Babel und Tailwind im Sandbox-Frame zurück.

Das Bundler-MVP unterstützt Single-File-React-Apps mit öffentlichen Browser-tauglichen npm-Paketen. Direkte URL-Imports wie `import "https://..."` werden aus Sicherheitsgründen blockiert; npm-Pakete laufen nur über die kontrollierte `esm.sh`-Route. Lokale Projekt-Imports wie `@/components/ui/button`, Node-only-Pakete, native Addons und Multi-File-Projekte werden nicht automatisch aufgelöst.

Du kannst den Bundler bei Bedarf deaktivieren:

```bash
ENABLE_BUNDLER=false npm start
```

## Entwicklung

```bash
npm install
npm run check
npm test
```

Der normale Smoke-Test bleibt offline-stabil. Einen zusätzlichen Online-Test mit echtem npm-Import über `esm.sh` kannst du separat ausführen:

```bash
npm run test:online
```

PowerShell:

```powershell
$env:APP_PASSWORD = "dev-password"
$env:APP_SECRET = "dev-secret"
npm start
```

Bash:

```bash
APP_PASSWORD=dev-password APP_SECRET=dev-secret npm start
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
