// ── State ──────────────────────────────────────────────────────────────────
const S = {
  dark: localStorage.getItem('shelf-dark') === '1',
  apps: [],
  search: '',
  activeTag: null,
  sort: 'recent',
  syncState: 'idle',
  syncTimer: null,
  settings: null,
  searchTimer: null,
  running: null,
  addStep: null,
  editingApp: null,
  confirmApp: null,
  uploadHtml: '',
  uploadTitle: '',
  uploadTags: '',
  thumbnailRefreshTimers: [],
};

const E = {};

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyDark(S.dark);
  buildUI();
  loadSettings();
  loadApps();
});

// ── Dark mode ──────────────────────────────────────────────────────────────
function applyDark(dark) {
  S.dark = dark;
  document.documentElement.toggleAttribute('data-dark', dark);
  localStorage.setItem('shelf-dark', dark ? '1' : '0');
  if (E.darkBtn) {
    E.darkBtn.innerHTML = dark ? svgSun() : svgMoon();
    E.darkBtn.title = dark ? 'Switch to light' : 'Switch to dark';
  }
}

// ── Main UI structure (built once) ─────────────────────────────────────────
function buildUI() {
  const shelf = document.getElementById('shelf');
  shelf.innerHTML = '';

  const topbar = el('div', 'topbar');
  topbar.innerHTML = `
    <div class="topbar-logo">
      <div class="logo-mark">
        <img src="/app-shelf-logo.png" alt="" />
      </div>
      <span class="logo-name">App Shelf</span>
      <span class="logo-version">v0.4</span>
    </div>
    <div class="topbar-spacer"></div>
    <div class="search-box">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="5" cy="5" r="3.5"/>
        <path d="M11 11L8 8" stroke-linecap="round"/>
      </svg>
      <input id="searchInput" placeholder="Search apps &amp; tags…" autocomplete="off" />
      <span id="searchShortcut" class="search-shortcut">Ctrl K</span>
    </div>
    <button id="darkBtn" class="icon-btn" type="button"></button>
    <button id="syncBtn" class="sync-btn" type="button">
      <svg id="syncIcon" class="sync-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12.5 6.5a5.5 5.5 0 0 0-9.7-3M1.5 7.5a5.5 5.5 0 0 0 9.7 3"/>
        <path d="M12.5 1v3.5H9M1.5 13v-3.5H5"/>
      </svg>
      <span id="syncLabel">Sync</span>
    </button>
    <button id="settingsBtn" class="icon-btn" type="button" title="Settings" aria-label="Settings">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 4.5h4"/>
        <path d="M9.5 4.5h4"/>
        <circle cx="8" cy="4.5" r="1.45"/>
        <path d="M2.5 11.5h7"/>
        <path d="M12.5 11.5h1"/>
        <circle cx="11" cy="11.5" r="1.45"/>
      </svg>
    </button>
    <button id="addBtn" class="add-btn" type="button">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M6 1.5v9M1.5 6h9"/>
      </svg>
      Add app
    </button>
  `;
  shelf.append(topbar);

  const content = el('div', '');
  content.id = 'pageContent';
  content.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';
  shelf.append(content);

  E.shelf = shelf;
  E.pageContent = content;
  E.searchInput = document.getElementById('searchInput');
  E.searchShortcut = document.getElementById('searchShortcut');
  E.darkBtn = document.getElementById('darkBtn');
  E.syncBtn = document.getElementById('syncBtn');
  E.syncIcon = document.getElementById('syncIcon');
  E.syncLabel = document.getElementById('syncLabel');
  E.addBtn = document.getElementById('addBtn');
  E.settingsBtn = document.getElementById('settingsBtn');
  E.toast = document.getElementById('toast');

  applyDark(S.dark);
  E.searchShortcut.textContent = isMacPlatform() ? '⌘K' : 'Ctrl K';

  E.darkBtn.addEventListener('click', () => applyDark(!S.dark));
  E.addBtn.addEventListener('click', openAddFlow);
  E.settingsBtn.addEventListener('click', openSettings);
  E.syncBtn.addEventListener('click', handleSync);

  E.searchInput.addEventListener('input', () => {
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(() => {
      S.search = E.searchInput.value.trim();
      loadApps();
    }, 160);
  });

  document.getElementById('closeSettingsBtn').addEventListener('click', () =>
    document.getElementById('settingsDialog').close()
  );
  document.getElementById('settingsForm').addEventListener('submit', saveSettings);
  window.addEventListener('keydown', handleGlobalShortcuts);

}

function isMacPlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
}

function handleGlobalShortcuts(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    if (
      document.getElementById('uploadFlow') ||
      document.getElementById('runnerOverlay') ||
      document.getElementById('confirmOverlay') ||
      document.getElementById('settingsDialog')?.open
    ) {
      return;
    }
    e.preventDefault();
    E.searchInput?.focus();
    E.searchInput?.select();
  }
}

// ── Page render (header + grid) ────────────────────────────────────────────
function renderPage() {
  const filtered = filterApps(S.apps, S.search, S.activeTag);
  const allTags = getAllTags(S.apps);
  const starredCount = S.apps.filter(a => a.starred).length;

  E.pageContent.innerHTML = '';

  const header = el('div', 'page-header');
  header.innerHTML = `
    <div class="page-header-row">
      <div>
        <h1 class="page-title">Your shelf</h1>
        <p class="page-subtitle">${S.apps.length} apps · ${starredCount} starred</p>
      </div>
    </div>
    <div class="tag-filter" id="tagFilter"></div>
  `;
  E.pageContent.append(header);

  const tagFilter = header.querySelector('#tagFilter');
  for (const tag of allTags) {
    const chip = el('button', `tag-chip${S.activeTag === tag ? ' active' : ''}`);
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      S.activeTag = S.activeTag === tag ? null : tag;
      renderPage();
    });
    tagFilter.append(chip);
  }

  const scroll = el('div', 'grid-scroll');
  E.pageContent.append(scroll);

  const gridShell = el('div', 'grid-shell');
  scroll.append(gridShell);

  const gridToolbar = el('div', 'grid-toolbar');
  gridToolbar.innerHTML = `
    <div class="sort-controls">
      sort:
      <span class="sort-opt ${S.sort === 'recent' ? 'active' : ''}" data-sort="recent">recent</span>
      <span class="sort-opt ${S.sort === 'title' ? 'active' : ''}" data-sort="title">title</span>
      <span class="sort-opt ${S.sort === 'starred' ? 'active' : ''}" data-sort="starred">starred</span>
    </div>
  `;
  gridShell.append(gridToolbar);

  gridToolbar.querySelectorAll('.sort-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      S.sort = opt.dataset.sort;
      renderPage();
    });
  });

  const grid = el('div', 'app-grid');
  gridShell.append(grid);

  const display = sortApps(filtered, S.sort);
  for (const app of display) {
    grid.append(buildCard(app));
  }

  const addTile = el('div', 'add-card');
  addTile.innerHTML = `
    <div class="add-card-circle">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M7 1.5v11M1.5 7h11"/>
      </svg>
    </div>
    <div class="add-card-label">Paste new app</div>
  `;
  addTile.addEventListener('click', openAddFlow);
  grid.append(addTile);

}

