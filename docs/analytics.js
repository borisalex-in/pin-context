(function () {
  'use strict';

  const CONSENT_KEY = 'pin-context-docs-analytics-consent';
  const GA_MEASUREMENT_ID = 'G-WYF4P2D15Q';
  let googleAnalyticsLoad;

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // Analytics remains opt-in for this page session even when storage is unavailable.
    }
  }

  function pageLocationWithoutSensitiveParts() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function referrerWithoutSensitiveParts() {
    if (!document.referrer) return '';
    return sanitizeExternalUrl(document.referrer);
  }

  function sanitizeExternalUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch (_error) {
      return '';
    }
  }

  class Analytics {
    constructor() {
      this.isEnabled = true;
      this.sessionId = this.generateSessionId();
      this.startTime = Date.now();
      this.eventTimers = new Map();
      this.timeouts = new Set();
      this.listeners = [];
      this.initialized = false;
    }

    generateSessionId() {
      return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    listen(target, eventName, handler, options) {
      target.addEventListener(eventName, handler, options);
      this.listeners.push(() => target.removeEventListener(eventName, handler, options));
    }

    setTrackedTimeout(callback, delay) {
      const timer = window.setTimeout(() => {
        this.timeouts.delete(timer);
        callback();
      }, delay);
      this.timeouts.add(timer);
      return timer;
    }

    sendEvent(eventName, eventParams = {}) {
      if (!this.isEnabled) return;

      // Deduplicate identical interactions for five seconds. Timestamp is deliberately not
      // part of the key, otherwise every call would produce a unique key and bypass dedupe.
      const eventKey = `${eventName}_${JSON.stringify(eventParams)}`;
      if (this.eventTimers.has(eventKey)) return;
      const timer = this.setTrackedTimeout(() => this.eventTimers.delete(eventKey), 5000);
      this.eventTimers.set(eventKey, timer);

      if (typeof window.gtag === 'function') {
        window.gtag('event', eventName, {
          session_id: this.sessionId,
          page_location: pageLocationWithoutSensitiveParts(),
          page_referrer: referrerWithoutSensitiveParts(),
          page_title: document.title,
          timestamp: new Date().toISOString(),
          ...eventParams
        });
      }
    }

    trackClick(element, category, action, label = null, value = null) {
      this.sendEvent('click', {
        event_category: category,
        event_action: action,
        event_label: label || this.getElementIdentifier(element),
        event_value: value
      });
    }

    getElementIdentifier(element) {
      if (!element) return 'unknown';

      let identifier = '';
      if (element.dataset.lang) identifier += `lang:${element.dataset.lang}`;
      if (element.dataset.os) identifier += ` os:${element.dataset.os}`;
      if (element.dataset.context) identifier += ` context:${element.dataset.context}`;
      if (element.dataset.target) identifier += ` target:${element.dataset.target}`;
      if (identifier) return identifier.trim();
      if (element.id) return `#${element.id}`;
      if (element.textContent) return element.textContent.trim().slice(0, 30);
      return element.tagName.toLowerCase();
    }

    trackCopy(element, copiedText, walletType = null, category = 'copy') {
      let walletIdentifier = walletType;
      if (!walletIdentifier && copiedText) {
        if (copiedText.startsWith('0x')) walletIdentifier = 'ethereum';
        else if (copiedText.startsWith('bc1')) walletIdentifier = 'bitcoin';
        else if (copiedText.startsWith('T')) walletIdentifier = 'tron';
        else walletIdentifier = 'unknown';
      }
      this.sendEvent('copy', {
        event_category: category,
        event_action: 'copy',
        event_label: walletIdentifier || this.getElementIdentifier(element),
        copied_length: copiedText?.length || 0,
        wallet_type: walletIdentifier,
        is_wallet: true
      });
    }

    trackNavigation(destination) {
      this.sendEvent('navigate', {
        event_category: 'navigation',
        event_action: 'anchor_click',
        event_label: destination
      });
    }

    trackExternalLink(url, linkText) {
      this.sendEvent('external_link', {
        event_category: 'external',
        event_action: 'click',
        event_label: linkText || 'external link',
        link_url: sanitizeExternalUrl(url)
      });
    }

    trackLanguageChange(language) {
      this.sendEvent('language_change', {
        event_category: 'preferences',
        event_action: 'switch_language',
        event_label: language
      });
    }

    trackPlatformChange(platform) {
      this.sendEvent('platform_change', {
        event_category: 'preferences',
        event_action: 'switch_platform',
        event_label: platform
      });
    }

    trackScrollDepth() {
      let maxDepth = 0;
      const depths = [25, 50, 75, 100];
      let ticking = false;
      const checkScroll = () => {
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;
        if (documentHeight <= 0) return;
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollPercent = ((scrollTop + windowHeight) / documentHeight) * 100;
        for (const depth of depths) {
          if (scrollPercent >= depth && maxDepth < depth) {
            maxDepth = depth;
            this.sendEvent('scroll_depth', {
              event_category: 'engagement',
              event_action: 'scroll',
              event_label: `${depth}%`,
              event_value: depth
            });
          }
        }
      };
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          checkScroll();
          ticking = false;
        });
      };
      this.listen(window, 'scroll', onScroll, { passive: true });
    }

    trackTimeOnPage() {
      [10, 30, 60, 120, 300].forEach((seconds) => {
        this.setTrackedTimeout(() => {
          this.sendEvent('time_on_page', {
            event_category: 'engagement',
            event_action: 'duration',
            event_label: `${seconds}s`,
            event_value: seconds
          });
        }, seconds * 1000);
      });

      const onBeforeUnload = () => {
        this.sendEvent('session_end', {
          event_category: 'engagement',
          event_action: 'session_duration',
          event_value: Math.round((Date.now() - this.startTime) / 1000)
        });
      };
      this.listen(window, 'pagehide', onBeforeUnload);
    }

    handleClick(event) {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const target = origin.closest(
        '.lang-btn,.os-btn,.nav a,.button,.copy-btn,.toggle-btn,[data-context],.sidebar-section .title,a[href^="http"],a[href^="#"]'
      );
      if (!target) return;

      if (target.classList.contains('lang-btn')) {
        this.trackLanguageChange(target.dataset.lang);
        this.trackClick(target, 'preferences', 'language_switch');
      } else if (target.classList.contains('os-btn')) {
        this.trackPlatformChange(target.dataset.os);
        this.trackClick(target, 'preferences', 'platform_switch');
      } else if (target.classList.contains('copy-btn')) {
        const walletElement = target.previousElementSibling;
        const wallet = walletElement?.dataset?.wallet || '';
        let walletType = 'unknown';
        if (wallet.startsWith('0x')) walletType = 'ethereum';
        else if (wallet.startsWith('bc1')) walletType = 'bitcoin';
        else if (wallet.startsWith('T')) walletType = 'tron';
        this.trackCopy(target, wallet, walletType, 'wallet');
        this.trackClick(target, 'wallet', `copy_${walletType}`);
      } else if (target.classList.contains('button')) {
        const href = target.getAttribute('href');
        const buttonText = target.textContent?.trim() || '';
        if (href && href.startsWith('http')) this.trackExternalLink(href, buttonText);
        this.trackClick(target, 'cta', buttonText);
      } else if (target.classList.contains('toggle-btn')) {
        this.trackClick(target, 'comparison', `toggle_${target.dataset.target}`);
      } else if (target.closest('.nav') && target.tagName === 'A') {
        const href = target.getAttribute('href');
        if (href && href.startsWith('#')) this.trackNavigation(href);
        this.trackClick(target, 'navigation', target.textContent?.trim() || 'navigation');
      } else if (target.getAttribute('data-context')) {
        this.trackClick(target, 'context', `switch_to_${target.dataset.context}`);
      } else {
        this.trackClick(target, 'general', 'click');
      }
    }

    init() {
      if (this.initialized || !this.isEnabled) return;
      this.initialized = true;
      this.sessionId = this.generateSessionId();
      this.startTime = Date.now();
      this.trackScrollDepth();
      this.trackTimeOnPage();
      this.sendEvent('page_view', {
        event_category: 'navigation',
        event_action: 'view',
        page_type: document.querySelector('.hero') ? 'landing' : 'other'
      });
      this.listen(document, 'click', (event) => this.handleClick(event));
    }

    dispose() {
      this.isEnabled = false;
      this.listeners.forEach((disposeListener) => disposeListener());
      this.listeners = [];
      this.timeouts.forEach((timer) => window.clearTimeout(timer));
      this.timeouts.clear();
      this.eventTimers.clear();
      this.initialized = false;
    }
  }

  async function loadGoogleAnalytics() {
    if (googleAnalyticsLoad) return googleAnalyticsLoad;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag('consent', 'default', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });

    googleAnalyticsLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
      script.onload = () => {
        window.gtag('consent', 'update', { analytics_storage: 'granted' });
        window.gtag('js', new Date());
        window.gtag('config', GA_MEASUREMENT_ID, {
          send_page_view: false,
          anonymize_ip: true,
          allow_google_signals: false,
          allow_ad_personalization_signals: false
        });
        resolve();
      };
      script.onerror = () => {
        googleAnalyticsLoad = undefined;
        reject(new Error('Google Analytics script failed to load'));
      };
      document.head.appendChild(script);
    });
    return googleAnalyticsLoad;
  }

  async function enableAnalytics() {
    const manager = window.analytics instanceof Analytics ? window.analytics : new Analytics();
    window.analytics = manager;
    try {
      await loadGoogleAnalytics();
      manager.isEnabled = true;
      manager.init();
    } catch (_error) {
      // Analytics is optional: never block the documentation site if the provider is unavailable.
    }
  }

  function disableAnalytics() {
    if (window.analytics instanceof Analytics) window.analytics.dispose();
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
    }
  }

  function initConsentControls() {
    const banner = document.getElementById('analyticsConsent');
    const accept = document.getElementById('analyticsAccept');
    const reject = document.getElementById('analyticsReject');
    const settings = document.getElementById('analyticsSettings');
    if (!banner || !accept || !reject || !settings) return;

    const hideBanner = () => {
      banner.hidden = true;
    };
    const showBanner = (focusAcceptButton = false) => {
      banner.hidden = false;
      if (focusAcceptButton) accept.focus();
    };

    accept.addEventListener('click', () => {
      safeStorageSet(CONSENT_KEY, 'granted');
      hideBanner();
      void enableAnalytics();
    });
    reject.addEventListener('click', () => {
      safeStorageSet(CONSENT_KEY, 'denied');
      hideBanner();
      disableAnalytics();
    });
    settings.addEventListener('click', () => showBanner(true));

    const choice = safeStorageGet(CONSENT_KEY);
    if (choice === 'granted') {
      hideBanner();
      void enableAnalytics();
    } else if (choice === 'denied') {
      hideBanner();
    } else {
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsentControls, { once: true });
  } else {
    initConsentControls();
  }
})();
