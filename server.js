const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const esbuild = require("esbuild");
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
const ENABLE_BUNDLER = process.env.ENABLE_BUNDLER !== "false";
const BUNDLE_FETCH_TIMEOUT_MS = Number.parseInt(process.env.BUNDLE_FETCH_TIMEOUT_MS || "20000", 10) || 20000;
const BUNDLE_CDN_HOST = "esm.sh";
const ENABLE_SCREENSHOT_THUMBNAILS = process.env.ENABLE_SCREENSHOT_THUMBNAILS !== "false";
const SCREENSHOT_THUMBNAIL_WIDTH = Number.parseInt(process.env.SCREENSHOT_THUMBNAIL_WIDTH || "960", 10) || 960;
const SCREENSHOT_THUMBNAIL_HEIGHT = Number.parseInt(process.env.SCREENSHOT_THUMBNAIL_HEIGHT || "600", 10) || 600;
const SCREENSHOT_THUMBNAIL_TIMEOUT_MS =
  Number.parseInt(process.env.SCREENSHOT_THUMBNAIL_TIMEOUT_MS || "12000", 10) || 12000;
const SCREENSHOT_THUMBNAIL_BACKFILL_LIMIT =
  Number.parseInt(process.env.SCREENSHOT_THUMBNAIL_BACKFILL_LIMIT || "200", 10) || 200;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 30;
const AUTH_RATE_LIMIT_MAX_BUCKETS = Math.max(
  100,
  Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX_BUCKETS || "10000", 10) || 10000
);
const AUTH_RATE_LIMIT_SWEEP_MS = 5 * 60 * 1000;
const authFailures = new Map();
const screenshotThumbnailQueue = [];
const screenshotThumbnailQueuedIds = new Set();
const screenshotDnsCache = new Map();
let cachedSecretKeySalt = "";
let cachedSecretKey = null;
let screenshotThumbnailWorkerActive = false;
let screenshotThumbnailUnavailable = false;
let screenshotThumbnailWarningLogged = false;
let screenshotBrowserPromise = null;

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
    bundle_hash TEXT DEFAULT '',
    bundle_js TEXT DEFAULT '',
    bundle_css TEXT DEFAULT '',
    build_status TEXT DEFAULT 'idle',
    build_error TEXT DEFAULT '',
    build_dependencies TEXT DEFAULT '',
    build_at DATETIME,
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
ensureColumn("apps", "bundle_hash", "TEXT DEFAULT ''");
ensureColumn("apps", "bundle_js", "TEXT DEFAULT ''");
ensureColumn("apps", "bundle_css", "TEXT DEFAULT ''");
ensureColumn("apps", "build_status", "TEXT DEFAULT 'idle'");
ensureColumn("apps", "build_error", "TEXT DEFAULT ''");
ensureColumn("apps", "build_dependencies", "TEXT DEFAULT ''");
ensureColumn("apps", "build_at", "DATETIME");
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

function publicAppFields() {
  return [
    "id",
    "name",
    "description",
    "tags",
    "thumbnail",
    "code",
    "starred",
    "build_status",
    "build_error",
    "build_dependencies",
    "build_at",
    "created_at",
    "updated_at",
  ].join(", ");
}

function detailAppFields() {
  return [
    "id",
    "name",
    "description",
    "tags",
    "code",
    "starred",
    "build_status",
    "build_error",
    "build_dependencies",
    "build_at",
    "created_at",
    "updated_at",
  ].join(", ");
}

function appResponse(row) {
  if (!row) return row;
  return {
    ...row,
    build_dependencies: parseJsonArray(row.build_dependencies),
  };
}