// ── Card builder ───────────────────────────────────────────────────────────
function buildCard(app) {
  const card = el('div', 'app-card');
  card.dataset.appId = app.id;

  const thumb = el('div', 'card-thumb');

  if (app.thumbnail) {
    const img = document.createElement('img');
    img.src = app.thumbnail;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    thumb.append(img);
  } else {
    const ph = el('div', 'card-thumb-placeholder');
    ph.textContent = (app.name || '?')[0].toUpperCase();
    thumb.append(ph);
  }

  const actionsOverlay = el('div', 'card-actions-overlay');

  const editBtn = el('button', 'card-icon-btn');
  editBtn.title = 'Edit';
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2L12 4.5 5 11.5l-3 .5.5-3z"/></svg>`;
  editBtn.addEventListener('click', e => { e.stopPropagation(); openEditFlow(app); });

  const delBtn = el('button', 'card-icon-btn danger');
  delBtn.title = 'Delete';
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.5 8h5l.5-8M6 6.5v3.5M8 6.5v3.5"/></svg>`;
  delBtn.addEventListener('click', e => { e.stopPropagation(); openConfirm(app); });

  actionsOverlay.append(editBtn, delBtn);
  thumb.append(actionsOverlay);

  const starWrap = el('div', 'card-star-wrap');
  const starBtn = el('button', `star-btn${app.starred ? ' on' : ''}`);
  starBtn.title = app.starred ? 'Unstar' : 'Star';
  starBtn.innerHTML = svgStar(app.starred);
  starBtn.addEventListener('click', e => { e.stopPropagation(); toggleStar(app.id, starBtn); });
  starWrap.append(starBtn);

  const body = el('div', 'card-body');
  const tags = splitTags(app.tags);
  const dateStr = fmtDateShort(app.updated_at);

  body.innerHTML = `
    <div class="card-title-row">
      <div class="card-title">${escHtml(app.name)}</div>
      <div class="card-meta-actions">
        <div class="card-date">${escHtml(dateStr)}</div>
      </div>
    </div>
    <div class="card-tags">
      ${tags.slice(0, 3).map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('')}
    </div>
  `;

  body.querySelector('.card-meta-actions').append(starWrap);

  card.append(thumb, body);
  card.addEventListener('click', () => openRunner(app));
  return card;
}

