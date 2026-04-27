const state = {
  apps: [],
  selectedId: null,
  selectedApp: null,
  search: "",
  settings: null,
  previewTimer: null,
  searchTimer: null,
};

const els = {};

const starterHtml = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Meine App</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, sans-serif;
        background: #f6f8f6;
        color: #18211d;
      }
      main {
        width: min(760px, calc(100vw - 32px));
        padding: 28px;
        border: 1px solid #d8dfd8;
        border-radius: 8px;
        background: white;
      }
      button {
        border: 0;
        border-radius: 8px;
        background: #0b766d;
        color: white;
        padding: 10px 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Meine App</h1>
      <p>Bereit für dein HTML.</p>
      <button type="button" onclick="alert('Läuft!')">Test</button>
    </main>
  </body>
</html>`;

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  resetEditor();
  loadSettings();
  loadApps();
});

function bindElements() {
  for (const id of [
    "appCount",
    "pullBtn",
    "pushBtn",
    "settingsBtn",
    "newAppBtn",
    "refreshBtn",
    "searchInput",
    "emptyState",
    "emptyNewBtn",
    "appGrid",
    "editorPanel",
    "appForm",
    "editorMode",
    "editorTitle",
    "closeEditorBtn",
    "nameInput",
    "descriptionInput",
    "tagsInput",
    "codeInput",
    "saveBtn",
    "duplicateBtn",
    "openBtn",
    "deleteBtn",
    "previewFrame",
    "previewState",
    "settingsDialog",
    "settingsForm",
    "closeSettingsBtn",
    "repoInput",
    "branchInput",
    "fileInput",
    "tokenInput",
    "clearTokenInput",
    "settingsMeta",
    "saveSettingsBtn",
    "toast",
  ]) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  els.newAppBtn.addEventListener("click", () => {
    resetEditor();
    openEditor();
    els.nameInput.focus();
  });
  els.emptyNewBtn.addEventListener("click", () => els.newAppBtn.click());
  els.refreshBtn.addEventListener("click", () => loadApps());
  els.closeEditorBtn.addEventListener("click", closeEditor);
  els.appForm.addEventListener("submit", saveCurrentApp);
  els.duplicateBtn.addEventListener("click", duplicateCurrentApp);
  els.openBtn.addEventListener("click", openCurrentApp);
  els.deleteBtn.addEventListener("click", deleteCurrentApp);
  els.settingsBtn.addEventListener("click", openSettings);
  els.closeSettingsBtn.addEventListener("click", () => els.settingsDialog.close());
  els.settingsForm.addEventListener("submit", saveSettings);
  els.pushBtn.addEventListener("click", () => syncGithub("push"));
  els.pullBtn.addEventListener("click", () => syncGithub("pull"));

  els.searchInput.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      state.search = els.searchInput.value.trim();
      loadApps();
    }, 160);
  });

  els.codeInput.addEventListener("input", schedulePreview);
  els.nameInput.addEventListener("input", updateEditorTitle);

  window.addEventListener("keydown", (event) => {
    const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
    if (!isSave) return;
    event.preventDefault();
    els.appForm.requestSubmit();
  });
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  const init = { ...options, method, headers };
  if (!["GET", "HEAD"].includes(method)) headers.set("X-App-Shelf-Request", "1");

  if (options.body && typeof options.body !== "string") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }

  return data;
}

async function loadApps() {
  try {
    const params = new URLSearchParams();
    if (state.search) params.set("search", state.search);
    state.apps = await api(`/api/apps${params.toString() ? `?${params}` : ""}`);
    renderApps();
    updateCount();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadApp(id) {
  try {
    const app = await api(`/api/apps/${id}`);
    fillEditor(app);
    openEditor();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderApps() {
  els.appGrid.replaceChildren();
  els.emptyState.hidden = state.apps.length > 0;

  for (const app of state.apps) {
    const card = document.createElement("article");
    card.className = "app-card";
    if (app.id === state.selectedId) card.classList.add("selected");

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.setAttribute("aria-label", `${app.name} auswählen`);
    previewButton.addEventListener("click", () => loadApp(app.id));

    const frame = document.createElement("iframe");
    frame.title = `${app.name} Vorschau`;
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock");
    frame.src = `/run/${app.id}`;
    previewButton.append(frame);

    const body = document.createElement("div");
    body.className = "card-body";

    const titleRow = document.createElement("div");
    titleRow.className = "card-title-row";

    const title = document.createElement("h2");
    title.textContent = app.name;

    const date = document.createElement("span");
    date.className = "card-date";
    date.textContent = formatDate(app.updated_at);

    titleRow.append(title, date);

    const description = document.createElement("p");
    description.className = "card-description";
    description.textContent = app.description || "";

    const tagList = document.createElement("div");
    tagList.className = "tag-list";
    for (const tag of splitTags(app.tags).slice(0, 6)) {
      const tagEl = document.createElement("span");
      tagEl.className = "tag";
      tagEl.textContent = tag;
      tagList.append(tagEl);
    }

    body.append(titleRow, description, tagList);
    body.addEventListener("click", () => loadApp(app.id));
    card.append(previewButton, body);
    els.appGrid.append(card);
  }
}

function updateCount() {
  const count = state.apps.length;
  els.appCount.textContent = `${count} ${count === 1 ? "App" : "Apps"}`;
}

function fillEditor(app) {
  state.selectedId = app.id;
  state.selectedApp = app;
  els.editorMode.textContent = `App #${app.id}`;
  els.nameInput.value = app.name;
  els.descriptionInput.value = app.description || "";
  els.tagsInput.value = app.tags || "";
  els.codeInput.value = app.code || "";
  updateEditorTitle();
  updateEditorButtons();
  schedulePreview(true);
  renderApps();
}

