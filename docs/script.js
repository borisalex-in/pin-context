const storageKey = 'pin-context-docs-language';
const osStorageKey = 'pin-context-docs-os';
const fallbackLanguage = 'en';
const richTextKeys = new Set([
  'hero-title',
  'agents-claude-step-2',
  'agents-claude-step-4',
  'agents-codex-step-2',
  'agents-codex-step-4',
  'agents-codex-note',
  'agents-status-codex',
  'agents-status-claude',
  'agents-other-step-2'
]);
const translationCache = new Map();
let currentDictionary = {};
const shortcutSets = {
  mac: {
    pin: 'Command + Option + K',
    unpin: 'Command + Option + L',
    toggle: 'Command + Option + J',
    switch: 'Command + Option + P'
  },
  win: {
    pin: 'Ctrl + Alt + K',
    unpin: 'Ctrl + Alt + L',
    toggle: 'Ctrl + Alt + J',
    switch: 'Ctrl + Alt + P'
  }
};

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_error) {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // The site remains usable when browser storage is unavailable.
  }
}

function resolveLanguage() {
  const saved = safeStorageGet(storageKey);
  if (saved === 'en' || saved === 'ru') {
    return saved;
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : fallbackLanguage;
}

async function loadTranslations(language) {
  if (translationCache.has(language)) {
    return translationCache.get(language);
  }

  const response = await fetch(`./i18n/${language}.json`);
  if (!response.ok) {
    throw new Error(`Failed to load i18n file for "${language}"`);
  }
  const dictionary = await response.json();
  translationCache.set(language, dictionary);
  return dictionary;
}

function tr(key, fallback = key) {
  return currentDictionary[key] || fallback;
}

function formatText(value, ...args) {
  return String(value).replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)] ?? ''));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function translateElements(dictionary) {
  document.querySelectorAll('[data-i18n], [data-i18n-html]').forEach((element) => {
    const key = element.getAttribute('data-i18n') || element.getAttribute('data-i18n-html');
    if (!key || typeof dictionary[key] !== 'string') {
      return;
    }
    if (richTextKeys.has(key)) {
      element.innerHTML = dictionary[key];
      return;
    }
    element.textContent = dictionary[key];
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    const key = element.getAttribute('data-i18n-placeholder');
    if (key && typeof dictionary[key] === 'string') {
      element.setAttribute('placeholder', dictionary[key]);
    }
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    const key = element.getAttribute('data-i18n-aria-label');
    if (key && typeof dictionary[key] === 'string') {
      element.setAttribute('aria-label', dictionary[key]);
    }
  });

  document.querySelectorAll('[data-i18n-content]').forEach((element) => {
    const key = element.getAttribute('data-i18n-content');
    if (key && typeof dictionary[key] === 'string') {
      element.setAttribute('content', dictionary[key]);
    }
  });
}