function appsResponse(rows) {
  return rows.map(appResponse);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function rebuildAppBundle(id) {
  const row = db.prepare("SELECT id, code FROM apps WHERE id = ?").get(id);
  if (!row) throw httpError(404, "App not found");
  const result = await buildBundle(row.code);

  db.prepare(
    `UPDATE apps
     SET bundle_hash = ?,
         bundle_js = ?,
         bundle_css = ?,
         build_status = ?,
         build_error = ?,
         build_dependencies = ?,
         build_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    result.hash,
    result.js,
    result.css,
    result.status,
    result.error,
    JSON.stringify(result.dependencies),
    id
  );

  return appResponse(db.prepare(`SELECT ${detailAppFields()} FROM apps WHERE id = ?`).get(id));
}

async function buildBundle(code) {
  const dependencies = extractBarePackageImports(code);
  const hash = crypto
    .createHash("sha256")
    .update("bundle-v1\0")
    .update(code || "")
    .digest("hex");

  if (!ENABLE_BUNDLER) {
    return {
      hash,
      js: "",
      css: "",
      status: "disabled",
      error: "",
      dependencies,
    };
  }

  if (!isLikelyReactCanvasApp(code)) {
    return {
      hash,
      js: "",
      css: "",
      status: "skipped",
      error: "",
      dependencies,
    };
  }

  if (!/export\s+default\b/.test(code)) {
    return {
      hash,
      js: "",
      css: "",
      status: "fallback",
      error: "Bundler MVP needs a default React export. Browser renderer fallback will be used.",
      dependencies,
    };
  }

  try {
    const built = await bundleReactApp(code);
    return {
      hash,
      js: built.js,
      css: built.css,
      status: "ready",
      error: "",
      dependencies,
    };
  } catch (err) {
    return {
      hash,
      js: "",
      css: "",
      status: "error",
      error: trimBuildError(err),
      dependencies,
    };
  }
}

async function bundleReactApp(code) {
  const result = await esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: ["app-shelf:entry"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      ".ts": "ts",
      ".tsx": "tsx",
      ".css": "css",
    },
    plugins: [appShelfSourcePlugin(code), appShelfNpmPlugin()],
    logLevel: "silent",
  });

  let js = "";
  let css = "";
  for (const file of result.outputFiles || []) {
    if (file.path.endsWith(".css")) css += file.text;
    else js += file.text;
  }

  return { js, css };
}

function appShelfSourcePlugin(code) {
  return {
    name: "app-shelf-source",
    setup(build) {
      build.onResolve({ filter: /^app-shelf:entry$/ }, () => ({
        path: "entry.jsx",
        namespace: "app-shelf-source",
      }));

      build.onResolve({ filter: /^\.\/App\.jsx$/, namespace: "app-shelf-source" }, () => ({
        path: "App.jsx",
        namespace: "app-shelf-source",
      }));

      build.onResolve({ filter: /^\./, namespace: "app-shelf-source" }, () => ({
        errors: [{ text: "Local file imports are not supported by the Bundler MVP." }],
      }));

      build.onLoad({ filter: /^entry\.jsx$/, namespace: "app-shelf-source" }, () => ({
        loader: "jsx",
        contents: `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(React.createElement(App));
`,
      }));

      build.onLoad({ filter: /^App\.jsx$/, namespace: "app-shelf-source" }, () => ({
        loader: "jsx",
        contents: code || "",
      }));
    },
  };
}

function appShelfNpmPlugin() {
  return {
    name: "app-shelf-npm",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "app-shelf-react" }));
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: "react-jsx-runtime", namespace: "app-shelf-react" }));
      build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: "react-jsx-runtime", namespace: "app-shelf-react" }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: "react-dom-client", namespace: "app-shelf-react" }));
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: "react-dom-client", namespace: "app-shelf-react" }));

      build.onResolve({ filter: /^https?:\/\// }, (args) => {
        if (args.namespace === "http-url") return resolveAllowedHttpUrl(args.path);
        return {
          errors: [{ text: "Direct URL imports are not allowed. Use a bare npm package import instead." }],
        };
      });
      build.onResolve({ filter: /.*/, namespace: "http-url" }, (args) => {
        if (args.path.startsWith("/")) return resolveAllowedHttpUrl(`https://${BUNDLE_CDN_HOST}${args.path}`);
        if (/^https?:\/\//.test(args.path)) return resolveAllowedHttpUrl(args.path);
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          return resolveAllowedHttpUrl(new URL(args.path, args.importer).toString());
        }
        return resolveNpmImport(args.path);
      });

      build.onResolve({ filter: /^[^./@][^:]*$|^@[^/]+\/[^/]+/ }, (args) => {
        if (args.namespace !== "http-url") return resolveNpmImport(args.path);
        return null;
      });

      build.onLoad({ filter: /.*/, namespace: "app-shelf-react" }, (args) => {
        if (args.path === "react-dom-client") {
          return {
            loader: "js",
            contents: `const ReactDOM = window.ReactDOM;
export const createRoot = ReactDOM.createRoot;
export const hydrateRoot = ReactDOM.hydrateRoot;
export default ReactDOM;`,
          };
        }

        if (args.path === "react-jsx-runtime") {
          return {
            loader: "js",
            contents: `const React = window.React;
function jsx(type, props, key) {
  return React.createElement(type, key === undefined ? props : { ...props, key });
}
export const Fragment = React.Fragment;
export { jsx };
export const jsxs = jsx;
export const jsxDEV = jsx;`,
          };
        }

        return {
          loader: "js",
          contents: `const React = window.React;
export default React;
export const Children = React.Children;
export const Fragment = React.Fragment;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;`,
        };
      });

      build.onLoad({ filter: /.*/, namespace: "http-url" }, async (args) => {
        const response = await fetchWithTimeout(args.path);
        const contents = await response.text();
        const pathname = new URL(args.path).pathname;
        const loader = pathname.endsWith(".css") ? "css" : "js";
        return { contents, loader, resolveDir: args.path };
      });
    },
  };
}