function resetEditor() {
  state.selectedId = null;
  state.selectedApp = null;
  els.editorMode.textContent = "Neue App";
  els.nameInput.value = "";
  els.descriptionInput.value = "";
  els.tagsInput.value = "";
  els.codeInput.value = starterHtml;
  updateEditorTitle();
  updateEditorButtons();
  schedulePreview(true);
  renderApps();
}

function updateEditorTitle() {
  const name = els.nameInput.value.trim();
  els.editorTitle.textContent = name || "HTML oder React einfügen";
}

function updateEditorButtons() {
  const hasSavedApp = Boolean(state.selectedId);
  els.duplicateBtn.disabled = !hasSavedApp;
  els.openBtn.disabled = !hasSavedApp;
  els.deleteBtn.disabled = !hasSavedApp;
  els.previewState.textContent = hasSavedApp ? "Gespeicherte App" : "Entwurf";
}

function readEditorPayload() {
  return {
    name: els.nameInput.value.trim(),
    description: els.descriptionInput.value.trim(),
    tags: els.tagsInput.value.trim(),
    code: els.codeInput.value,
  };
}

async function saveCurrentApp(event) {
  event.preventDefault();
  const payload = readEditorPayload();
  if (!payload.name || !payload.code.trim()) {
    showToast("Name und App-Code sind erforderlich.", true);
    return;
  }

  setBusy(els.saveBtn, true, "Speichert");
  try {
    const saved = state.selectedId
      ? await api(`/api/apps/${state.selectedId}`, { method: "PUT", body: payload })
      : await api("/api/apps", { method: "POST", body: payload });

    showToast("Gespeichert.");
    await loadApps();
    await loadApp(saved.id);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(els.saveBtn, false, "Speichern");
  }
}

function duplicateCurrentApp() {
  if (!state.selectedApp) return;
  state.selectedId = null;
  state.selectedApp = null;
  els.editorMode.textContent = "Neue App";
  els.nameInput.value = `${els.nameInput.value.trim()} Kopie`.trim();
  updateEditorTitle();
  updateEditorButtons();
  schedulePreview(true);
  openEditor();
  els.nameInput.focus();
}