// ── Runner overlay ─────────────────────────────────────────────────────────
async function openRunner(app) {
  closeRunner();

  let fullApp = app;
  if (!app.code) {
    try {
      fullApp = await api(`/api/apps/${app.id}`);
    } catch (err) {
      showToast(err.message, true);
      return;
    }
  }
  S.running = fullApp;

  const backdrop = el('div', 'overlay-backdrop runner-backdrop');
  backdrop.id = 'runnerOverlay';
  backdrop.addEventListener('click', closeRunner);

  const win = el('div', 'runner-window');
  win.addEventListener('click', e => e.stopPropagation());

  const chrome = el('div', 'runner-chrome');
  chrome.innerHTML = `
    <div class="runner-dots">
      <div class="runner-dot" style="background:#ec6a5e"></div>
      <div class="runner-dot" style="background:#f5bf4f"></div>
      <div class="runner-dot" style="background:#62c554"></div>
    </div>
    <div class="runner-url">shelf://${fullApp.id}</div>
    <button class="runner-tool" id="runnerConsoleBtn" type="button" title="Show console">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 4.5l3 3-3 3"/>
        <path d="M7.5 11.5h5"/>
      </svg>
      <span class="runner-console-count" id="runnerConsoleCount" hidden>0</span>
    </button>
    <button class="runner-fs" id="runnerFsBtn" type="button" title="Toggle fullscreen (F)">
      <svg id="fsIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>
      </svg>
    </button>
    <button class="runner-esc" id="runnerEscBtn" type="button">esc</button>
  `;

  const frame = document.createElement('iframe');
  frame.className = 'runner-frame';
  frame.sandbox = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
  frame.title = fullApp.name;
  frame.src = `/run/${fullApp.id}`;

  const consolePanel = el('div', 'runner-console-panel');
  consolePanel.hidden = true;
  consolePanel.innerHTML = `
    <div class="runner-console-head">
      <div class="runner-console-title">Console</div>
      <div class="runner-console-actions">
        <button class="runner-console-clear" id="runnerConsoleClearBtn" type="button">Clear</button>
      </div>
    </div>
    <div class="runner-console-log" id="runnerConsoleLog">
      <div class="runner-console-empty" id="runnerConsoleEmpty">No logs yet.</div>
    </div>
  `;

  win.append(chrome, frame, consolePanel);
  backdrop.append(win);
  E.shelf.append(backdrop);

  const consoleBtn = document.getElementById('runnerConsoleBtn');
  const consoleCount = document.getElementById('runnerConsoleCount');
  const consoleLog = document.getElementById('runnerConsoleLog');
  const consoleEmpty = document.getElementById('runnerConsoleEmpty');
  let consoleOpen = false;
  let unreadConsole = 0;

  const updateConsoleBadge = () => {
    if (!consoleCount) return;
    consoleCount.textContent = unreadConsole > 99 ? '99+' : String(unreadConsole);
    consoleCount.hidden = unreadConsole === 0;
  };

  const setConsoleOpen = open => {
    consoleOpen = open;
    consolePanel.hidden = !open;
    consoleBtn.classList.toggle('active', open);
    consoleBtn.title = open ? 'Hide console' : 'Show console';
    if (open) {
      unreadConsole = 0;
      updateConsoleBadge();
      consoleLog.scrollTop = consoleLog.scrollHeight;
    }
  };

  const appendConsoleEntry = entry => {
    if (!consoleLog) return;
    consoleEmpty.hidden = true;
    const item = el('div', `runner-console-entry ${consoleLevelClass(entry.level)}`);
    const time = formatConsoleTime(entry.time);
    const message = (entry.args || []).join(' ');
    const meta = formatConsoleMeta(entry.meta);
    item.innerHTML = `
      <span class="runner-console-time">${escHtml(time)}</span>
      <span class="runner-console-level">${escHtml(entry.level || 'log')}</span>
      <span class="runner-console-message">${escHtml(message || '')}</span>
      ${meta ? `<span class="runner-console-meta">${escHtml(meta)}</span>` : ''}
    `;
    consoleLog.append(item);
    while (consoleLog.querySelectorAll('.runner-console-entry').length > 500) {
      consoleLog.querySelector('.runner-console-entry')?.remove();
    }
    if (consoleOpen) {
      consoleLog.scrollTop = consoleLog.scrollHeight;
    } else if (entry.level !== 'system') {
      unreadConsole += 1;
      updateConsoleBadge();
    }
  };

  const onConsoleMessage = event => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.source !== 'app-shelf-runner-console') return;
    appendConsoleEntry(message);
  };
  backdrop._onConsoleMessage = onConsoleMessage;
  window.addEventListener('message', onConsoleMessage);

  const toggleFullscreen = () => {
    const isFs = win.classList.toggle('fullscreen');
    backdrop.classList.toggle('no-pad', isFs);
    const icon = document.getElementById('fsIcon');
    if (icon) {
      icon.innerHTML = isFs
        ? '<path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"/>'
        : '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>';
    }
  };

  consoleBtn.addEventListener('click', e => {
    e.stopPropagation();
    setConsoleOpen(!consoleOpen);
  });

  document.getElementById('runnerConsoleClearBtn').addEventListener('click', e => {
    e.stopPropagation();
    consoleLog.querySelectorAll('.runner-console-entry').forEach(entry => entry.remove());
    consoleEmpty.hidden = false;
    unreadConsole = 0;
    updateConsoleBadge();
  });

  document.getElementById('runnerEscBtn').addEventListener('click', closeRunner);
  document.getElementById('runnerFsBtn').addEventListener('click', e => {
    e.stopPropagation();
    toggleFullscreen();
  });

  const onKey = e => {
    if (e.key === 'Escape') {
      if (win.classList.contains('fullscreen')) toggleFullscreen();
      else closeRunner();
    } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleFullscreen();
    }
  };
  backdrop._onKey = onKey;
  window.addEventListener('keydown', onKey);
}

function closeRunner() {
  const overlay = document.getElementById('runnerOverlay');
  if (overlay) {
    if (overlay._onKey) window.removeEventListener('keydown', overlay._onKey);
    if (overlay._onConsoleMessage) window.removeEventListener('message', overlay._onConsoleMessage);
    overlay.remove();
  }
  S.running = null;
}

function consoleLevelClass(level) {
  const clean = String(level || 'log').toLowerCase();
  if (['debug', 'error', 'info', 'log', 'system', 'warn'].includes(clean)) return `is-${clean}`;
  return 'is-log';
}

function formatConsoleTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatConsoleMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (meta.filename) {
    const file = String(meta.filename).split('/').pop();
    const line = meta.lineno ? `:${meta.lineno}${meta.colno ? `:${meta.colno}` : ''}` : '';
    parts.push(`${file}${line}`);
  }
  if (meta.kind) parts.push(meta.kind);
  return parts.join(' ');
}