function resolveNpmImport(specifier) {
  try {
    return { path: npmToEsmUrl(specifier), namespace: "http-url" };
  } catch (err) {
    return { errors: [{ text: err.message }] };
  }
}

function resolveAllowedHttpUrl(value) {
  try {
    return { path: normalizeAllowedBundleUrl(value), namespace: "http-url" };
  } catch (err) {
    return { errors: [{ text: err.message }] };
  }
}

function npmToEsmUrl(specifier) {
  const clean = String(specifier || "").trim();
  const validSpecifier = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9._+~-]+)?(?:\/[a-z0-9._~!$&'()*+,;=:@%-]+)*$/i;
  if (!validSpecifier.test(clean)) throw new Error(`Unsupported npm import specifier: ${clean || "(empty)"}`);
  const encoded = clean.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://${BUNDLE_CDN_HOST}/${encoded}?bundle&external=react,react-dom`;
}

async function fetchWithTimeout(url) {
  const safeUrl = normalizeAllowedBundleUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUNDLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not fetch ${safeUrl}: ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAllowedBundleUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("Bundler rejected an invalid dependency URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Bundler dependency fetches must use HTTPS.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== BUNDLE_CDN_HOST && !hostname.endsWith(`.${BUNDLE_CDN_HOST}`)) {
    throw new Error(`Bundler dependency fetches are restricted to ${BUNDLE_CDN_HOST}.`);
  }

  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function extractBarePackageImports(code) {
  const packages = new Set();
  const importPatterns = [
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"'.\/][^"']*)["']/g,
    /\bimport\s*\(\s*["']([^"'.\/][^"']*)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'.\/][^"']*)["']\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(code || ""))) {
      const pkg = packageNameFromSpecifier(match[1]);
      if (pkg && !["react", "react-dom"].includes(pkg)) packages.add(pkg);
    }
  }

  return [...packages].sort();
}

function packageNameFromSpecifier(specifier) {
  const clean = String(specifier || "").trim();
  if (!clean || clean.startsWith(".") || clean.startsWith("/") || clean.includes(":")) return "";
  if (clean.startsWith("@")) return clean.split("/").slice(0, 2).join("/");
  return clean.split("/")[0];
}

function trimBuildError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length) {
    return err.errors
      .slice(0, 5)
      .map((item) => item.text || String(item))
      .join("\n")
      .slice(0, 4000);
  }
  return String(err && (err.stack || err.message) ? err.message : err).slice(0, 4000);
}

function renderBundledApp(row) {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI App Shelf Bundle</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <style>
      html, body, #root { min-height: 100%; }
      body { margin: 0; }
      ${escapeStyleContent(row.bundle_css || "")}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
${escapeScriptContent(row.bundle_js || "")}
    </script>
  </body>
</html>`;
}

function escapeStyleContent(value) {
  return String(value).replace(/<\/style/gi, "<\\/style");
}

function escapeScriptContent(value) {
  return String(value).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
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

function queueScreenshotThumbnail(id) {
  if (!ENABLE_SCREENSHOT_THUMBNAILS || screenshotThumbnailUnavailable) return;
  const appId = Number.parseInt(id, 10);
  if (!Number.isFinite(appId) || appId <= 0 || screenshotThumbnailQueuedIds.has(appId)) return;

  screenshotThumbnailQueuedIds.add(appId);
  screenshotThumbnailQueue.push(appId);
  setImmediate(processScreenshotThumbnailQueue);
}

function queueScreenshotThumbnailBackfill() {
  if (!ENABLE_SCREENSHOT_THUMBNAILS || SCREENSHOT_THUMBNAIL_BACKFILL_LIMIT <= 0) return;
  const rows = db
    .prepare(
      `SELECT id
       FROM apps
       WHERE thumbnail IS NULL
          OR thumbnail = ''
          OR thumbnail LIKE 'data:image/svg+xml%'
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
    )
    .all(SCREENSHOT_THUMBNAIL_BACKFILL_LIMIT);

  for (const row of rows) queueScreenshotThumbnail(row.id);
}