function openCurrentApp() {
  if (!state.selectedId) return;
  window.open(`/run/${state.selectedId}`, "_blank", "noopener,noreferrer");
}

async function deleteCurrentApp() {
  if (!state.selectedId || !state.selectedApp) return;
  const confirmed = window.confirm(`"${state.selectedApp.name}" löschen?`);
  if (!confirmed) return;

  setBusy(els.deleteBtn, true, "Löscht");
  try {
    await api(`/api/apps/${state.selectedId}`, { method: "DELETE" });
    showToast("Gelöscht.");
    resetEditor();
    await loadApps();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(els.deleteBtn, false, "Löschen");
    updateEditorButtons();
  }
}

function schedulePreview(immediate = false) {
  window.clearTimeout(state.previewTimer);
  if (immediate) {
    updatePreview();
    return;
  }
  state.previewTimer = window.setTimeout(updatePreview, 260);
}

function updatePreview() {
  els.previewFrame.removeAttribute("src");
  els.previewFrame.srcdoc = renderRunnableApp(els.codeInput.value);
}

function renderRunnableApp(code) {
  if (isLikelyReactCanvasApp(code)) return buildReactCanvasHtml(code);
  return code || "<!doctype html><html><body></body></html>";
}

function isLikelyReactCanvasApp(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) return false;
  if (/^\s*(?:<!doctype|<html|<head|<body)\b/i.test(trimmed)) return false;
  if (/^\s*</.test(trimmed) && !/\bclassName=|\{[^}]+\}/.test(trimmed)) return false;

  return /from\s+["']react["']|export\s+default\s+function|\buse(?:State|Memo|Effect|Ref|Callback|Reducer)\s*\(|\bclassName=|return\s*\(\s*</.test(
    trimmed
  );
}

function buildReactCanvasHtml(source) {
  const transformed = transformReactCanvasSource(source);
  const candidateChecks = transformed.componentNames
    .map((name) => `(typeof ${name} !== "undefined" ? ${name} : null)`)
    .join(",\n        ");

  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI App Shelf React App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
      html, body, #root { min-height: 100%; }
      body { margin: 0; }
      #app-shelf-error {
        margin: 16px;
        padding: 14px 16px;
        border: 1px solid #fecaca;
        border-radius: 8px;
        background: #fef2f2;
        color: #991b1b;
        font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <pre id="app-shelf-error" hidden></pre>
    <script>
      function showAppShelfError(error) {
        var target = document.getElementById("app-shelf-error");
        if (!target) return;
        target.hidden = false;
        target.textContent = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
      }

      window.addEventListener("error", function (event) {
        showAppShelfError(event.error || event.message);
      });

      window.addEventListener("unhandledrejection", function (event) {
        showAppShelfError(event.reason || "Unhandled promise rejection");
      });
    </script>
    <script type="text/babel" data-presets="env,react">
      const {
        Children, Fragment, StrictMode, Suspense, cloneElement, createContext, forwardRef,
        isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue,
        useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect,
        useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition
      } = React;

${escapeScriptContent(transformed.code)}

      const appShelfCandidates = [
        ${candidateChecks}
      ].filter(Boolean);
      const appShelfComponent = appShelfCandidates.find((candidate) => {
        return typeof candidate === "function" || (candidate && typeof candidate === "object");
      });

      if (!appShelfComponent) {
        throw new Error("No React component found. Export a default component or name it App.");
      }

      ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(appShelfComponent));
    </script>
  </body>