// ── Add / Edit flow ────────────────────────────────────────────────────────
function openAddFlow() {
  S.editingApp = null;
  S.addStep = 'paste';
  S.uploadHtml = defaultHtml();
  S.uploadTitle = '';
  S.uploadTags = '';
  renderUploadFlow();
}

async function openEditFlow(app) {
  let fullApp = app;
  if (!app.code) {
    try {
      fullApp = await api(`/api/apps/${app.id}`);
    } catch (err) {
      showToast(err.message, true);
      return;
    }
  }
  S.editingApp = fullApp;
  S.addStep = 'paste';
  S.uploadHtml = fullApp.code || '';
  S.uploadTitle = fullApp.name || '';
  S.uploadTags = fullApp.tags || '';
  renderUploadFlow();
}

function renderUploadFlow() {
  document.getElementById('uploadFlow')?.remove();

  const isEdit = Boolean(S.editingApp);
  const isPaste = S.addStep === 'paste';

  const flow = el('div', 'upload-flow');
  flow.id = 'uploadFlow';

  flow.innerHTML = `
    <div class="upload-header">
      <button class="upload-back-btn" id="uploadBackBtn">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7.5 2L3.5 6l4 4"/></svg>
        Back
      </button>
      <div class="upload-divider"></div>
      <div class="upload-title">${isEdit ? `Edit · ${escHtml(S.editingApp.name)}` : 'Add to shelf'}</div>
      <div class="upload-steps">
        <span class="step-num${isPaste ? ' active' : ''}">1</span>
        code
        <div class="step-line"></div>
        <span class="step-num${!isPaste ? ' active' : ''}">2</span>
        metadata
      </div>
    </div>
    <div class="upload-body">
      <div class="upload-left" id="uploadLeft"></div>
      <div class="upload-right">
        <div class="upload-section-title">Live preview</div>
        <div class="preview-container" id="previewContainer">
          <div class="preview-placeholder" id="previewPlaceholder">Paste source to preview</div>
        </div>
      </div>
    </div>
  `;

  E.shelf.append(flow);

  document.getElementById('uploadBackBtn').addEventListener('click', () => {
    if (S.addStep === 'meta' && !S.editingApp) {
      S.addStep = 'paste';
      renderUploadFlow();
    } else {
      closeUploadFlow();
    }
  });

  if (isPaste) {
    renderPastePanel();
  } else {
    renderMetaPanel();
  }

  syncPreview();
}

function renderPastePanel() {
  const left = document.getElementById('uploadLeft');
  const canContinue = S.uploadHtml.length > 30;
  const isEdit = Boolean(S.editingApp);

  left.innerHTML = `
    <div class="upload-section-title">App source</div>
    <div class="upload-section-desc">${isEdit ? 'Edit the saved source. Changes are rebuilt, previewed, and saved back to the same app.' : 'Paste HTML, React, or TSX from Claude, ChatGPT, Gemini, or anywhere else. App Shelf stores the source, bundles supported imports when needed, and runs each app in a sandboxed iframe.'}</div>
    <textarea class="upload-textarea" id="uploadHtmlInput" spellcheck="false">${escHtml(S.uploadHtml)}</textarea>
    <div class="upload-footer-row">
      <span class="upload-char-count" id="charCount">${charCountText(S.uploadHtml)}</span>
      <button class="upload-continue-btn ${canContinue ? 'ready' : 'disabled'}" id="continueBtn">Continue →</button>
    </div>
  `;

  const htmlInput = document.getElementById('uploadHtmlInput');
  const continueBtn = document.getElementById('continueBtn');
  const charCount = document.getElementById('charCount');

  htmlInput.addEventListener('input', () => {
    S.uploadHtml = htmlInput.value;
    const ready = S.uploadHtml.length > 30;
    continueBtn.className = `upload-continue-btn ${ready ? 'ready' : 'disabled'}`;
    charCount.textContent = charCountText(S.uploadHtml);
    syncPreview();
  });

  continueBtn.addEventListener('click', () => {
    if (S.uploadHtml.length > 30) {
      S.addStep = 'meta';
      renderUploadFlow();
    }
  });
}

