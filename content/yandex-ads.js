// content/yandex-ads.js — РСЯ: извлечение токена + DOM-парсинг (fallback)

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH-RSYA ${step}]`, detail);
  }

  // ── Хелперы ──

  function parseNum(s) {
    if (!s || typeof s !== 'string') return 0;
    const c = s.replace(/\u205f/g, '').replace(/\s/g, '').replace(/[^\d.\-]/g, '');
    const v = parseFloat(c.replace(',', '.'));
    return isNaN(v) ? 0 : v;
  }

  function parseMoney(s) {
    if (!s || typeof s !== 'string') return 0;
    const c = s.replace(/\u205f/g, '').replace(/[₽\s]/g, '').replace(',', '.');
    const v = parseFloat(c);
    return isNaN(v) ? 0 : v;
  }

  function parseDate(s) {
    if (!s || typeof s !== 'string') return null;
    const months = {
      'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4,
      'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
      'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12,
    };
    const m = s.match(/(\d{1,2})\s+(\S+?)\s+(\d{4})/);
    if (!m) return null;
    const month = months[m[2].toLowerCase()];
    if (!month) return null;
    return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  function getText(el) {
    if (!el) return '';
    return (el.textContent || el.innerText || '')
      .replace(/&nbsp;/g, ' ').replace(/\u205f/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ═══════════════════════════════════════════════════════════
  //  Подход 2: Извлечение OAuth-токена из контекста страницы
  // ═══════════════════════════════════════════════════════════

  function searchObjectForToken(obj, depth = 0, visited = new Set()) {
    if (depth > 4 || !obj || typeof obj !== 'object') return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    // Прямое совпадение: строка похожа на OAuth-токен Яндекса
    if (typeof obj === 'string') {
      // Яндекс OAuth-токен: ~40+ символов, base64-like
      if (/^AQ[A-Za-z0-9_-]{20,}$/.test(obj)) return obj;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = searchObjectForToken(item, depth + 1, visited);
        if (r) return r;
      }
      return null;
    }

    for (const [key, val] of Object.entries(obj)) {
      const kl = key.toLowerCase();
      // Ключ содержит указание на токен
      if (kl.includes('token') || kl.includes('oauth') || kl.includes('auth') || kl.includes('access')) {
        if (typeof val === 'string' && val.length > 20 && /^[A-Za-z0-9_-]+$/.test(val)) {
          return val;
        }
      }
      // Рекурсивный поиск в объектах
      if (typeof val === 'object' && val !== null) {
        const r = searchObjectForToken(val, depth + 1, visited);
        if (r) return r;
      }
    }
    return null;
  }

  function extractTokenFromStorage() {
    const candidates = [];

    // 1. localStorage
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        try {
          const val = localStorage.getItem(key);
          if (!val) continue;
          // Прямое значение — токен
          if (/^AQ[A-Za-z0-9_-]{20,}$/.test(val)) {
            candidates.push({ source: `localStorage:${key}`, token: val });
            continue;
          }
          // Попробуем распарсить как JSON и поискать внутри
          try {
            const parsed = JSON.parse(val);
            const found = searchObjectForToken(parsed);
            if (found) candidates.push({ source: `localStorage:${key}`, token: found });
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}

    // 2. sessionStorage
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key) continue;
        try {
          const val = sessionStorage.getItem(key);
          if (!val) continue;
          if (/^AQ[A-Za-z0-9_-]{20,}$/.test(val)) {
            candidates.push({ source: `sessionStorage:${key}`, token: val });
            continue;
          }
          try {
            const parsed = JSON.parse(val);
            const found = searchObjectForToken(parsed);
            if (found) candidates.push({ source: `sessionStorage:${key}`, token: found });
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}

    // 3. Глобальные переменные (React state, Redux store, etc.)
    const globalKeys = [
      '__INITIAL_STATE__', '__initialState__', '__APP_STATE__',
      '__store__', '__redux__', '__NEXT_DATA__', '__props__',
    ];
    for (const gk of globalKeys) {
      try {
        const val = (window || {})[gk];
        if (val) {
          const found = searchObjectForToken(val);
          if (found) candidates.push({ source: `window.${gk}`, token: found });
        }
      } catch (_) {}
    }

    // 4. Redux store через __REDUX_DEVTOOLS_EXTENSION__
    try {
      if (window.__REDUX_DEVTOOLS_EXTENSION__) {
        const store = window.__store__ || window.store;
        if (store?.getState) {
          const state = store.getState();
          const found = searchObjectForToken(state);
          if (found) candidates.push({ source: 'redux.store', token: found });
        }
      }
    } catch (_) {}

    // 5. Cookies — ищем токен в cookie
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, ...rest] = cookie.trim().split('=');
        const val = rest.join('=');
        if (/^AQ[A-Za-z0-9_-]{20,}$/.test(val)) {
          candidates.push({ source: `cookie:${name}`, token: val });
        }
      }
    } catch (_) {}

    return candidates;
  }

  function extractTokenFromNetwork() {
    // Ищем токен в Performance API — заголовки ответов
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (entry.name.includes('/api/statistics2/') || entry.name.includes('partner.yandex.ru')) {
          // К сожалению, Performance API не даёт заголовки запросов
          // Но мы можем перехватить через override fetch
        }
      }
    } catch (_) {}

    // Альтернатива: перехват fetch на время следующего запроса
    // Это сложнее — делаем через monkey-patching (см. ниже)
    return null;
  }

  /**
   * Агрессивный поиск: monkey-patch fetch на 3 секунды,
   * чтобы перехватить следующий API-запрос дашборда и вытащить Authorization header.
   */
  function interceptNextFetch(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const origFetch = window.fetch;
      let found = null;
      let timer = setTimeout(() => {
        window.fetch = origFetch;
        resolve(found);
      }, timeoutMs);

      window.fetch = function (...args) {
        const [url, opts] = args;
        const authHeader = opts?.headers?.Authorization || opts?.headers?.authorization;
        if (authHeader && typeof authHeader === 'string') {
          const match = authHeader.match(/OAuth\s+(.+)/i);
          if (match?.[1]) {
            found = match[1].trim();
            clearTimeout(timer);
            window.fetch = origFetch;
            resolve(found);
            // Выполняем оригинальный запрос
            return origFetch.apply(this, args);
          }
        }
        // Проверяем Headers object
        if (opts?.headers instanceof Headers) {
          const auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
          if (auth) {
            const match = auth.match(/OAuth\s+(.+)/i);
            if (match?.[1]) {
              found = match[1].trim();
              clearTimeout(timer);
              window.fetch = origFetch;
              resolve(found);
              return origFetch.apply(this, args);
            }
          }
        }
        return origFetch.apply(this, args);
      };

      // Триггерим обновление данных (если на дэшборде)
      // Клик по странице может вызвать API-запрос
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (_) {}
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  DOM-парсер (fallback)
  // ═══════════════════════════════════════════════════════════

  async function scrollWidgetTable(widgetEl) {
    const scrollable =
      widgetEl.querySelector('.public_fixedDataTable_body') ||
      widgetEl.querySelector('.fixedDataTableLayout_rowsContainer');

    if (!scrollable) {
      log('scroll', 'scrollable not found, skip');
      return;
    }

    await DELAY(200);

    const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
    if (maxScroll <= 0) {
      log('scroll', `no scroll needed (scrollHeight=${scrollable.scrollHeight})`);
      return;
    }

    log('scroll', `scrolling ${maxScroll}px`);
    const step = Math.max(200, Math.floor(maxScroll / 40));
    let pos = 0;

    while (pos < maxScroll) {
      pos = Math.min(pos + step, maxScroll);
      scrollable.scrollTop = pos;
      await DELAY(120);
    }

    scrollable.scrollTop = 0;
    await DELAY(200);
    log('scroll', 'done');
  }

  function buildMetricInfo(headerTexts) {
    const order = [];
    for (const h of headerTexts) {
      const hl = h.toLowerCase();
      if (hl === 'дата' || hl === 'тип блока' || hl === 'итого' || hl === '') continue;
      if (/\d/.test(h)) continue;
      if (hl.includes('вознаграждение')) order.push('revenue');
      else if (hl.includes('видимые показы')) order.push('visibleImpressions');
      else if (hl === 'показы') order.push('impressions');
      else if (hl === 'ecpm') order.push('ecpm');
      else if (hl.includes('клик')) order.push('clicks');
      else if (hl.includes('ctr')) order.push('ctr');
    }

    const hasImpressions = order.includes('impressions');
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'visibleImpressions' && !hasImpressions) {
        order[i] = 'impressions';
      }
    }

    const hasBlockType = headerTexts.some((h) => h.toLowerCase() === 'тип блока');
    const fieldsPerRow = 1 + (hasBlockType ? 1 : 0) + order.length;

    return { order, hasBlockType, fieldsPerRow };
  }

  function parseRows(cellTexts, metricInfo) {
    const { order, fieldsPerRow } = metricInfo;
    const rows = [];
    let i = 0;

    while (i < cellTexts.length) {
      if (parseDate(cellTexts[i])) {
        if (i + fieldsPerRow > cellTexts.length) break;
        const row = { date: parseDate(cellTexts[i]) };
        let offset = 1;

        if (metricInfo.hasBlockType) {
          row.blockType = cellTexts[i + offset] || '';
          offset = 2;
        }

        for (let mi = 0; mi < order.length; mi++) {
          const val = cellTexts[i + offset + mi];
          const metric = order[mi];
          if (metric === 'revenue' || metric === 'ecpm') {
            row[metric] = parseMoney(val);
          } else {
            row[metric] = parseNum(val);
          }
        }

        rows.push(row);
        i += fieldsPerRow;
      } else {
        i++;
      }
    }

    return rows;
  }

  function buildMetrics(rows, metricOrder) {
    const metrics = {};
    for (const m of metricOrder) {
      if (m === 'visibleImpressions') continue;
      metrics[m] = {};
    }
    for (const row of rows) {
      for (const m of Object.keys(metrics)) {
        if (row[m] !== undefined) {
          metrics[m][row.date] = row[m];
        }
      }
    }
    return metrics;
  }

  function findWidgets() {
    let widgets = document.querySelectorAll('[data-testid="piWidgetRenderer.WidgetStatisticsTable"]');
    if (widgets.length > 0) return Array.from(widgets);

    const cards = document.querySelectorAll('.dc-Card');
    const result = [];
    for (const card of cards) {
      const link = card.querySelector('a[data-testid="Link"]');
      const table = card.querySelector('.public_fixedDataTable_main');
      if (link && table) {
        result.push(card);
      }
    }
    return result;
  }

  async function collectData() {
    try {
      log('init', window.location.href);

      const widgets = findWidgets();
      if (widgets.length === 0) {
        throw new Error('Таблицы статистики не найдены на странице.');
      }

      log('foundWidgets', `${widgets.length} виджетов`);

      const allApps = [];

      for (let wi = 0; wi < widgets.length; wi++) {
        const widget = widgets[wi];
        await scrollWidgetTable(widget);

        const linkEl = widget.querySelector('[data-testid="Link"]');
        const appName = getText(linkEl) || `App ${wi + 1}`;

        const headerEls = widget.querySelectorAll('[data-testid^="HeaderCell"]');
        const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
        const metricInfo = buildMetricInfo(headerTexts);

        log('widget', `${appName} | metrics: ${JSON.stringify(metricInfo.order)} | fieldsPerRow: ${metricInfo.fieldsPerRow}`);

        const cellEls = widget.querySelectorAll('[data-testid="Cell"]');
        const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

        log('widget', `${appName}: ${cellTexts.length} cells`);

        const rows = parseRows(cellTexts, metricInfo);
        const metrics = buildMetrics(rows, metricInfo.order);

        log('widget', `${appName}: ${rows.length} rows, dates: ${Object.keys(metrics.impressions || {}).length}`);

        allApps.push({
          appId: appName,
          name: appName,
          platform: 'rsya',
          metrics,
        });
      }

      const result = {
        platform: 'rsya',
        timestamp: new Date().toISOString(),
        dateRange: null,
        apps: allApps,
        _debugLog: LOG,
      };

      log('done', `${allApps.length} приложений`);
      return { success: true, data: result };

    } catch (e) {
      LOG.push({ t: Date.now(), step: 'FATAL', detail: e.message });
      return { success: false, error: e.message, _debugLog: LOG };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Обработчик сообщений
  // ═══════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // ── Извлечение OAuth-токена из страницы ──
    if (msg.action === 'extractRsyaToken') {
      // 1. Быстрый поиск в storage и globals
      const candidates = extractTokenFromStorage();
      if (candidates.length > 0) {
        console.log('[AMH] Token candidates found:', candidates.length, candidates.map(c => c.source));
        sendResponse({ token: candidates[0].token, source: candidates[0].source, allCandidates: candidates });
        return false;
      }

      // 2. Monkey-patch fetch чтобы перехватить следующий API-запрос
      console.log('[AMH] No token in storage, intercepting fetch...');
      interceptNextFetch(5000).then((token) => {
        if (token) {
          console.log('[AMH] Token intercepted from fetch');
          sendResponse({ token, source: 'fetch-intercept' });
        } else {
          console.log('[AMH] No token intercepted');
          sendResponse({ token: null, error: 'Токен не найден' });
        }
      });
      return true; // async
    }

    // ── Тестовый вызов API прямо из content script (same-origin) ──
    if (msg.action === 'testRsyaApiFromPage') {
      fetch('/api/statistics2/tree.json?lang=ru&pretty=1', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(data => {
          sendResponse({ success: true, result: data.result, treeNodes: data.data?.tree?.length });
        })
        .catch(e => {
          sendResponse({ success: false, error: e.message });
        });
      return true; // async
    }

    // ── DOM-парсинг (fallback) ──
    if (msg.action === 'collectYandexAds') {
      collectData().then(sendResponse);
      return true;
    }

    if (msg.action === 'ping') {
      sendResponse({ alive: true, platform: 'rsya', url: window.location.href });
      return false;
    }
  });
})();