async function processScreenshotThumbnailQueue() {
  if (screenshotThumbnailWorkerActive || screenshotThumbnailUnavailable) return;
  screenshotThumbnailWorkerActive = true;

  try {
    while (screenshotThumbnailQueue.length && !screenshotThumbnailUnavailable) {
      const appId = screenshotThumbnailQueue.shift();
      screenshotThumbnailQueuedIds.delete(appId);

      try {
        await generateAndStoreScreenshotThumbnail(appId);
      } catch (err) {
        handleScreenshotThumbnailError(err);
      }
    }
  } finally {
    screenshotThumbnailWorkerActive = false;
  }
}

async function generateAndStoreScreenshotThumbnail(id) {
  const row = db.prepare("SELECT id, updated_at FROM apps WHERE id = ?").get(id);
  if (!row) return;

  const thumbnail = await captureAppScreenshotThumbnail(row.id);
  db.prepare("UPDATE apps SET thumbnail = ? WHERE id = ? AND updated_at = ?").run(thumbnail, row.id, row.updated_at);
}

async function captureAppScreenshotThumbnail(id) {
  const browser = await getScreenshotBrowser();
  const localOrigin = getLocalRunOrigin();
  const context = await browser.newContext({
    viewport: { width: SCREENSHOT_THUMBNAIL_WIDTH, height: SCREENSHOT_THUMBNAIL_HEIGHT },
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
    ...(APP_PASSWORD ? { httpCredentials: { username: APP_USERNAME, password: APP_PASSWORD } } : {}),
  });

  try {
    await context.route("**/*", (route) => handleScreenshotRoute(route, localOrigin));
    const page = await context.newPage();
    page.setDefaultTimeout(SCREENSHOT_THUMBNAIL_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(SCREENSHOT_THUMBNAIL_TIMEOUT_MS);
    await page.goto(`${localOrigin}/run/${id}`, {
      waitUntil: "domcontentloaded",
      timeout: SCREENSHOT_THUMBNAIL_TIMEOUT_MS,
    });
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(300);
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 82,
      fullPage: false,
      animations: "disabled",
    });
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } finally {
    await context.close();
  }
}

async function getScreenshotBrowser() {
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    screenshotThumbnailUnavailable = true;
    throw new Error(
      "No Chrome/Chromium executable found for screenshot thumbnails. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or disable ENABLE_SCREENSHOT_THUMBNAILS."
    );
  }

  if (!screenshotBrowserPromise) {
    const { chromium } = require("playwright-core");
    screenshotBrowserPromise = chromium
      .launch({
        executablePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      })
      .catch((err) => {
        screenshotBrowserPromise = null;
        throw err;
      });
  }

  const browser = await screenshotBrowserPromise;
  if (!browser.isConnected()) {
    screenshotBrowserPromise = null;
    return getScreenshotBrowser();
  }
  return browser;
}

function findChromiumExecutable() {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || process.env.CHROME_PATH;
  const candidates = [
    envPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function handleScreenshotRoute(route, localOrigin) {
  const url = route.request().url();
  try {
    if (await isAllowedScreenshotRequest(url, localOrigin)) {
      await route.continue();
    } else {
      await route.abort();
    }
  } catch {
    try {
      await route.abort();
    } catch {}
  }
}

async function isAllowedScreenshotRequest(value, localOrigin) {
  if (value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("about:")) return true;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.origin === localOrigin) return true;
  if (parsed.protocol !== "https:") return false;
  if (await hostnameResolvesToPrivate(parsed.hostname)) return false;
  return true;
}

async function hostnameResolvesToPrivate(hostname) {
  const clean = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!clean) return true;
  if (["localhost", "localhost.localdomain"].includes(clean)) return true;

  const ipType = net.isIP(clean);
  if (ipType) return isPrivateIp(clean);

  const cached = screenshotDnsCache.get(clean);
  if (cached && cached.expiresAt > Date.now()) return cached.private;

  try {
    const addresses = await dns.lookup(clean, { all: true });
    const isPrivate = addresses.some((address) => isPrivateIp(address.address));
    screenshotDnsCache.set(clean, { private: isPrivate, expiresAt: Date.now() + 5 * 60 * 1000 });
    return isPrivate;
  } catch {
    return true;
  }
}

function isPrivateIp(value) {
  const ip = String(value || "").toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);

  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (net.isIP(ip) === 6) {
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip)
    );
  }

  return true;
}

