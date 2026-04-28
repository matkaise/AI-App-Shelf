const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function startServer(env) {
  const port = await getFreePort();
  const dataDir = path.join(root, `.test-data-${port}`);
  fs.rmSync(dataDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
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

async function stopServer(server) {
  server.child.kill();
  await sleep(200);
  fs.rmSync(server.dataDir, { recursive: true, force: true });
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

function testRendererWarnings() {
  const renderer = require(path.join(root, "public", "render.js"));
  const rendered = renderer.renderRunnableApp(`import { Star } from "lucide-react";

export default function App() {
  return <Star />;
}`);

  expect(rendered.type === "react", "renderer should detect React snippets");
  expect(rendered.warnings.some((warning) => warning.includes("Unsupported import removed")), "unsupported imports should be reported");
  expect(rendered.html.includes("Unsupported import removed by AI App Shelf"), "rendered HTML should include a removed import comment");
}

async function testFailClosed() {
  const server = await startServer({ APP_PASSWORD: "", ALLOW_UNAUTHENTICATED: "" });
  try {
    const response = await fetch(`${server.base}/`);
    expect(response.status === 503, `expected fail-closed 503, got ${response.status}`);
  } finally {
    await stopServer(server);
  }
}

async function testAppFlow() {
  const server = await startServer({ ALLOW_UNAUTHENTICATED: "true", APP_PASSWORD: "", APP_SECRET: "test-secret" });
  try {
    const html = await fetch(`${server.base}/`).then((res) => res.text());
    expect(html.includes("/render.js"), "index should load shared renderer");

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

    const run = await fetch(`${server.base}/run/${app.id}`);
    expect(run.headers.get("x-app-shelf-source-type") === "react", "react source type not detected");
    const rendered = await run.text();
    expect(rendered.includes("react.production.min.js"), "react runtime missing");
    expect(!rendered.includes("import React"), "react import was not stripped");

    const settings = await fetch(`${server.base}/api/settings`).then((res) => res.json());
    expect(!Object.hasOwn(settings, "githubToken"), "settings leaked githubToken");

    const { response: settingsResponse } = await requestJson(`${server.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-App-Shelf-Request": "1" },
      body: JSON.stringify({ githubToken: "ghp_secret_for_test" }),
    });
    expect(settingsResponse.ok, `settings save failed: ${settingsResponse.status}`);

    const db = new Database(path.join(server.dataDir, "apps.db"), { readonly: true });
    const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get("githubToken").value;
    db.close();
    expect(stored.startsWith("enc:v1:"), "stored GitHub token should be encrypted");
    expect(!stored.includes("ghp_secret_for_test"), "stored GitHub token leaked plaintext");
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

(async () => {
  testRendererWarnings();
  await testFailClosed();
  await testAppFlow();
  await testTokenRequiresSecret();
  await testBasicAuth();
  console.log("smoke tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