</html>`;
}

function transformReactCanvasSource(source) {
  let code = String(source || "").trim();
  let defaultComponent = null;

  code = code
    .replace(/^\s*import\s+(?:React\s*,\s*)?\{[^}]*\}\s+from\s+["']react["'];?\s*$/gm, "")
    .replace(/^\s*import\s+React\s+from\s+["']react["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[^;\n]+;?\s*$/gm, (line) => {
      return `/* Unsupported import removed by AI App Shelf: ${line.replace(/\*\//g, "* /")} */`;
    });

  code = code.replace(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/, (match, name) => {
    defaultComponent = name;
    return `function ${name}(`;
  });

  code = code.replace(/export\s+default\s+function\s*\(/, () => {
    defaultComponent = "App";
    return "function App(";
  });

  code = code.replace(/export\s+default\s+([A-Za-z_$][\w$]*);?/g, (match, name) => {
    defaultComponent = name;
    return "";
  });

  code = code
    .replace(/export\s+(function|class)\s+/g, "$1 ")
    .replace(/export\s+(const|let|var)\s+/g, "$1 ")
    .replace(/export\s+\{[^}]*\};?/g, "");

  const componentNames = [];
  if (defaultComponent) componentNames.push(defaultComponent);
  for (const name of guessReactComponentNames(code)) componentNames.push(name);
  componentNames.push("App");

  return {
    code,
    componentNames: [...new Set(componentNames.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)))],
  };
}

function guessReactComponentNames(code) {
  const names = [];
  const patterns = [
    /\bfunction\s+([A-Z][A-Za-z0-9_$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*function\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code))) names.push(match[1]);
  }

  return names;
}

function escapeScriptContent(value) {
  return String(value).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function loadSettings() {
  try {
    state.settings = await api("/api/settings");
    renderSettings();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderSettings() {
  const settings = state.settings || {};
  els.repoInput.value = settings.githubRepo || "";
  els.branchInput.value = settings.githubBranch || "main";
  els.fileInput.value = settings.githubFile || "apps.json";
  els.tokenInput.value = "";
  els.clearTokenInput.checked = false;

  const tokenText = settings.githubTokenConfigured
    ? `Token: ${settings.githubTokenSource === "environment" ? "per ENV gesetzt" : "gespeichert"}`
    : "Token: nicht gesetzt";
  const authText = settings.authConfigured ? "Auth: aktiv" : "Auth: per ENV deaktiviert";
  els.settingsMeta.textContent = `${tokenText} · ${authText}`;
}

async function openSettings() {
  await loadSettings();
  if (typeof els.settingsDialog.showModal === "function") {
    els.settingsDialog.showModal();
  } else {
    showToast("Dein Browser unterstützt Dialoge nicht.", true);
  }
}

async function saveSettings(event) {
  event.preventDefault();

  const payload = {
    githubRepo: els.repoInput.value.trim(),
    githubBranch: els.branchInput.value.trim() || "main",
    githubFile: els.fileInput.value.trim() || "apps.json",
  };

  if (els.clearTokenInput.checked) {
    payload.githubToken = "";
  } else if (els.tokenInput.value.trim()) {
    payload.githubToken = els.tokenInput.value.trim();
  }

  setBusy(els.saveSettingsBtn, true, "Speichert");
  try {
    await api("/api/settings", { method: "PUT", body: payload });
    await loadSettings();
    els.settingsDialog.close();
    showToast("Einstellungen gespeichert.");
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(els.saveSettingsBtn, false, "Speichern");
  }
}

async function syncGithub(direction) {
  const button = direction === "push" ? els.pushBtn : els.pullBtn;
  setBusy(button, true, direction === "push" ? "Pusht" : "Pullt");

  try {
    const result = await api(`/api/github/${direction}`, { method: "POST" });
    if (direction === "pull") await loadApps();
    const detail = direction === "pull" ? `${result.added} neu, ${result.updated} aktualisiert` : `${result.count} Apps`;
    showToast(`GitHub ${direction}: ${detail}.`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, direction === "push" ? "Push" : "Pull");
  }
}

function splitTags(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatDate(value) {
  if (!value) return "";
  const normalized = String(value).includes("T") ? value : `${String(value).replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function openEditor() {
  document.body.classList.add("editor-open");
}

function closeEditor() {
  document.body.classList.remove("editor-open");
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = busy ? `${label}...` : label;
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, isError ? 5200 : 2600);
}