function getLocalRunOrigin() {
  return `http://127.0.0.1:${PORT}`;
}

function handleScreenshotThumbnailError(err) {
  if (!screenshotThumbnailWarningLogged) {
    screenshotThumbnailWarningLogged = true;
    console.warn(`Screenshot thumbnails unavailable: ${err.message}`);
  }
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

  const selectFields = publicAppFields();
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

  res.json(appsResponse(rows));
});

app.get("/api/apps/:id", (req, res) => {
  const row = db
    .prepare(`SELECT ${detailAppFields()} FROM apps WHERE id = ?`)
    .get(req.params.id);
  if (!row) throw httpError(404, "App not found");
  res.json(appResponse(row));
});

app.post(
  "/api/apps",
  asyncRoute(async (req, res) => {
    const body = getBodyObject(req);
    const appInput = prepareStoredApp(normalizeAppInput(body));
    const starred = body.starred ? 1 : 0;
    const result = db
      .prepare("INSERT INTO apps (name, description, tags, code, thumbnail, starred) VALUES (?, ?, ?, ?, ?, ?)")
      .run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail, starred);

    const saved = await rebuildAppBundle(result.lastInsertRowid);
    queueScreenshotThumbnail(saved.id);
    res.status(201).json(appResponse(db.prepare(`SELECT ${publicAppFields()} FROM apps WHERE id = ?`).get(saved.id)));
  })
);

app.put(
  "/api/apps/:id",
  asyncRoute(async (req, res) => {
    const existing = db.prepare("SELECT * FROM apps WHERE id = ?").get(req.params.id);
    if (!existing) throw httpError(404, "App not found");

    const body = getBodyObject(req);
    const appInput = prepareStoredApp(normalizeAppInput(body, existing));
    const starred = Object.hasOwn(body, "starred") ? (body.starred ? 1 : 0) : (existing.starred ?? 0);
    db.prepare(
      "UPDATE apps SET name = ?, description = ?, tags = ?, code = ?, thumbnail = ?, starred = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail, starred, req.params.id);

    const saved = await rebuildAppBundle(req.params.id);
    queueScreenshotThumbnail(saved.id);
    res.json(appResponse(db.prepare(`SELECT ${publicAppFields()} FROM apps WHERE id = ?`).get(saved.id)));
  })
);

app.post(
  "/api/apps/:id/build",
  asyncRoute(async (req, res) => {
    const appRow = await rebuildAppBundle(req.params.id);
    res.json({ ok: true, app: appRow });
  })
);

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
  const row = db
    .prepare("SELECT code, bundle_js, bundle_css, build_status FROM apps WHERE id = ?")
    .get(req.params.id);
  if (!row) return res.status(404).send("App not found");

  if (row.build_status === "ready" && row.bundle_js) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-App-Shelf-Source-Type", "bundle");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'unsafe-inline' https:",
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
    res.send(renderBundledApp(row));
    return;
  }

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

    const allApps = db
      .prepare("SELECT id, name, description, tags, code, starred, created_at, updated_at FROM apps ORDER BY id")
      .all();
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
    const changedIds = [];

    db.transaction((apps) => {
      const findByName = db.prepare("SELECT id FROM apps WHERE name = ?");
      const updateApp = db.prepare(
        `UPDATE apps
         SET description = ?,
             tags = ?,
             code = ?,
             thumbnail = ?,
             bundle_hash = '',
             bundle_js = '',
             bundle_css = '',
             build_status = 'idle',
             build_error = '',
             build_dependencies = '[]',
             build_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      );
      const insertApp = db.prepare(
        "INSERT INTO apps (name, description, tags, code, thumbnail) VALUES (?, ?, ?, ?, ?)"
      );

      for (const remoteApp of apps) {
        const appInput = prepareStoredApp(remoteApp);
        const existing = findByName.get(remoteApp.name);
        if (existing) {
          updateApp.run(appInput.description, appInput.tags, appInput.code, appInput.thumbnail, existing.id);
          changedIds.push(existing.id);
          updated++;
        } else {
          const result = insertApp.run(appInput.name, appInput.description, appInput.tags, appInput.code, appInput.thumbnail);
          changedIds.push(result.lastInsertRowid);
          added++;
        }
      }
    })(remoteApps);

    for (const id of changedIds) queueScreenshotThumbnail(id);
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
  queueScreenshotThumbnailBackfill();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    if (screenshotBrowserPromise) {
      try {
        const browser = await screenshotBrowserPromise;
        await browser.close();
      } catch {}
    }
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