function renderMetaPanel() {
  const left = document.getElementById('uploadLeft');
  const hasTitle = Boolean(S.uploadTitle.trim());

  left.innerHTML = `
    <div class="upload-section-title">Details</div>
    <div class="upload-section-desc">Give it a name and a couple of tags. You can change these later.</div>
    <div class="meta-label">Title</div>
    <input class="meta-input" id="uploadTitleInput" placeholder="e.g. Pomodoro Timer" value="${escAttr(S.uploadTitle)}" />
    <div class="meta-label">Tags</div>
    <input class="meta-input mono" id="uploadTagsInput" placeholder="comma, separated" value="${escAttr(S.uploadTags)}" />
    <div class="meta-footer-row">
      <button class="meta-back-btn" id="metaBackBtn">← Back</button>
      <button class="meta-save-btn ${hasTitle ? 'ready' : 'disabled'}" id="saveAppBtn">${S.editingApp ? 'Save changes' : 'Save to shelf'}</button>
    </div>
  `;

  const titleInput = document.getElementById('uploadTitleInput');
  const tagsInput = document.getElementById('uploadTagsInput');
  const saveBtn = document.getElementById('saveAppBtn');
  const backBtn = document.getElementById('metaBackBtn');

  titleInput.addEventListener('input', () => {
    S.uploadTitle = titleInput.value;
    const ready = Boolean(S.uploadTitle.trim());
    saveBtn.className = `meta-save-btn ${ready ? 'ready' : 'disabled'}`;
  });

  tagsInput.addEventListener('input', () => { S.uploadTags = tagsInput.value; });

  backBtn.addEventListener('click', () => {
    S.addStep = 'paste';
    renderUploadFlow();
  });

  saveBtn.addEventListener('click', () => {
    if (S.uploadTitle.trim()) doSaveApp();
  });

  setTimeout(() => titleInput.focus(), 30);
}

function syncPreview() {
  const container = document.getElementById('previewContainer');
  if (!container) return;

  if (S.uploadHtml.length > 30) {
    let placeholder = document.getElementById('previewPlaceholder');
    if (placeholder) placeholder.remove();

    let frame = container.querySelector('iframe');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
      frame.sandbox = 'allow-scripts allow-forms allow-modals';
      container.append(frame);
    }
    try {
      const rendered = window.AppShelfRenderer
        ? AppShelfRenderer.renderRunnableApp(S.uploadHtml).html
        : S.uploadHtml;
      frame.srcdoc = rendered;
    } catch (e) {
      frame.srcdoc = S.uploadHtml;
    }
  } else {
    const frame = container.querySelector('iframe');
    if (frame) frame.remove();
    if (!document.getElementById('previewPlaceholder')) {
      const ph = el('div', 'preview-placeholder');
      ph.id = 'previewPlaceholder';
      ph.textContent = 'Paste source to preview';
      container.append(ph);
    }
  }
}

async function doSaveApp() {
  const payload = {
    name: S.uploadTitle.trim() || 'Untitled',
    tags: S.uploadTags,
    code: S.uploadHtml,
    description: S.editingApp ? (S.editingApp.description || '') : '',
  };

  const saveBtn = document.getElementById('saveAppBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    let saved;
    if (S.editingApp) {
      saved = await api(`/api/apps/${S.editingApp.id}`, { method: 'PUT', body: payload });
    } else {
      saved = await api('/api/apps', { method: 'POST', body: payload });
    }
    closeUploadFlow();
    showToast(saveMessage(saved));
    await loadApps();
    scheduleThumbnailRefresh();
  } catch (err) {
    showToast(err.message, true);
    if (saveBtn) { saveBtn.textContent = S.editingApp ? 'Save changes' : 'Save to shelf'; saveBtn.disabled = false; }
  }
}

function scheduleThumbnailRefresh() {
  S.thumbnailRefreshTimers.forEach((timer) => clearTimeout(timer));
  S.thumbnailRefreshTimers = [1800, 4500, 9000].map((delay) =>
    setTimeout(() => {
      loadApps();
    }, delay)
  );
}

