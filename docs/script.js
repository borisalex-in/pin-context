const storageKey = 'pin-context-docs-language';
const osStorageKey = 'pin-context-docs-os';
const fallbackLanguage = 'en';
const richTextKeys = new Set(['hero-title']);
const translationCache = new Map();
const shortcutSets = {
  mac: {
    pin: 'Command + Option + K',
    unpin: 'Command + Option + L',
    toggle: 'Command + Option + J',
    switch: 'Command + Option + P'
  },
  win: {
    pin: 'Ctrl + Shift + K',
    unpin: 'Ctrl + Shift + L',
    toggle: 'Ctrl + Shift + J',
    switch: 'Ctrl + Shift + P'
  }
};

function resolveLanguage() {
  const saved = localStorage.getItem(storageKey);
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
}

function updateButtons(language) {
  document.querySelectorAll('.lang-btn').forEach((button) => {
    const isActive = button.getAttribute('data-lang') === language;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function resolvePlatform() {
  const saved = localStorage.getItem(osStorageKey);
  if (saved === 'mac' || saved === 'win') {
    return saved;
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'mac' : 'win';
}

function applyShortcuts(platform) {
  const supportedPlatform = platform === 'mac' ? 'mac' : 'win';
  localStorage.setItem(osStorageKey, supportedPlatform);

  const shortcuts = shortcutSets[supportedPlatform];
  document.querySelectorAll('[data-shortcut]').forEach((element) => {
    const action = element.getAttribute('data-shortcut');
    if (!action || !shortcuts[action]) {
      return;
    }
    element.textContent = shortcuts[action];
  });

  document.querySelectorAll('.os-btn').forEach((button) => {
    const isActive = button.getAttribute('data-os') === supportedPlatform;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

async function setLanguage(language) {
  const supportedLanguage = language === 'ru' ? 'ru' : 'en';
  localStorage.setItem(storageKey, supportedLanguage);
  document.documentElement.lang = supportedLanguage;

  if (window.location.protocol === 'file:') {
    console.error(
      '[pin-context-docs] Open docs via HTTP server (file:// blocks JSON fetch). Run: npm run docs:serve'
    );
    return;
  }

  try {
    const dictionary = await loadTranslations(supportedLanguage);
    translateElements(dictionary);
    updateButtons(supportedLanguage);
  } catch (error) {
    console.error('[pin-context-docs] Failed to apply language', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.os-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const platform = button.getAttribute('data-os');
      if (platform) {
        applyShortcuts(platform);
      }
    });
  });

  document.querySelectorAll('.lang-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const language = button.getAttribute('data-lang');
      if (language) {
        void setLanguage(language);
      }
    });
  });

  applyShortcuts(resolvePlatform());
  void setLanguage(resolveLanguage());
});

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

const burger = document.querySelector('.burger');
const nav = document.querySelector('.nav');

if (burger && nav) {
  burger.addEventListener('click', () => {
    nav.classList.toggle('open');
  });
}

const buttons = document.querySelectorAll('.toggle-btn');
const panels = document.querySelectorAll('.comparison-panel');

if (buttons) {
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;

      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      panels.forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === target);
      });
    });
  });
}

const state = {
  master: {
    pins: ['index.html', 'script.js', 'styles.css'],
    count: '3/21',
    type: 'git'
  },
  git: {
    pins: ['index.html', 'ru.json'],
    count: '2/21'
  },
  manual: {
    pins: ['en.json'],
    count: '1/21',
    type: 'git'
  }
};

function setContext(mode) {
  const data = state[mode];
  if (!data) return;

  const pins = document.getElementById('pins');
  pins.innerHTML = data.pins.map((p) => `<div class="item active">${p}</div>`).join('');

  document.getElementById('pinCount').textContent = `(${data.count})`;

  document.querySelectorAll('[data-context]').forEach((el) => {
    el.classList.toggle('active', el.dataset.context === mode);
  });
}

setContext('master');

document.querySelectorAll('[data-context]').forEach((el) => {
  el.addEventListener('click', () => {
    setContext(el.dataset.context);
  });
});

document.querySelectorAll('.sidebar-section .title').forEach((title) => {
  title.addEventListener('click', () => {
    const section = title.closest('.sidebar-section');
    section.classList.toggle('collapsed');
  });
});