function updateButtons(language) {
  document.querySelectorAll('.lang-btn').forEach((button) => {
    const isActive = button.getAttribute('data-lang') === language;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function resolvePlatform() {
  const saved = safeStorageGet(osStorageKey);
  if (saved === 'mac' || saved === 'win') {
    return saved;
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'mac' : 'win';
}

function applyShortcuts(platform) {
  const supportedPlatform = platform === 'mac' ? 'mac' : 'win';
  safeStorageSet(osStorageKey, supportedPlatform);

  const shortcuts = shortcutSets[supportedPlatform];
  document.querySelectorAll('[data-shortcut]').forEach((element) => {
    const action = element.getAttribute('data-shortcut');
    if (action && shortcuts[action]) {
      element.textContent = shortcuts[action];
    }
  });

  document.querySelectorAll('.os-btn').forEach((button) => {
    const isActive = button.getAttribute('data-os') === supportedPlatform;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

async function setLanguage(language) {
  const supportedLanguage = language === 'ru' ? 'ru' : 'en';
  safeStorageSet(storageKey, supportedLanguage);
  document.documentElement.lang = supportedLanguage;

  if (window.location.protocol === 'file:') {
    console.error(
      '[pin-context-docs] Open docs via HTTP server (file:// blocks JSON fetch). Run: npm run docs:serve'
    );
    updateButtons(supportedLanguage);
    return;
  }

  try {
    const dictionary = await loadTranslations(supportedLanguage);
    currentDictionary = dictionary;
    translateElements(dictionary);
    updateButtons(supportedLanguage);
    syncNavigationState();
    updateAgentFlow();
    renderDemo();
  } catch (error) {
    console.error('[pin-context-docs] Failed to apply language', error);
  }
}

const demoState = {
  view: 'pins',
  activeContext: 'main',
  addingFiles: false,
  filter: ''
};

const demoContexts = [
  {
    id: 'main',
    name: 'main',
    type: 'git',
    descriptionKey: 'demo-context-main-desc',
    pins: [
      { name: 'extension.ts', path: 'src/extension.ts', ext: 'TS' },
      { name: 'contextStore.ts', path: 'src/stores/contextStore.ts', ext: 'TS' },
      { name: 'package.json', path: 'package.json', ext: 'JSON' }
    ]
  },
  {
    id: 'search',
    name: 'feature/quick-search',
    type: 'git',
    descriptionKey: 'demo-context-search-desc',
    pins: [
      { name: 'contextQuickPick.ts', path: 'src/ui/contextQuickPick.ts', ext: 'TS' },
      { name: 'pinnedTreeView.ts', path: 'src/ui/pinnedTreeView.ts', ext: 'TS' }
    ]
  },
  {
    id: 'api',
    name: 'API refactor',
    type: 'manual',
    descriptionKey: 'demo-context-api-desc',
    pins: [
      {
        name: 'contextPersistenceService.ts',
        path: 'src/services/contextPersistenceService.ts',
        ext: 'TS'
      }
    ]
  }
];

const demoFiles = [
  { name: 'gitContextService.ts', path: 'src/services/gitContextService.ts', ext: 'TS' },
  { name: 'contextFileService.ts', path: 'src/services/contextFileService.ts', ext: 'TS' },
  { name: 'README.md', path: 'README.md', ext: 'MD' },
  { name: 'ARCHITECTURE.md', path: 'ARCHITECTURE.md', ext: 'MD' },
  { name: 'styles.css', path: 'docs/styles.css', ext: 'CSS' },
  { name: 'en.json', path: 'l10n/bundle.l10n.json', ext: 'JSON' }
];

function activeDemoContext() {
  return demoContexts.find((context) => context.id === demoState.activeContext) || demoContexts[0];
}

function filterMatches(...values) {
  const filter = demoState.filter.trim().toLowerCase();
  return !filter || values.some((value) => String(value).toLowerCase().includes(filter));
}

function renderDemoHeader(title, description, badge = '', countLabel = '') {
  const header = document.getElementById('demoHeader');
  if (!header) return;
  header.innerHTML = `
    <div class="demo-header-top">
      <span class="demo-context-badge">${badge || escapeHtml(tr('demo-active-context', 'ACTIVE CONTEXT'))}</span>
      <span class="demo-count-badge">${escapeHtml(countLabel || formatText(tr('demo-context-count', '{0} files'), activeDemoContext().pins.length))}</span>
    </div>
    <h3 id="demoTitle">${escapeHtml(title)}</h3>
    <p>${escapeHtml(description)}</p>`;
}

function renderPinRow(file, index) {
  const buttonLabel = `${tr('demo-unpin-action', 'Unpin')} ${file.name}`;
  return `
    <div class="demo-file-row">
      <span class="demo-file-icon demo-file-icon--${escapeHtml(file.ext.toLowerCase())}">${escapeHtml(file.ext)}</span>
      <div class="demo-file-copy"><strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.path)}</span></div>
      <button type="button" class="demo-row-action demo-row-action--remove" data-demo-unpin="${index}" aria-label="${escapeHtml(buttonLabel)}" title="${escapeHtml(buttonLabel)}">−</button>
    </div>`;
}

function renderAvailableRow(file, index) {
  const buttonLabel = `${tr('demo-pin-action', 'Pin')} ${file.name}`;
  return `
    <div class="demo-file-row demo-file-row--available">
      <span class="demo-file-icon demo-file-icon--${escapeHtml(file.ext.toLowerCase())}">${escapeHtml(file.ext)}</span>
      <div class="demo-file-copy"><strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.path)}</span></div>
      <button type="button" class="demo-row-action demo-row-action--add" data-demo-pin="${index}" aria-label="${escapeHtml(buttonLabel)}" title="${escapeHtml(buttonLabel)}">+</button>
    </div>`;
}

function renderContexts() {
  const panel = document.getElementById('demoPanelContent');
  if (!panel) return;
  const contexts = demoContexts.filter((context) => filterMatches(context.name, context.type));
  if (!contexts.length) {
    panel.innerHTML = `<p class="demo-empty-state">${escapeHtml(tr('demo-empty-contexts', 'No contexts match this filter.'))}</p>`;
    return;
  }
  panel.innerHTML = contexts
    .map((context) => {
      const active = context.id === demoState.activeContext;
      const contextType =
        context.type === 'git'
          ? tr('demo-type-git', 'GIT BRANCH')
          : tr('demo-type-manual', 'MANUAL CONTEXT');
      const action = active ? tr('demo-active', 'Active') : tr('demo-open-context', 'Open context');
      return `
      <button type="button" class="demo-context-card${active ? ' is-active' : ''}" data-demo-select-context="${escapeHtml(context.id)}" aria-pressed="${active}">
        <span class="demo-context-card-top"><span class="demo-context-card-type">${escapeHtml(contextType)}</span><span class="demo-context-card-count">${context.pins.length}</span></span>
        <strong>${escapeHtml(context.name)}</strong>
        <span class="demo-context-card-bottom"><span>${escapeHtml(formatText(tr('demo-context-count', '{0} files'), context.pins.length))}</span><span class="demo-context-open">${escapeHtml(action)} →</span></span>
      </button>`;
    })
    .join('');
}

function renderHistory() {
  const panel = document.getElementById('demoPanelContent');
  if (!panel) return;
  const history = [
    { id: 'search', group: 'demo-today' },
    { id: 'main', group: 'demo-yesterday' },
    { id: 'api', group: 'demo-earlier' }
  ]
    .map((item) => ({ ...item, context: demoContexts.find((context) => context.id === item.id) }))
    .filter((item) => item.context && filterMatches(item.context.name));
  if (!history.length) {
    panel.innerHTML = `<p class="demo-empty-state">${escapeHtml(tr('demo-empty-history', 'No recent contexts match this filter.'))}</p>`;
    return;
  }
  let lastGroup = '';
  panel.innerHTML = history
    .map(({ id, group, context }) => {
      const groupLabel =
        group !== lastGroup
          ? `<p class="demo-history-group">${escapeHtml(tr(group, group))}</p>`
          : '';
      lastGroup = group;
      return `${groupLabel}
      <button type="button" class="demo-history-row${id === demoState.activeContext ? ' is-active' : ''}" data-demo-select-context="${escapeHtml(id)}">
        <span class="demo-history-icon" aria-hidden="true">◷</span>
        <span class="demo-history-copy"><strong>${escapeHtml(context.name)}</strong><small>${escapeHtml(formatText(tr('demo-context-count', '{0} files'), context.pins.length))}</small></span>
        <span class="demo-history-arrow" aria-hidden="true">→</span>
      </button>`;
    })
    .join('');
}

function renderPins() {
  const panel = document.getElementById('demoPanelContent');
  const context = activeDemoContext();
  if (!panel) return;
  const visiblePins = context.pins.filter((file) => filterMatches(file.name, file.path));
  let html = visiblePins.length
    ? `<div class="demo-file-list">${visiblePins.map((file) => renderPinRow(file, context.pins.indexOf(file))).join('')}</div>`
    : `<p class="demo-empty-state">${escapeHtml(tr('demo-empty-pins', 'No pinned files match this filter.'))}</p>`;

  if (demoState.addingFiles) {
    const pinnedPaths = new Set(context.pins.map((file) => file.path));
    const available = demoFiles
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => !pinnedPaths.has(file.path) && filterMatches(file.name, file.path));
    html += `<div class="demo-available-block"><div class="demo-available-heading">${escapeHtml(tr('demo-available-files', 'Available in workspace'))}</div>`;
    html += available.length
      ? `<div class="demo-file-list">${available.map(({ file, index }) => renderAvailableRow(file, index)).join('')}</div>`
      : `<p class="demo-empty-state demo-empty-state--compact">${escapeHtml(tr('demo-empty-available', 'No other sample files are available to pin.'))}</p>`;
    html += '</div>';
  }
  panel.innerHTML = html;
}

function renderDemo() {
  const demo = document.getElementById('interactiveDemo');
  if (!demo) return;
  const context = activeDemoContext();
  const branch = document.getElementById('demoBranch');
  const panel = document.getElementById('demoPanelContent');
  const searchWrap = document.getElementById('demoSearchWrap');
  const search = document.getElementById('demoSearch');
  const footer = document.getElementById('demoFooter');
  if (!panel || !footer || !searchWrap || !search) return;

  demo.querySelectorAll('.demo-nav-btn[data-demo-view]').forEach((button) => {
    const active = button.getAttribute('data-demo-view') === demoState.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  if (demoState.view === 'pins') {
    if (branch)
      branch.textContent =
        context.type === 'git' ? context.name : tr('demo-type-manual', 'MANUAL CONTEXT');
    const fallbackDescriptions = {
      'demo-context-main-desc': 'Shared workspace files and extension entry points.',
      'demo-context-search-desc': 'Files for improving quick open and keyboard navigation.',
      'demo-context-api-desc': 'A manual context for storage and persistence work.'
    };
    renderDemoHeader(
      context.name,
      tr(context.descriptionKey, fallbackDescriptions[context.descriptionKey]),
      context.type === 'git'
        ? tr('demo-type-git', 'GIT BRANCH')
        : tr('demo-type-manual', 'MANUAL CONTEXT')
    );
    searchWrap.hidden = false;
    search.setAttribute('data-i18n-placeholder', 'demo-search-pins');
    search.placeholder = tr('demo-search-pins', 'Filter pinned files…');
    search.setAttribute('aria-label', tr('demo-search-label', 'Filter files or contexts'));
    renderPins();
    footer.innerHTML = `
      <button type="button" class="demo-primary-action" data-demo-action="add">${demoState.addingFiles ? '−' : '+'} ${escapeHtml(tr(demoState.addingFiles ? 'demo-hide-files' : 'demo-add-file', demoState.addingFiles ? 'Done adding files' : 'Pin a file'))}</button>
      <button type="button" class="demo-secondary-action" data-demo-action="export"><span aria-hidden="true">↓</span> ${escapeHtml(tr('demo-export-json', 'Export JSON'))}</button>`;
  } else if (demoState.view === 'contexts') {
    if (branch) branch.textContent = context.name;
    renderDemoHeader(
      tr('demo-contexts-title', 'Your task contexts'),
      tr('demo-contexts-desc', 'Switch contexts to see a different set of pinned files.'),
      tr('demo-workspace', 'WORKSPACE'),
      formatText(tr('demo-contexts-count', '{0} contexts'), demoContexts.length)
    );
    searchWrap.hidden = false;
    search.placeholder = tr('demo-search-contexts', 'Filter contexts…');
    search.setAttribute('aria-label', tr('demo-search-label', 'Filter files or contexts'));
    renderContexts();
    footer.innerHTML = `<button type="button" class="demo-primary-action" data-demo-view="pins">← ${escapeHtml(tr('demo-back-pins', 'Back to pinned files'))}</button><span class="demo-footer-note">${escapeHtml(formatText(tr('demo-context-count', '{0} files'), demoContexts.length))}</span>`;
  } else {
    if (branch) branch.textContent = context.name;
    renderDemoHeader(
      tr('demo-history-title', 'Recently used'),
      tr('demo-history-desc', 'Jump back into a context you used earlier.'),
      tr('demo-nav-history', 'Recent'),
      formatText(tr('demo-recent-count', '{0} recent'), 3)
    );
    searchWrap.hidden = false;
    search.placeholder = tr('demo-search-history', 'Filter recent contexts…');
    search.setAttribute('aria-label', tr('demo-search-label', 'Filter files or contexts'));
    renderHistory();
    footer.innerHTML = `<button type="button" class="demo-primary-action" data-demo-view="pins">← ${escapeHtml(tr('demo-back-pins', 'Back to pinned files'))}</button>`;
  }
}

function setDemoStatus(key, ...args) {
  const status = document.getElementById('demoStatus');
  if (status) status.textContent = formatText(tr(key), ...args);
}

function selectDemoContext(id) {
  if (!demoContexts.some((context) => context.id === id)) return;
  const context = demoContexts.find((item) => item.id === id);
  demoState.activeContext = id;
  demoState.view = 'pins';
  demoState.addingFiles = false;
  demoState.filter = '';
  const search = document.getElementById('demoSearch');
  if (search) search.value = '';
  renderDemo();
  setDemoStatus('demo-status-switched', context.name);
}

function exportDemoContexts() {
  // Match the extension's portable context file shape (version + named contexts + paths).
  const payload = {
    version: 1,
    contexts: demoContexts.map((context) => ({
      name: context.name,
      paths: context.pins.map((file) => file.path)
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pin-context-demo.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setDemoStatus('demo-status-exported');
}

function initializeDemo() {
  const demo = document.getElementById('interactiveDemo');
  const search = document.getElementById('demoSearch');
  if (!demo || !search) return;

  demo.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;

    const view = target.getAttribute('data-demo-view');
    if (view) {
      demoState.view = view;
      demoState.addingFiles = false;
      demoState.filter = '';
      search.value = '';
      renderDemo();
      return;
    }

    const selectedContext = target.getAttribute('data-demo-select-context');
    if (selectedContext) {
      selectDemoContext(selectedContext);
      return;
    }

    const removeIndex = target.getAttribute('data-demo-unpin');
    if (removeIndex !== null) {
      const context = activeDemoContext();
      const [removed] = context.pins.splice(Number(removeIndex), 1);
      renderDemo();
      if (removed) setDemoStatus('demo-status-unpinned', removed.name);
      return;
    }

    const addIndex = target.getAttribute('data-demo-pin');
    if (addIndex !== null) {
      const file = demoFiles[Number(addIndex)];
      const context = activeDemoContext();
      if (file && !context.pins.some((pin) => pin.path === file.path)) {
        context.pins.push({ ...file });
        renderDemo();
        setDemoStatus('demo-status-pinned', file.name);
      }
      return;
    }

    const action = target.getAttribute('data-demo-action');
    if (action === 'add') {
      demoState.addingFiles = !demoState.addingFiles;
      renderDemo();
    } else if (action === 'export') {
      exportDemoContexts();
    }
  });

  search.addEventListener('input', () => {
    demoState.filter = search.value;
    renderDemo();
  });

  renderDemo();
}

function syncNavigationState() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  if (!toggle || !nav) return;
  const isOpen = toggle.getAttribute('aria-expanded') === 'true';
  const labelKey = isOpen ? 'nav-menu-close' : 'nav-menu-open';
  toggle.setAttribute('aria-label', tr(labelKey, isOpen ? 'Close navigation' : 'Open navigation'));
}

function initializeNavigation() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  if (!toggle || !nav) return;

  const setOpen = (isOpen) => {
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.classList.toggle('is-open', isOpen);
    nav.classList.toggle('open', isOpen);
    syncNavigationState();
  };

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  nav.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    const target = event.target;
    if (target instanceof Node && !nav.contains(target) && !toggle.contains(target)) {
      setOpen(false);
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1200 && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
    }
  });
}

function initializeAgentFlow() {
  const nodes = [...document.querySelectorAll('[data-agent-flow]')];
  const title = document.getElementById('agentFlowStatus');
  const description = document.getElementById('agentFlowDescription');
  if (!nodes.length || !title || !description) return;

  const selectNode = (node) => {
    nodes.forEach((item) => {
      const active = item === node;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    const titleKey = node.getAttribute('data-agent-flow-title');
    const descriptionKey = node.getAttribute('data-agent-flow-desc');
    title.textContent = tr(titleKey, title.textContent || 'Context flow');
    description.textContent = tr(descriptionKey, description.textContent || '');
  };

  nodes.forEach((node) => node.addEventListener('click', () => selectNode(node)));
  selectNode(nodes.find((node) => node.getAttribute('aria-pressed') === 'true') || nodes[0]);
}

function updateAgentFlow() {
  const active = document.querySelector('[data-agent-flow][aria-pressed="true"]');
  if (!active) return;
  const title = document.getElementById('agentFlowStatus');
  const description = document.getElementById('agentFlowDescription');
  const titleKey = active.getAttribute('data-agent-flow-title');
  const descriptionKey = active.getAttribute('data-agent-flow-desc');
  if (title && titleKey) title.textContent = tr(titleKey, title.textContent || 'Context flow');
  if (description && descriptionKey)
    description.textContent = tr(descriptionKey, description.textContent || '');
}

function initializeAgentIntegration() {
  const tabs = [...document.querySelectorAll('[data-agent-client]')];
  const panels = [...document.querySelectorAll('[data-agent-panel]')];

  function selectClient(client, moveFocus = false) {
    tabs.forEach((tab) => {
      const isActive = tab.getAttribute('data-agent-client') === client;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
      if (isActive && moveFocus) tab.focus();
    });
    panels.forEach((panel) => {
      const isActive = panel.getAttribute('data-agent-panel') === client;
      panel.hidden = !isActive;
      panel.classList.toggle('is-active', isActive);
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      const client = tab.getAttribute('data-agent-client');
      if (client) selectClient(client);
    });
    tab.addEventListener('keydown', (event) => {
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      const client = tabs[nextIndex].getAttribute('data-agent-client');
      if (client) selectClient(client, true);
    });
  });

  if (tabs.length) {
    const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    selectClient(selected.getAttribute('data-agent-client') || 'claude');
  }

  const copyButton = document.getElementById('copyAgentTestPrompt');
  const prompt = document.getElementById('agentTestPrompt');
  const status = document.getElementById('agentCopyStatus');
  let copyStatusTimeout = null;
  let copyRequestId = 0;

  copyButton?.addEventListener('click', async () => {
    if (!prompt || !status) return;
    const requestId = ++copyRequestId;
    if (copyStatusTimeout !== null) {
      window.clearTimeout(copyStatusTimeout);
      copyStatusTimeout = null;
    }
    status.textContent = '';

    const value = prompt.textContent?.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      // Ignore stale clipboard results if the user clicked again while it was pending.
      if (requestId !== copyRequestId) return;
      const successMessage = tr('agents-copy-success', 'Test prompt copied.');
      status.textContent = successMessage;
      copyStatusTimeout = window.setTimeout(() => {
        if (requestId !== copyRequestId) return;
        if (status.textContent === successMessage) status.textContent = '';
        copyStatusTimeout = null;
      }, 2000);
    } catch (_error) {
      if (requestId !== copyRequestId) return;
      status.textContent = tr(
        'agents-copy-failed',
        'Clipboard access is unavailable. Select and copy the prompt manually.'
      );
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.os-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const platform = button.getAttribute('data-os');
      if (platform) applyShortcuts(platform);
    });
  });

  document.querySelectorAll('.lang-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const language = button.getAttribute('data-lang');
      if (language) void setLanguage(language);
    });
  });

  applyShortcuts(resolvePlatform());
  initializeNavigation();
  initializeDemo();
  initializeAgentFlow();
  initializeAgentIntegration();
  void setLanguage(resolveLanguage());
});

// Keep wallet-copy behavior unchanged; the support section is intentionally not altered.
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const wallet = btn.previousElementSibling.dataset.wallet;
    queueMicrotask(() => {
      navigator.clipboard.writeText(wallet);
      btn.classList.add('copied');
    });
  });

  btn.addEventListener('animationend', () => {
    btn.classList.remove('copied');
  });
});

const buttons = document.querySelectorAll('.toggle-btn');
const panels = document.querySelectorAll('.comparison-panel');
buttons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    buttons.forEach((button) => {
      const active = button === btn;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === target));
  });
});