function saveMessage(app) {
  if (!app) return 'Saved.';
  if (app.build_status === 'ready') return 'Saved. Bundle ready.';
  if (app.build_status === 'error') return 'Saved. Browser fallback active.';
  if (app.build_status === 'fallback') return 'Saved. Browser fallback active.';
  return 'Saved.';
}

function closeUploadFlow() {
  document.getElementById('uploadFlow')?.remove();
  S.editingApp = null;
  S.addStep = null;
}

// ── Confirm dialog ─────────────────────────────────────────────────────────
function openConfirm(app) {
  closeConfirm();
  S.confirmApp = app;

  const backdrop = el('div', 'confirm-backdrop');
  backdrop.id = 'confirmOverlay';
  backdrop.addEventListener('click', closeConfirm);

  const box = el('div', 'confirm-box');
  box.addEventListener('click', e => e.stopPropagation());
  box.innerHTML = `
    <p class="confirm-title">Delete "${escHtml(app.name)}"?</p>
    <p class="confirm-body">This removes the app and its HTML from the shelf. You can't undo this.</p>
    <div class="confirm-actions">
      <button class="confirm-cancel-btn" id="confirmCancelBtn">Cancel</button>
      <button class="confirm-delete-btn" id="confirmDeleteBtn">Delete app</button>
    </div>
  `;
  backdrop.append(box);
  E.shelf.append(backdrop);

  document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
  document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    const id = app.id;
    closeConfirm();
    await deleteApp(id);
  });
}

function closeConfirm() {
  document.getElementById('confirmOverlay')?.remove();
  S.confirmApp = null;
}

// ── Sync ───────────────────────────────────────────────────────────────────
function handleSync() {
  if (S.syncState === 'syncing') return;
  setSyncState('syncing');
  api('/api/github/push', { method: 'POST' })
    .then(result => {
      setSyncState('done');
      showToast(`Synced: ${result.count} apps`);
      clearTimeout(S.syncTimer);
      S.syncTimer = setTimeout(() => setSyncState('idle'), 1400);
    })
    .catch(err => {
      setSyncState('idle');
      showToast(err.message, true);
    });
}

function setSyncState(state) {
  S.syncState = state;
  if (!E.syncBtn) return;
  const icon = E.syncIcon;
  const label = E.syncLabel;
  if (state === 'syncing') {
    E.syncBtn.className = 'sync-btn';
    icon.classList.add('spinning');
    label.textContent = 'Syncing…';
  } else if (state === 'done') {
    E.syncBtn.className = 'sync-btn synced';
    icon.classList.remove('spinning');
    label.textContent = 'Synced';
  } else {
    E.syncBtn.className = 'sync-btn';
    icon.classList.remove('spinning');
    label.textContent = 'Sync';
  }
}

