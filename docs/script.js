const storageKey = 'pin-context-docs-language';
const osStorageKey = 'pin-context-docs-os';
const fallbackLanguage = 'en';
const richTextKeys = new Set(['hero-title']);
const translationCache = new Map();
const shortcutSets = {
  mac: {
    pin: 'Cmd + Option + K',
    unpin: 'Cmd + Option + L',
    toggle: 'Cmd + Option + J'
  },
  win: {
    pin: 'Ctrl + Shift + K',
    unpin: 'Ctrl + Shift + L',
    toggle: 'Ctrl + Shift + J'
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
