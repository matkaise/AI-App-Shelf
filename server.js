const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { isLikelyReactCanvasApp, renderRunnableApp, transformReactCanvasSource } = require("./public/render");

const app = express();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "./data";
const APP_USERNAME = process.env.APP_USERNAME || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "true";
const APP_SECRET = process.env.APP_SECRET || "";
const ALLOW_PLAINTEXT_SECRETS = process.env.ALLOW_PLAINTEXT_SECRETS === "true";
const ENV_GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const TRUST_PROXY = process.env.TRUST_PROXY || "";
const JSON_LIMIT = process.env.JSON_LIMIT || "15mb";
const MAX_CODE_BYTES = Number.parseInt(process.env.MAX_CODE_BYTES || `${1024 * 1024 * 5}`, 10);
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 30;
const AUTH_RATE_LIMIT_MAX_BUCKETS = Math.max(
  100,
  Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX_BUCKETS || "10000", 10) || 10000
);
const AUTH_RATE_LIMIT_SWEEP_MS = 5 * 60 * 1000;
const authFailures = new Map();
let cachedSecretKeySalt = "";
let cachedSecretKey = null;

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
    thumbnail TEXT DEFAULT '',
    starred INTEGER DEFAULT 0,
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

ensureColumn("apps", "thumbnail", "TEXT DEFAULT ''");
ensureColumn("apps", "starred", "INTEGER DEFAULT 0");
migrateStoredGithubToken();
queueThumbnailBackfill();

app.disable("x-powered-by");
if (TRUST_PROXY) app.set("trust proxy", parseTrustProxy(TRUST_PROXY));

const authFailureSweep = setInterval(() => sweepAuthFailures(), AUTH_RATE_LIMIT_SWEEP_MS);
authFailureSweep.unref();

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!req.path.startsWith("/run/")) {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'");
    res.setHeader("X-Frame-Options", "DENY");
  }
  next();
});

app.get("/health", (req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true });
});

app.use(requireBasicAuth);
app.use(express.json({ limit: JSON_LIMIT }));
app.use(requireApiWriteHeader);
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (/\.(?:html|css|js)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

function requireBasicAuth(req, res, next) {
  if (!APP_PASSWORD) {
    if (ALLOW_UNAUTHENTICATED) return next();
    return res
      .status(503)
      .send("AI App Shelf is locked. Set APP_PASSWORD or explicitly set ALLOW_UNAUTHENTICATED=true.");
  }

  if (isAuthRateLimited(req)) return res.status(429).send("Too many authentication attempts");

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return denyBasicAuth(req, res);

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return denyBasicAuth(req, res);
  }

  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (safeEqual(username, APP_USERNAME) && safeEqual(password, APP_PASSWORD)) {
    clearAuthFailures(req);
    return next();
  }
  return denyBasicAuth(req, res);
}

function parseTrustProxy(value) {
  const trimmed = String(value || "").trim();
  const lower = trimmed.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) return true;
  if (["false", "no", "off", "0"].includes(lower)) return false;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

function denyBasicAuth(req, res) {
  recordAuthFailure(req);
  res.setHeader("WWW-Authenticate", 'Basic realm="AI App Shelf"');
  res.status(401).send("Authentication required");
}

