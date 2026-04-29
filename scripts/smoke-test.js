const { spawn } = require("child_process");
const { once } = require("events");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function startServer(env, options = {}) {
  const port = await getFreePort();
  const dataDir = path.join(root, `.test-data-${port}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (options.beforeStart) await options.beforeStart(dataDir);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ENABLE_SCREENSHOT_THUMBNAILS: "false", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base, child, dataDir, output: () => output };
    } catch {}
    await sleep(100);
  }

  child.kill();
  throw new Error(`server did not start: ${output}`);
}

async function stopServer(server, options = {}) {
  if (server.child.exitCode === null) {
    server.child.kill();
    await Promise.race([once(server.child, "exit"), sleep(5000)]);
  }
  if (options.removeData !== false) fs.rmSync(server.dataDir, { recursive: true, force: true });
}

async function getFreePort() {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function legacyEncryptSecret(secret, value) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function testRendererImports() {
  const rendererPath = path.join(root, "public", "render.js");
  const renderer = require(rendererPath);
  const supported = renderer.renderRunnableApp(`import { Star as Icon } from "lucide-react";

export default function App() {
  return <Icon />;
}`);

  expect(supported.type === "react", "renderer should detect React snippets");
  expect(!supported.warnings.some((warning) => warning.includes("Unsupported import removed")), "lucide imports should be supported");
  expect(supported.html.includes("lucide-react@1.11.0"), "supported import should load lucide-react from CDN");
  expect(supported.html.includes('const Icon = __appShelfPick'), "supported named import should become a local binding");

  const unsupported = renderer.renderRunnableApp(`import { Widget } from "not-a-real-canvas-lib";

export default function App() {
  return <Widget />;
}`);

  expect(
    unsupported.warnings.some((warning) => warning.includes("Unsupported import removed")),
    "unsupported imports should still be reported"
  );
  expect(
    unsupported.html.includes("Unsupported import removed by AI App Shelf"),
    "rendered HTML should include a removed import comment"
  );
  delete globalThis.AppShelfRenderer;
}

async function testFailClosed() {
  const server = await startServer({ APP_PASSWORD: "", ALLOW_UNAUTHENTICATED: "" });
  try {
    const health = await fetch(`${server.base}/health`);
    expect(health.ok, `expected health to stay open, got ${health.status}`);

    const response = await fetch(`${server.base}/`);
    expect(response.status === 503, `expected fail-closed 503, got ${response.status}`);
  } finally {
    await stopServer(server);
  }
}

async function testAppFlow() {
  const server = await startServer({ ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "test-secret" });
  let stoppedForDbRead = false;
  try {
    const indexResponse = await fetch(`${server.base}/`);
    const html = await indexResponse.text();
    expect(html.includes("/render.js"), "index should load shared renderer");
    expect(
      indexResponse.headers.get("content-security-policy").includes("frame-ancestors 'none'"),
      "index should block framing"
    );

    const blocked = await fetch(`${server.base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blocked", code: "<!doctype html>" }),
    });
    expect(blocked.status === 403, `expected write header block, got ${blocked.status}`);

    const reactCode = `import React, { useState } from "react";
export default function App() {
  const [count, setCount] = useState(0);
  return <button className="p-4" onClick={() => setCount(count + 1)}>Count {count}</button>;
}`;

    const { response: createResponse, body: app } = await requestJson(`${server.base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ name: "React Demo", tags: "hello world,finance", code: reactCode }),
    });
    expect(createResponse.status === 201, `create failed: ${createResponse.status}`);
    expect(app.thumbnail.startsWith("data:image/svg+xml;base64,"), "created app should include a static thumbnail");
    expect(app.build_status === "ready", `react app should build a bundle, got ${app.build_status}: ${app.build_error || ""}`);
    expect(Array.isArray(app.build_dependencies), "build_dependencies should be returned as an array");

    const detail = await fetch(`${server.base}/api/apps/${app.id}`).then((res) => res.json());
    expect(detail.code.includes("useState"), "app detail should include code for editing");
    expect(!Object.hasOwn(detail, "thumbnail"), "app detail should omit thumbnail payload");
    expect(Array.isArray(detail.build_dependencies), "detail build_dependencies should be returned as an array");

    const run = await fetch(`${server.base}/run/${app.id}`);
    expect(run.headers.get("x-app-shelf-source-type") === "bundle", "bundle source type not detected");
    expect(!run.headers.get("content-security-policy").includes("frame-ancestors"), "run CSP should remain embeddable");
    const rendered = await run.text();
    expect(rendered.includes("AI App Shelf Bundle"), "bundled document missing");
    expect(rendered.includes("https://cdn.tailwindcss.com"), "bundled document should load Tailwind");
    expect(!rendered.includes("import React"), "react import was not stripped");

    const tsxCode = `import React, { useState } from "react";

interface Probe {
  label: string;
  value: number;
}

const values: Record<string, number> = { first: 1 };

const App: React.FC = () => {
  const [mode] = useState<"save" | "invest">("invest");
  const probe: Probe = { label: mode, value: values.first };
  return <div className="p-4">{probe.label}:{probe.value}</div>;
};

export default App;`;
    const { response: tsxResponse, body: tsxApp } = await requestJson(`${server.base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ name: "TSX Demo", tags: "tsx", code: tsxCode }),
    });
    expect(tsxResponse.status === 201, `tsx create failed: ${tsxResponse.status}`);
    expect(tsxApp.build_status === "ready", `tsx app should build a bundle, got ${tsxApp.build_status}: ${tsxApp.build_error || ""}`);

    const settings = await fetch(`${server.base}/api/settings`).then((res) => res.json());
    expect(!Object.hasOwn(settings, "githubToken"), "settings leaked githubToken");

    const { response: settingsResponse } = await requestJson(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ githubToken: "ghp_secret_for_test" }),
    });
    expect(settingsResponse.ok, `settings save failed: ${settingsResponse.status}`);

    await stopServer(server, { removeData: false });
    stoppedForDbRead = true;

    const db = new Database(path.join(server.dataDir, "apps.db"), { readonly: true });
    const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get("githubToken").value;
    const salt = db.prepare("SELECT value FROM settings WHERE key = ?").get("secretSalt").value;
    db.close();
    expect(stored.startsWith("enc:v2:"), "stored GitHub token should use scrypt-backed v2 encryption");
    expect(Boolean(salt), "secret salt should be stored with the database");
    expect(!stored.includes("ghp_secret_for_test"), "stored GitHub token leaked plaintext");
  } finally {
    if (stoppedForDbRead) fs.rmSync(server.dataDir, { recursive: true, force: true });
    else await stopServer(server);
  }
}

function startProbeServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end("export default 1;");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/module.js`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function testBundlerRejectsDirectUrl() {
  const probe = await startProbeServer();
  const server = await startServer({ ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "test-secret" });
  try {
    const code = `import React from "react";
import "${probe.url}";

export default function App() {
  return <div>blocked</div>;
}`;
    const { response, body } = await requestJson(`${server.base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ name: "Blocked URL Import", tags: "security", code }),
    });

    expect(response.status === 201, `direct URL import app create failed: ${response.status}`);
    expect(body.build_status === "error", `expected direct URL import to fail bundle, got ${body.build_status}`);
    expect(body.build_error.includes("Direct URL imports are not allowed"), "direct URL import should be rejected clearly");
    expect(probe.hits() === 0, `direct URL import should not be fetched, got ${probe.hits()} hits`);
  } finally {
    await stopServer(server);
    await probe.close();
  }
}

async function testOnlineDependencyBundle() {
  const server = await startServer({ ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "test-secret" });
  try {
    const dependencyCode = `import React from "react";
import { LineChart, Line } from "recharts";
import { Upload } from "lucide-react";

interface Point {
  name: string;
  value: number;
}

const data: Point[] = [{ name: "A", value: 1 }];

export default function App() {
  return <div><Upload /><LineChart width={120} height={80} data={data}><Line dataKey="value" /></LineChart></div>;
}`;
    const { response, body } = await requestJson(`${server.base}/api/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ name: "Bundled Dependency", tags: "bundle", code: dependencyCode }),
    });

    expect(response.status === 201, `dependency app create failed: ${response.status}`);
    expect(body.build_status === "ready", `dependency app should bundle, got ${body.build_status}: ${body.build_error || ""}`);
    expect(body.build_dependencies.includes("recharts"), "dependency list should include recharts");
    expect(body.build_dependencies.includes("lucide-react"), "dependency list should include lucide-react");

    const dependencyRun = await fetch(`${server.base}/run/${body.id}`);
    expect(dependencyRun.headers.get("x-app-shelf-source-type") === "bundle", "dependency bundle source type not detected");
  } finally {
    await stopServer(server);
  }
}

async function testTokenRequiresSecret() {
  const server = await startServer({ ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "" });
  try {
    const { response } = await requestJson(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ githubToken: "ghp_no_secret" }),
    });
    expect(response.status === 400, `expected token save without APP_SECRET to fail, got ${response.status}`);
  } finally {
    await stopServer(server);
  }
}

async function testPlaintextTokenIsReported() {
  const server = await startServer({
    ALLOW_UNAUTHENTICATED: "true",
    APP_PASSWORD: "",
    APP_SECRET: "",
    ALLOW_PLAINTEXT_SECRETS: "true",
  });
  try {
    const { response } = await requestJson(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ githubToken: "ghp_plaintext_allowed" }),
    });
    expect(response.ok, `expected plaintext token save to be allowed, got ${response.status}`);

    const settings = await fetch(`${server.base}/api/settings`).then((res) => res.json());
    expect(settings.githubTokenStorage === "plaintext", "settings should report plaintext token storage");
    expect(settings.githubTokenSource === "database-plaintext", "settings should report plaintext database source");
  } finally {
    await stopServer(server);
  }
}

async function testTokenMigratesAtBootOnly() {
  const server = await startServer(
    { ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "migration-secret" },
    {
      beforeStart(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        const db = new Database(path.join(dataDir, "apps.db"));
        db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("githubToken", "ghp_plaintext_migration");
        db.close();
      },
    }
  );

  try {
    const db = new Database(path.join(server.dataDir, "apps.db"));
    const migrated = db.prepare("SELECT value FROM settings WHERE key = ?").get("githubToken").value;
    expect(migrated.startsWith("enc:v2:"), "plaintext token should migrate to v2 on boot");
    expect(!migrated.includes("ghp_plaintext_migration"), "migrated token leaked plaintext");

    const settings = await fetch(`${server.base}/api/settings`).then((res) => res.json());
    expect(settings.githubTokenStorage === "encrypted", "settings should report encrypted token storage");

    const afterRead = db.prepare("SELECT value FROM settings WHERE key = ?").get("githubToken").value;
    db.close();
    expect(afterRead === migrated, "GET /api/settings should not rewrite migrated token");
  } finally {
    await stopServer(server);
  }
}

async function testV1TokenMigratesToV2() {
  const secret = "legacy-migration-secret";
  const v1Token = legacyEncryptSecret(secret, "ghp_v1_migration");
  const server = await startServer(
    { ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: secret },
    {
      beforeStart(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        const db = new Database(path.join(dataDir, "apps.db"));
        db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("githubToken", v1Token);
        db.close();
      },
    }
  );
  let stoppedForDbRead = false;

  try {
    const settings = await fetch(`${server.base}/api/settings`).then((res) => res.json());
    expect(settings.githubTokenStorage === "encrypted", "v1 migration should report encrypted storage");

    await stopServer(server, { removeData: false });
    stoppedForDbRead = true;

    const db = new Database(path.join(server.dataDir, "apps.db"), { readonly: true });
    const migrated = db.prepare("SELECT value FROM settings WHERE key = ?").get("githubToken").value;
    db.close();
    expect(migrated.startsWith("enc:v2:"), "v1 token should migrate to v2 on boot");
    expect(migrated !== v1Token, "v1 token should be replaced during migration");
  } finally {
    if (stoppedForDbRead) fs.rmSync(server.dataDir, { recursive: true, force: true });
    else await stopServer(server);
  }
}

async function testBasicAuth() {
  const server = await startServer({ APP_USERNAME: "admin", APP_PASSWORD: "secret" });
  try {
    const denied = await fetch(`${server.base}/api/apps`);
    expect(denied.status === 401, `expected 401, got ${denied.status}`);

    const allowed = await fetch(`${server.base}/api/apps`, {
      headers: { Authorization: authHeader("admin", "secret") },
    });
    expect(allowed.ok, `expected authorized request, got ${allowed.status}`);
  } finally {
    await stopServer(server);
  }
}

async function testBasicAuthRateLimit() {
  const server = await startServer({ APP_USERNAME: "admin", APP_PASSWORD: "secret" });
  try {
    for (let i = 0; i < 29; i++) {
      const denied = await fetch(`${server.base}/api/apps`, {
        headers: { Authorization: authHeader("admin", "wrong") },
      });
      expect(denied.status === 401, `expected 401 before rate limit, got ${denied.status}`);
    }

    const reset = await fetch(`${server.base}/api/apps`, {
      headers: { Authorization: authHeader("admin", "secret") },
    });
    expect(reset.ok, `expected successful auth to reset failures, got ${reset.status}`);

    for (let i = 0; i < 30; i++) {
      const denied = await fetch(`${server.base}/api/apps`, {
        headers: { Authorization: authHeader("admin", "wrong") },
      });
      expect(denied.status === 401, `expected 401 before rate limit after reset, got ${denied.status}`);
    }

    const limited = await fetch(`${server.base}/api/apps`, {
      headers: { Authorization: authHeader("admin", "wrong") },
    });
    expect(limited.status === 429, `expected 429 after repeated auth failures, got ${limited.status}`);
  } finally {
    await stopServer(server);
  }
}

async function testTrustProxyRateLimitIsolation() {
  const server = await startServer({ APP_USERNAME: "admin", APP_PASSWORD: "secret", TRUST_PROXY: "1" });
  try {
    for (let i = 0; i < 30; i++) {
      const denied = await fetch(`${server.base}/api/apps`, {
        headers: {
          Authorization: authHeader("admin", "wrong"),
          "X-Forwarded-For": "203.0.113.10",
        },
      });
      expect(denied.status === 401, `expected proxied 401 before rate limit, got ${denied.status}`);
    }

    const limited = await fetch(`${server.base}/api/apps`, {
      headers: {
        Authorization: authHeader("admin", "wrong"),
        "X-Forwarded-For": "203.0.113.10",
      },
    });
    expect(limited.status === 429, `expected proxied IP to be limited, got ${limited.status}`);

    const otherIp = await fetch(`${server.base}/api/apps`, {
      headers: {
        Authorization: authHeader("admin", "wrong"),
        "X-Forwarded-For": "203.0.113.11",
      },
    });
    expect(otherIp.status === 401, `expected another proxied IP to have its own bucket, got ${otherIp.status}`);
  } finally {
    await stopServer(server);
  }
}

(async () => {
  testRendererImports();
  await testFailClosed();
  await testAppFlow();
  await testBundlerRejectsDirectUrl();
  if (process.argv.includes("--online")) await testOnlineDependencyBundle();
  await testTokenRequiresSecret();
  await testPlaintextTokenIsReported();
  await testTokenMigratesAtBootOnly();
  await testV1TokenMigratesToV2();
  await testBasicAuth();
  await testBasicAuthRateLimit();
  await testTrustProxyRateLimitIsolation();
  console.log("smoke tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
