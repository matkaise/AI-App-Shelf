const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "./data";
const APP_USERNAME = process.env.APP_USERNAME || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const ENV_GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const JSON_LIMIT = process.env.JSON_LIMIT || "15mb";
const MAX_CODE_BYTES = Number.parseInt(process.env.MAX_CODE_BYTES || `${1024 * 1024 * 5}`, 10);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "apps.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_apps_updated_at ON apps(updated_at);
  CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
`);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/health", (req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true });
});

app.use(requireBasicAuth);
app.use(express.json({ limit: JSON_LIMIT }));
app.use(requireApiWriteHeader);
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

function requireBasicAuth(req, res, next) {
  if (!APP_PASSWORD || req.path === "/health") return next();

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return denyBasicAuth(res);

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return denyBasicAuth(res);
  }

  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (safeEqual(username, APP_USERNAME) && safeEqual(password, APP_PASSWORD)) return next();
  return denyBasicAuth(res);
}

function denyBasicAuth(res) {
  res.setHeader("WWW-Authenticate", 'Basic realm="AI App Shelf"');
  res.status(401).send("Authentication required");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireApiWriteHeader(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-App-Shelf-Request") === "1") return next();
  return res.status(403).json({ error: "Missing trusted request header" });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function deleteSetting(key) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function cleanString(value, fallback, maxLength) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw httpError(400, "Invalid text field");
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw httpError(400, `Text field is too long (${maxLength} characters max)`);
  return cleaned;
}

function cleanCode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw httpError(400, "Invalid code field");
  if (Buffer.byteLength(value, "utf8") > MAX_CODE_BYTES) {
    throw httpError(413, `App HTML is too large (${MAX_CODE_BYTES} bytes max)`);
  }
  return value;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeAppInput(body, existing = {}) {
  const name = cleanString(body.name, existing.name || "", 120);
  const description = cleanString(body.description, existing.description || "", 1000);
  const tags = cleanString(body.tags, existing.tags || "", 300);
  const code = cleanCode(body.code, existing.code || "");

  if (!name) throw httpError(400, "App name is required");
  if (!code) throw httpError(400, "App HTML is required");

  return { name, description, tags, code };
}

function normalizeRepo(repo) {
  const cleaned = cleanString(repo, "", 160);
  if (!cleaned) return "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) {
    throw httpError(400, "GitHub repo must look like owner/name");
  }
  return cleaned;
}

function normalizeBranch(branch) {
  const cleaned = cleanString(branch, "main", 160) || "main";
  if (cleaned.includes("..") || /[\s~^:?*[\\\]\x00-\x1F]/.test(cleaned)) {
    throw httpError(400, "Invalid GitHub branch name");
  }
  return cleaned;
}

function normalizeFilePath(filePath) {
  const cleaned = cleanString(filePath, "apps.json", 220) || "apps.json";
  if (
    cleaned.startsWith("/") ||
    cleaned.includes("\\") ||
    cleaned.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw httpError(400, "Invalid GitHub file path");
  }
  return cleaned;
}

function encodeContentPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function getGithubConfig() {
  const storedToken = getSetting("githubToken") || "";
  return {
    token: ENV_GITHUB_TOKEN || storedToken,
    tokenSource: ENV_GITHUB_TOKEN ? "environment" : storedToken ? "database" : "none",
    repo: getSetting("githubRepo") || "",
    branch: getSetting("githubBranch") || "main",
    file: getSetting("githubFile") || "apps.json",
  };
}

async function githubRequest(method, apiPath, body) {
  const { token } = getGithubConfig();
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AI-App-Shelf",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw httpError(response.status, data.message || `GitHub error ${response.status}`);
  return data;
}

function decodeGithubContent(data) {
  const content = String(data.content || "").replace(/\n/g, "");
  return Buffer.from(content, "base64").toString("utf8");
}

function ensureRemoteApps(value) {
  if (!Array.isArray(value)) throw httpError(400, "Remote apps file must contain a JSON array");
  return value.map((app) => normalizeAppInput(app));
}

app.get("/api/apps", (req, res) => {
  const search = cleanString(req.query.search, "", 120);
  const limit = Math.min(Number.parseInt(req.query.limit || "100", 10) || 100, 500);
  const offset = Math.max(Number.parseInt(req.query.offset || "0", 10) || 0, 0);

  const selectFields = "id, name, description, tags, created_at, updated_at";
  const rows = search
    ? db
        .prepare(
          `SELECT ${selectFields}
           FROM apps
           WHERE name LIKE ? ESCAPE '\\'
              OR description LIKE ? ESCAPE '\\'
              OR tags LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, id DESC
           LIMIT ? OFFSET ?`
        )
        .all(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`, limit, offset)
    : db
        .prepare(
          `SELECT ${selectFields}
           FROM apps
           ORDER BY updated_at DESC, id DESC
           LIMIT ? OFFSET ?`
        )
        .all(limit, offset);

  res.json(rows);
});

app.get("/api/apps/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id);
  if (!row) throw httpError(404, "App not found");
  res.json(row);
});