// ── Star toggle ────────────────────────────────────────────────────────────
async function toggleStar(id, btn) {
  try {
    const result = await api(`/api/apps/${id}/star`, { method: 'POST' });
    const idx = S.apps.findIndex(a => a.id === id);
    if (idx >= 0) S.apps[idx] = { ...S.apps[idx], starred: result.starred };
    if (btn) {
      btn.className = `star-btn${result.starred ? ' on' : ''}`;
      btn.title = result.starred ? 'Unstar' : 'Star';
      btn.innerHTML = svgStar(result.starred);
    }
    // Update subtitle count in place
    const subtitle = E.pageContent?.querySelector('.page-subtitle');
    if (subtitle) {
      const starredCount = S.apps.filter(a => a.starred).length;
      subtitle.textContent = `${S.apps.length} apps · ${starredCount} starred`;
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
async function deleteApp(id) {
  try {
    await api(`/api/apps/${id}`, { method: 'DELETE' });
    showToast('Deleted.');
    await loadApps();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ── API ────────────────────────────────────────────────────────────────────
async function loadApps() {
  try {
    const params = new URLSearchParams();
    if (S.search) params.set('search', S.search);
    S.apps = await api(`/api/apps${params.toString() ? '?' + params : ''}`);
    renderPage();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadSettings() {
  try {
    S.settings = await api('/api/settings');
    renderSettings();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderSettings() {
  const s = S.settings || {};
  document.getElementById('repoInput').value = s.githubRepo || '';
  document.getElementById('branchInput').value = s.githubBranch || 'main';
  document.getElementById('fileInput').value = s.githubFile || 'apps.json';
  document.getElementById('tokenInput').value = '';
  document.getElementById('clearTokenInput').checked = false;

  let tokenText = 'Token: not set';
  if (s.githubTokenConfigured) {
    if (s.githubTokenSource === 'environment') tokenText = 'Token: set via ENV';
    else if (!s.githubTokenUsable && s.githubTokenNeedsSecret) tokenText = 'Token: saved, APP_SECRET missing';
    else if (s.githubTokenStorage === 'encrypted') tokenText = 'Token: saved (encrypted)';
    else if (s.githubTokenStorage === 'plaintext') tokenText = 'Token: saved (plaintext)';
    else tokenText = 'Token: saved';
  }
  const authText = s.authConfigured
    ? 'Auth: active'
    : s.authRequired
      ? 'Auth: locked, password missing'
      : 'Auth: intentionally disabled';
  document.getElementById('settingsMeta').textContent = `${tokenText} · ${authText}`;
}

function openSettings() {
  loadSettings();
  const dlg = document.getElementById('settingsDialog');
  if (dlg.showModal) dlg.showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const payload = {
    githubRepo: document.getElementById('repoInput').value.trim(),
    githubBranch: document.getElementById('branchInput').value.trim() || 'main',
    githubFile: document.getElementById('fileInput').value.trim() || 'apps.json',
  };
  if (document.getElementById('clearTokenInput').checked) {
    payload.githubToken = '';
  } else if (document.getElementById('tokenInput').value.trim()) {
    payload.githubToken = document.getElementById('tokenInput').value.trim();
  }

  const btn = document.getElementById('saveSettingsBtn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    await loadSettings();
    document.getElementById('settingsDialog').close();
    showToast('Settings saved.');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.textContent = 'Save';
    btn.disabled = false;
  }
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) headers.set('X-App-Shelf-Request', '1');

  const init = { ...options, method, headers };
  if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ── Utilities ──────────────────────────────────────────────────────────────
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function splitTags(v) {
  return String(v || '').split(',').map(t => t.trim()).filter(Boolean);
}

function getAllTags(apps) {
  const s = new Set();
  apps.forEach(a => splitTags(a.tags).forEach(t => s.add(t)));
  return Array.from(s).slice(0, 8);
}

function filterApps(apps, search, activeTag) {
  let list = apps;
  if (activeTag) list = list.filter(a => splitTags(a.tags).includes(activeTag));
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(a => [a.name, a.description, a.tags].join(' ').toLowerCase().includes(q));
  }
  return list;
}

function sortApps(apps, sort) {
  const list = apps.slice();
  if (sort === 'title') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'starred') {
    list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
  } else {
    list.sort((a, b) => {
      const at = Date.parse(String(a.updated_at || '').replace(' ', 'T')) || 0;
      const bt = Date.parse(String(b.updated_at || '').replace(' ', 'T')) || 0;
      return bt - at || b.id - a.id;
    });
  }
  return list;
}

function fmtDateShort(v) {
  if (!v) return '';
  const norm = String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`;
  const d = new Date(norm);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(d);
}

function charCountText(html) {
  return `${html.length.toLocaleString()} chars · ${html.split('\n').length} lines`;
}

function defaultHtml() {
  return `<!doctype html>\n<html>\n  <body style="font-family:ui-sans-serif">\n    <h1>Hello!</h1>\n  </body>\n</html>`;
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.hidden = true; }, isError ? 5200 : 2600);
}

// ── SVG helpers ────────────────────────────────────────────────────────────
function svgMoon() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/></svg>`;
}

function svgSun() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>`;
}

function svgStar(on) {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.5l2 4.5 5 .5-3.7 3.4 1.1 5L8 12.4 3.6 14.9l1.1-5L1 6.5l5-.5z"/></svg>`;
}