function authRateKey(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function getAuthFailureBucket(req) {
  const key = authRateKey(req);
  const now = Date.now();
  const current = authFailures.get(key);
  if (current && now - current.startedAt < AUTH_RATE_LIMIT_WINDOW_MS) return current;
  if (current) authFailures.delete(key);

  if (authFailures.size >= AUTH_RATE_LIMIT_MAX_BUCKETS) sweepAuthFailures();

  const fresh = { count: 0, startedAt: now };
  authFailures.set(key, fresh);
  enforceAuthFailureBucketLimit();
  return fresh;
}

function isAuthRateLimited(req) {
  return getAuthFailureBucket(req).count >= AUTH_RATE_LIMIT_MAX;
}

function recordAuthFailure(req) {
  getAuthFailureBucket(req).count += 1;
}

function clearAuthFailures(req) {
  authFailures.delete(authRateKey(req));
}

function sweepAuthFailures() {
  const now = Date.now();
  for (const [key, bucket] of authFailures) {
    if (now - bucket.startedAt >= AUTH_RATE_LIMIT_WINDOW_MS) authFailures.delete(key);
  }
  enforceAuthFailureBucketLimit();
}

function enforceAuthFailureBucketLimit() {
  while (authFailures.size > AUTH_RATE_LIMIT_MAX_BUCKETS) {
    const oldestKey = authFailures.keys().next().value;
    if (oldestKey === undefined) break;
    authFailures.delete(oldestKey);
  }
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// This is not authentication. The custom header forces browsers to use a CORS
// preflight for cross-origin writes, which blocks plain form/script CSRF.
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

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function encryptSecret(value) {
  if (!APP_SECRET) throw httpError(400, "Set APP_SECRET before storing secrets in the database");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(getOrCreateSecretSalt()), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v2:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSecret(value) {
  if (!APP_SECRET) throw new Error("APP_SECRET is required to decrypt this secret");
  const [prefix, version, ivText, tagText, ciphertextText] = String(value).split(":");
  if (prefix !== "enc" || !["v1", "v2"].includes(version) || !ivText || !tagText || !ciphertextText) {
    throw new Error("Unsupported encrypted secret format");
  }

  const key = version === "v1" ? legacySecretKey() : secretKey(getOrCreateSecretSalt(false));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function legacySecretKey() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

function secretKey(salt) {
  if (cachedSecretKey && cachedSecretKeySalt === salt) return cachedSecretKey;
  cachedSecretKeySalt = salt;
  cachedSecretKey = crypto.scryptSync(APP_SECRET, Buffer.from(salt, "base64url"), 32, {
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return cachedSecretKey;
}

function getOrCreateSecretSalt(createIfMissing = true) {
  const existing = getSetting("secretSalt");
  if (existing) return existing;
  if (!createIfMissing) throw new Error("Missing secret salt");

  const salt = crypto.randomBytes(16).toString("base64url");
  setSetting("secretSalt", salt);
  return salt;
}

function isEncryptedSecret(value) {
  return /^enc:v[12]:/.test(String(value || ""));
}

function readStoredGithubToken() {
  const stored = getSetting("githubToken") || "";
  if (!stored) {
    return {
      token: "",
      configured: false,
      usable: false,
      source: "none",
      storage: "none",
      needsSecret: false,
    };
  }

  if (isEncryptedSecret(stored)) {
    if (!APP_SECRET) {
      return {
        token: "",
        configured: true,
        usable: false,
        source: "database-locked",
        storage: "encrypted",
        needsSecret: true,
      };
    }

    try {
      const token = decryptSecret(stored);
      return {
        token,
        configured: true,
        usable: true,
        source: "database",
        storage: "encrypted",
        needsSecret: false,
      };
    } catch {
      return {
        token: "",
        configured: true,
        usable: false,
        source: "database-locked",
        storage: "encrypted",
        needsSecret: true,
      };
    }
  }

  if (!APP_SECRET) {
    return {
      token: ALLOW_PLAINTEXT_SECRETS ? stored : "",
      configured: true,
      usable: ALLOW_PLAINTEXT_SECRETS,
      source: ALLOW_PLAINTEXT_SECRETS ? "database-plaintext" : "database-locked",
      storage: "plaintext",
      needsSecret: !ALLOW_PLAINTEXT_SECRETS,
    };
  }

  return {
    token: stored,
    configured: true,
    usable: true,
    source: "database-plaintext",
    storage: "plaintext",
    needsSecret: false,
  };
}

function storeGithubToken(token) {
  if (!token) {
    deleteSetting("githubToken");
    return;
  }

  if (APP_SECRET) {
    setSetting("githubToken", encryptSecret(token));
    return;
  }

  if (ALLOW_PLAINTEXT_SECRETS) {
    setSetting("githubToken", token);
    return;
  }

  throw httpError(400, "Set APP_SECRET or GITHUB_TOKEN before saving a GitHub token");
}

function migrateStoredGithubToken() {
  const stored = getSetting("githubToken") || "";
  if (!stored || !APP_SECRET) return;

  try {
    if (isEncryptedSecret(stored)) {
      if (stored.startsWith("enc:v2:")) return;
      setSetting("githubToken", encryptSecret(decryptSecret(stored)));
      return;
    }

    setSetting("githubToken", encryptSecret(stored));
  } catch (err) {
    console.warn(
      `Could not migrate stored GitHub token: ${err.message}. Restore the previous APP_SECRET or save a new token in settings.`
    );
  }
}

function cleanString(value, fallback, maxLength) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw httpError(400, "Invalid text field");
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw httpError(400, `Text field is too long (${maxLength} characters max)`);
  return cleaned;
}

function getBodyObject(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw httpError(400, "JSON object body required");
  }
  return req.body;
}

function cleanCode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw httpError(400, "Invalid code field");
  if (Buffer.byteLength(value, "utf8") > MAX_CODE_BYTES) {
    throw httpError(413, `App code is too large (${MAX_CODE_BYTES} bytes max)`);
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
  if (!code) throw httpError(400, "App code is required");

  return { name, description, tags, code };
}

function prepareStoredApp(appInput) {
  return {
    ...appInput,
    thumbnail: buildAppThumbnail(appInput),
  };
}

function buildAppThumbnail(appInput) {
  const renderMeta = getThumbnailRenderMeta(appInput.code || "");
  const seed = crypto
    .createHash("sha256")
    .update(`${appInput.name || ""}|${appInput.tags || ""}`)
    .digest();
  const palettes = [
    ["#f7faf8", "#0b766d", "#d6f0ec", "#1f2f38"],
    ["#fbfaf4", "#916b1f", "#f0e6c8", "#263036"],
    ["#f8f7fb", "#6d5bd0", "#e4ddfb", "#263036"],
    ["#f7fafc", "#246a9b", "#d9ecf7", "#24323a"],
    ["#fbf7f7", "#b24b55", "#f3d9dc", "#2e2b2c"],
  ];
  const palette = palettes[seed[0] % palettes.length];
  const title = truncateText(appInput.name || "Untitled App", 42);
  const description = truncateText(appInput.description || "AI App Shelf", 78);
  const tags = splitTagText(appInput.tags).slice(0, 3);
  const typeLabel = renderMeta.type === "react" ? "React" : "HTML";
  const warningLabel = renderMeta.warningCount ? `${renderMeta.warningCount} Hinweise` : "";

  const tagSvg = tags
    .map((tag, index) => {
      const x = 56 + index * 156;
      return `<g transform="translate(${x} 404)"><rect width="138" height="34" rx="17" fill="#ffffff" opacity="0.82"/><text x="16" y="22" font-size="14" font-weight="700" fill="${palette[3]}">${escapeXml(
        truncateText(tag, 16)
      )}</text></g>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${palette[0]}"/>
      <stop offset="1" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#bg)"/>
  <rect x="34" y="34" width="892" height="472" rx="28" fill="#ffffff" stroke="#dce4df" stroke-width="2"/>
  <rect x="56" y="58" width="848" height="160" rx="20" fill="${palette[2]}"/>
  <circle cx="814" cy="118" r="44" fill="${palette[1]}" opacity="0.18"/>
  <circle cx="858" cy="156" r="72" fill="${palette[1]}" opacity="0.1"/>
  <rect x="80" y="84" width="96" height="96" rx="24" fill="${palette[1]}"/>
  <text x="128" y="143" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="30" font-weight="800" fill="#ffffff">${escapeXml(
    typeLabel
  )}</text>
  <text x="56" y="286" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="40" font-weight="800" fill="${palette[3]}">${escapeXml(
    title
  )}</text>
  <text x="56" y="334" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="20" font-weight="500" fill="#62706a">${escapeXml(
    description
  )}</text>
  ${tagSvg}
  <text x="56" y="474" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="800" fill="${palette[1]}">${escapeXml(
    warningLabel || "AI App Shelf"
  )}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function getThumbnailRenderMeta(code) {
  if (!isLikelyReactCanvasApp(code)) return { type: "html", warningCount: 0 };
  return {
    type: "react",
    warningCount: transformReactCanvasSource(code).warnings.length,
  };
}

function splitTagText(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...` : text;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function queueThumbnailBackfill() {
  setImmediate(() => backfillMissingThumbnails());
}

function backfillMissingThumbnails(batchSize = 250) {
  const rows = db
    .prepare(
      "SELECT id, name, description, tags, substr(code, 1, 20000) AS code FROM apps WHERE thumbnail IS NULL OR thumbnail = '' LIMIT ?"
    )
    .all(batchSize);
  if (!rows.length) return;

  const update = db.prepare("UPDATE apps SET thumbnail = ? WHERE id = ?");
  db.transaction((apps) => {
    for (const appInput of apps) update.run(buildAppThumbnail(appInput), appInput.id);
  })(rows);

  if (rows.length === batchSize) queueThumbnailBackfill();
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
  const storedToken = readStoredGithubToken();
  const hasEnvToken = Boolean(ENV_GITHUB_TOKEN);
  return {
    token: ENV_GITHUB_TOKEN || storedToken.token,
    tokenConfigured: hasEnvToken || storedToken.configured,
    tokenUsable: hasEnvToken || storedToken.usable,
    tokenSource: hasEnvToken ? "environment" : storedToken.source,
    tokenStorage: hasEnvToken ? "environment" : storedToken.storage,
    tokenNeedsSecret: !hasEnvToken && storedToken.needsSecret,
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

function normalizeRemoteApps(value) {
  if (!Array.isArray(value)) throw httpError(400, "Remote apps file must contain a JSON array");
  const apps = [];
  const skipped = [];

  value.forEach((app, index) => {
    try {
      apps.push(normalizeAppInput(app));
    } catch (err) {
      skipped.push({
        index,
        name: app && typeof app.name === "string" ? app.name : "",
        error: err.message,
      });
    }
  });

  return { apps, skipped };
}

app.get("/api/apps", (req, res) => {
  const search = cleanString(req.query.search, "", 120);
  const limit = Math.min(Number.parseInt(req.query.limit || "100", 10) || 100, 500);
  const offset = Math.max(Number.parseInt(req.query.offset || "0", 10) || 0, 0);

  const selectFields = "id, name, description, tags, thumbnail, code, starred, created_at, updated_at";
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
  const row = db
    .prepare("SELECT id, name, description, tags, code, starred, created_at, updated_at FROM apps WHERE id = ?")
    .get(req.params.id);
  if (!row) throw httpError(404, "App not found");
  res.json(row);
});

app.post("/api/apps", (req, res) => {
  const body = getBodyObject(req);
  const appInput = prepareStoredApp(normalizeAppInput(body));
  const starred = body.starred ? 1 : 0;
  const result = db
    .prepare("INSERT INTO apps (name, description, tags, code, thumbnail, starred) VALUES (?, ?, ?, ?, ?, ?)")
    .run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail, starred);

  res.status(201).json(db.prepare("SELECT * FROM apps WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/apps/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id);
  if (!existing) throw httpError(404, "App not found");

  const body = getBodyObject(req);
  const appInput = prepareStoredApp(normalizeAppInput(body, existing));
  const starred = Object.hasOwn(body, "starred") ? (body.starred ? 1 : 0) : (existing.starred ?? 0);
  db.prepare(
    "UPDATE apps SET name = ?, description = ?, tags = ?, code = ?, thumbnail = ?, starred = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail, starred, req.params.id);

  res.json(db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id));
});

app.post("/api/apps/:id/star", (req, res) => {
  const row = db.prepare("SELECT starred FROM apps WHERE id = ?").get(req.params.id);
  if (!row) throw httpError(404, "App not found");
  const newStarred = row.starred ? 0 : 1;
  db.prepare("UPDATE apps SET starred = ? WHERE id = ?").run(newStarred, req.params.id);
  res.json({ ok: true, starred: Boolean(newStarred) });
});

app.delete("/api/apps/:id", (req, res) => {
  const result = db.prepare("DELETE FROM apps WHERE id = ?").run(req.params.id);
  if (result.changes === 0) throw httpError(404, "App not found");
  res.json({ ok: true });
});

app.get("/run/:id", (req, res) => {
  const row = db.prepare("SELECT code FROM apps WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).send("App not found");
  const rendered = renderRunnableApp(row.code);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-App-Shelf-Source-Type", rendered.type);
  if (rendered.warnings && rendered.warnings.length) {
    res.setHeader("X-App-Shelf-Render-Warnings", String(rendered.warnings.length));
  }
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' https:",
      "style-src 'unsafe-inline' https:",
      "img-src data: blob: https:",
      "font-src data: https:",
      "media-src data: blob: https:",
      "connect-src https:",
      "frame-src https:",
      "worker-src blob:",
      "child-src blob: https:",
      "manifest-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
    ].join("; ")
  );
  res.send(rendered.html);
});

app.get("/api/settings", (req, res) => {
  const cfg = getGithubConfig();
  res.json({
    githubRepo: cfg.repo,
    githubBranch: cfg.branch,
    githubFile: cfg.file,
    githubTokenConfigured: cfg.tokenConfigured,
    githubTokenUsable: cfg.tokenUsable,
    githubTokenSource: cfg.tokenSource,
    githubTokenStorage: cfg.tokenStorage,
    githubTokenNeedsSecret: cfg.tokenNeedsSecret,
    authConfigured: Boolean(APP_PASSWORD),
    authRequired: !ALLOW_UNAUTHENTICATED,
  });
});

app.put("/api/settings", (req, res) => {
  const body = getBodyObject(req);
  if (Object.hasOwn(body, "githubRepo")) setSetting("githubRepo", normalizeRepo(body.githubRepo));
  if (Object.hasOwn(body, "githubBranch")) setSetting("githubBranch", normalizeBranch(body.githubBranch));
  if (Object.hasOwn(body, "githubFile")) setSetting("githubFile", normalizeFilePath(body.githubFile));

  if (Object.hasOwn(body, "githubToken")) {
    const token = cleanString(body.githubToken, "", 400);
    storeGithubToken(token);
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

    for (let attempt = 0; attempt < 2; attempt++) {
      let sha;
      try {
        const existing = await githubRequest(
          "GET",
          `/repos/${cfg.repo}/contents/${contentPath}?ref=${encodeURIComponent(cfg.branch)}`
        );
        sha = existing.sha;
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      try {
        await githubRequest("PUT", `/repos/${cfg.repo}/contents/${contentPath}`, {
          message: `sync: update apps ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          content,
          branch: cfg.branch,
          ...(sha ? { sha } : {}),
        });
        break;
      } catch (err) {
        if (err.status === 409 && attempt === 0) continue;
        throw err;
      }
    }

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
    const { apps: remoteApps, skipped } = normalizeRemoteApps(JSON.parse(decodeGithubContent(data)));

    let added = 0;
    let updated = 0;

    db.transaction((apps) => {
      const findByName = db.prepare("SELECT id FROM apps WHERE name = ?");
      const updateApp = db.prepare(
        "UPDATE apps SET description = ?, tags = ?, code = ?, thumbnail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      );
      const insertApp = db.prepare(
        "INSERT INTO apps (name, description, tags, code, thumbnail) VALUES (?, ?, ?, ?, ?)"
      );

      for (const remoteApp of apps) {
        const appInput = prepareStoredApp(remoteApp);
        const existing = findByName.get(remoteApp.name);
        if (existing) {
          updateApp.run(appInput.description, appInput.tags, appInput.code, appInput.thumbnail, existing.id);
          updated++;
        } else {
          insertApp.run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail);
          added++;
        }
      }
    })(remoteApps);

    res.json({ ok: true, added, updated, skipped: skipped.length, skippedApps: skipped });
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

const server = app.listen(PORT, HOST, () => {
  console.log(`AI App Shelf running on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