app.post("/api/apps", (req, res) => {
  const appInput = normalizeAppInput(req.body);
  const result = db
    .prepare("INSERT INTO apps (name, description, tags, code) VALUES (?, ?, ?, ?)")
    .run(appInput.name, appInput.description, appInput.tags, appInput.code);

  res.status(201).json(db.prepare("SELECT * FROM apps WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/apps/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id);
  if (!existing) throw httpError(404, "App not found");

  const appInput = normalizeAppInput(req.body, existing);
  db.prepare(
    "UPDATE apps SET name = ?, description = ?, tags = ?, code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(appInput.name, appInput.description, appInput.tags, appInput.code, req.params.id);

  res.json(db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id));
});

app.delete("/api/apps/:id", (req, res) => {
  const result = db.prepare("DELETE FROM apps WHERE id = ?").run(req.params.id);
  if (result.changes === 0) throw httpError(404, "App not found");
  res.json({ ok: true });
});

app.get("/run/:id", (req, res) => {
  const row = db.prepare("SELECT code FROM apps WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).send("App not found");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' https: http:",
      "style-src 'unsafe-inline' https: http:",
      "img-src data: blob: https: http:",
      "font-src data: https: http:",
      "media-src data: blob: https: http:",
      "connect-src https: http:",
      "frame-src https: http:",
      "worker-src blob:",
      "child-src blob: https: http:",
      "manifest-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
    ].join("; ")
  );
  res.send(row.code);
});

app.get("/api/settings", (req, res) => {
  const cfg = getGithubConfig();
  res.json({
    githubRepo: cfg.repo,
    githubBranch: cfg.branch,
    githubFile: cfg.file,
    githubTokenConfigured: Boolean(cfg.token),
    githubTokenSource: cfg.tokenSource,
    authConfigured: Boolean(APP_PASSWORD),
  });
});

app.put("/api/settings", (req, res) => {
  if (Object.hasOwn(req.body, "githubRepo")) setSetting("githubRepo", normalizeRepo(req.body.githubRepo));
  if (Object.hasOwn(req.body, "githubBranch")) setSetting("githubBranch", normalizeBranch(req.body.githubBranch));
  if (Object.hasOwn(req.body, "githubFile")) setSetting("githubFile", normalizeFilePath(req.body.githubFile));

  if (Object.hasOwn(req.body, "githubToken")) {
    const token = cleanString(req.body.githubToken, "", 400);
    if (token) setSetting("githubToken", token);
    else deleteSetting("githubToken");
  }

  res.json({ ok: true });
});

app.post(
  "/api/github/push",
  asyncRoute(async (req, res) => {
    const cfg = getGithubConfig();
    if (!cfg.token || !cfg.repo) throw httpError(400, "GitHub is not configured");

    const allApps = db.prepare("SELECT * FROM apps ORDER BY id").all();
    const content = Buffer.from(JSON.stringify(allApps, null, 2)).toString("base64");
    const contentPath = encodeContentPath(cfg.file);

    let sha;
    try {
      const existing = await githubRequest("GET", `/repos/${cfg.repo}/contents/${contentPath}?ref=${encodeURIComponent(cfg.branch)}`);
      sha = existing.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    await githubRequest("PUT", `/repos/${cfg.repo}/contents/${contentPath}`, {
      message: `sync: update apps ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      content,
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    });

    res.json({ ok: true, count: allApps.length });
  })
);

app.post(
  "/api/github/pull",
  asyncRoute(async (req, res) => {
    const cfg = getGithubConfig();
    if (!cfg.token || !cfg.repo) throw httpError(400, "GitHub is not configured");

    const contentPath = encodeContentPath(cfg.file);
    const data = await githubRequest("GET", `/repos/${cfg.repo}/contents/${contentPath}?ref=${encodeURIComponent(cfg.branch)}`);
    const remoteApps = ensureRemoteApps(JSON.parse(decodeGithubContent(data)));

    let added = 0;
    let updated = 0;

    db.transaction((apps) => {
      const findByName = db.prepare("SELECT id FROM apps WHERE name = ?");
      const updateApp = db.prepare(
        "UPDATE apps SET description = ?, tags = ?, code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      );
      const insertApp = db.prepare("INSERT INTO apps (name, description, tags, code) VALUES (?, ?, ?, ?)");

      for (const remoteApp of apps) {
        const existing = findByName.get(remoteApp.name);
        if (existing) {
          updateApp.run(remoteApp.description, remoteApp.tags, remoteApp.code, existing.id);
          updated++;
        } else {
          insertApp.run(remoteApp.name, remoteApp.description, remoteApp.tags, remoteApp.code);
          added++;
        }
      }
    })(remoteApps);

    res.json({ ok: true, added, updated });
  })
);

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  return res.status(404).send("Not found");
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.type === "entity.too.large" ? 413 : 500);
  const message = status >= 500 ? "Internal server error" : err.message;
  if (status >= 500) console.error(err);
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: message });
  return res.status(status).send(message);
});

app.listen(PORT, HOST, () => {
  console.log(`AI App Shelf running on http://${HOST}:${PORT}`);
});
