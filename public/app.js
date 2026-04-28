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
    "appDialog",
    "appForm",
    "editorMode",
    "editorTitle",
    "closeAppDialogBtn",
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
  els.closeAppDialogBtn.addEventListener("click", closeEditor);
  els.appDialog.addEventListener("click", closeDialogOnBackdrop);
  els.appDialog.addEventListener("cancel", () => {
    window.clearTimeout(state.previewTimer);
  });
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
    if (!els.appDialog.open) return;
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
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${app.name} öffnen`);
    if (app.id === state.selectedId) card.classList.add("selected");
    card.addEventListener("click", () => loadApp(app.id));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadApp(app.id);
    });

    const preview = document.createElement("div");
    preview.className = "card-preview";

    const frame = document.createElement("iframe");
    frame.title = `${app.name} Vorschau`;
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock");
    frame.src = `/run/${app.id}`;
    preview.append(frame);

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

    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.append(tagList);

    body.append(titleRow, description, meta);
    card.append(preview, body);
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
    fillEditor(saved);
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
    closeEditor();
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
  els.previewFrame.srcdoc = AppShelfRenderer.renderRunnableApp(els.codeInput.value).html;
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
  const authText = settings.authConfigured
    ? "Auth: aktiv"
    : settings.authRequired
      ? "Auth: gesperrt, Passwort fehlt"
      : "Auth: bewusst deaktiviert";
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
    const skipped = result.skipped ? `, ${result.skipped} übersprungen` : "";
    const detail =
      direction === "pull" ? `${result.added} neu, ${result.updated} aktualisiert${skipped}` : `${result.count} Apps`;
    showToast(`GitHub ${direction}: ${detail}.`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setBusy(button, false, direction === "push" ? "Push" : "Pull");
  }
}

function splitTags(value) {
  return String(value || "")
    .split(",")
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
  if (typeof els.appDialog.showModal === "function") {
    if (!els.appDialog.open) els.appDialog.showModal();
  } else {
    showToast("Dein Browser unterstützt Dialoge nicht.", true);
  }
}

function closeEditor() {
  if (els.appDialog.open) els.appDialog.close();
}

function closeDialogOnBackdrop(event) {
  if (event.target === els.appDialog) closeEditor();
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
