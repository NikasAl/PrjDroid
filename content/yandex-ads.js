// content/yandex-ads.js — РСЯ: API-запросы (same-origin) + извлечение токена + DOM-парсинг (fallback)
// Важно: все fetch к partner.yandex.ru идут ЗДЕСЬ, т.к. content script выполняется
// в контексте partner.yandex.ru и имеет доступ к cookies этого домена.

if (window.__amhRsyaLoaded) {
  // Уже загружен (через manifest или предыдущий inject)
} else {
  window.__amhRsyaLoaded = true;

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH-RSYA ${step}]`, detail);
  }

  function clearLog() {
    LOG.length = 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  РСЯ API — запросы с same-origin (cookies включены автоматически)
  // ═══════════════════════════════════════════════════════════

  async function rsyaApiFetch(endpoint, params = {}, token = null) {
    const url = new URL(`https://partner.yandex.ru/api/statistics2/${endpoint}`);
    url.searchParams.set('lang', 'ru');

    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, String(v)));
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = { Accept: 'application/json' };
    if (token) {
      headers['Authorization'] = `OAuth ${token}`;
    }

    // credentials: 'same-origin' — отправляет cookies partner.yandex.ru
    // (в content script это дефолт, но явно для ясности)
    const resp = await fetch(url.toString(), {
      credentials: 'same-origin',
      headers,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} — ${body.substring(0, 500)}`);
    }

    return resp.json();
  }

  /**
   * Найти поле по точному id (приоритет) или по keywords в label/title.
   * exactIds — массив точных id для прямого match.
   * keywords — фоллбэк, ищет в label/title/id.
   */
  function findFieldId(fields, exactIds = [], keywords = []) {
    if (!fields || !Array.isArray(fields)) return null;

    // 1. Точный match по id
    for (const eid of exactIds) {
      const found = fields.find(f => f.id === eid);
      if (found) return found.id;
    }

    // 2. Fuzzy по label/title/id
    if (keywords.length > 0) {
      for (const f of fields) {
        const haystack = ((f.label || '') + ' ' + (f.title || '') + ' ' + (f.id || '')).toLowerCase();
        if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
          // Проверяем что это не "своя реклама" или "Я.Директ"
          const id = f.id || '';
          if (id.includes('_own') || id.includes('_direct') || id.includes('rec_')) continue;
          return f.id;
        }
      }
    }
    return null;
  }

  /**
   * Основной сборщик РСЯ через API.
   * Выполняется в content script на partner.yandex.ru — имеет доступ к cookies.
   */
  async function collectRsyaViaApi(token = null) {
    clearLog();

    try {
      log('api-start', token ? `Token длиной ${token.length}` : 'Без токена (cookies only)');

      // ── 1. tree.json — обнаруживаем доступные поля ──
      const treeResp = await rsyaApiFetch('tree.json', { pretty: 1 }, token);
      log('tree-raw', JSON.stringify(treeResp).substring(0, 2000));

      if (treeResp.result !== 'ok' || !treeResp.data?.tree?.length) {
        const detail = treeResp.result
          ? `result="${treeResp.result}", tree.length=${treeResp.data?.tree?.length || 0}`
          : `result is falsy: "${treeResp.result}", keys: [${Object.keys(treeResp).join(', ')}]`;
        throw new Error(`tree.json: ${detail}`);
      }

      const node = treeResp.data.tree[0];
      const ef = node.entity_fields || [];
      const mf = node.fields || [];

      log('tree', `node="${node.id}" (${node.title}), entity_fields=${ef.length}, fields=${mf.length}`);

      // ── 2. Обнаруживаем ID полей ──
      const appNameField = findFieldId(ef, ['page_caption'], ['название сайта', 'название приложения', 'page caption', 'page name']);
      const appIdField = findFieldId(ef, ['page_id'], ['page id']);

      const revenueField = findFieldId(mf, ['partner_wo_nds'], ['вознаграждение', 'доход', 'revenue']);
      const showsField = findFieldId(mf, ['shows'], ['видимые показы', 'показы рекламы']);
      const impressionsField = findFieldId(mf, ['impressions'], ['показы']);
      const clicksField = findFieldId(mf, ['clicks'], ['клик']);
      const ecpmField = findFieldId(mf, ['ecpm_partner_wo_nds'], ['ecpm']);

      // Показы: prioritise shows (видимые) over impressions
      const effectiveShows = showsField || impressionsField;

      log('fields', JSON.stringify({
        entity: { appIdField, appNameField },
        metrics: { revenueField, showsField: effectiveShows, impressionsField, clicksField, ecpmField },
      }));

      if (!appIdField && !appNameField) {
        throw new Error('Не найдены поля для идентификации приложения в tree.json');
      }
      if (!revenueField && !effectiveShows) {
        throw new Error('Не найдены метрики (вознаграждение/показы) в tree.json');
      }

      // ── 3. Параметры запроса ──
      const entityFields = [];
      if (appNameField) entityFields.push(appNameField);

      const metricFields = [revenueField, effectiveShows, clicksField].filter(Boolean);

      // ── 4. get.json (90 дней, один запрос) ──
      const params = {
        dimension_field: 'date|day',
        period: '90days',
        entity_field: entityFields,
        field: metricFields,
      };

      const data = await rsyaApiFetch('get.json', params, token);

      if (data.result !== 'ok') {
        const errMsg = data.errors
          ? Object.entries(data.errors).map(([k,v]) => `${k}: ${v}`).join('; ')
          : `result="${data.result}"`;
        throw new Error(`get.json: ${errMsg}`);
      }

      const allPoints = data.data?.points || [];
      log('total', `${allPoints.length} точек данных`);

      // ── 5. Ключ группировки — это наш entity_field (page_caption) ──
      const appNameKey = appNameField;

      // ── 6. Группируем по приложениям и датам ──
      const appsMap = {};

      for (const point of allPoints) {
        const dims = point.dimensions || {};
        const measures = point.measures?.[0] || {};

        const dateArr = dims.date;
        if (!dateArr?.[0]) continue;
        const date = dateArr[0];

        const appName = appNameKey ? String(dims[appNameKey] || 'Unknown') : 'Unknown';

        if (!appsMap[appName]) {
          appsMap[appName] = { revenue: {}, impressions: {}, clicks: {}, ecpm: {} };
        }

        const app = appsMap[appName];

        if (revenueField && typeof measures[revenueField] === 'number') {
          app.revenue[date] = (app.revenue[date] || 0) + measures[revenueField];
        }
        if (effectiveShows && typeof measures[effectiveShows] === 'number') {
          app.impressions[date] = (app.impressions[date] || 0) + measures[effectiveShows];
        }
        if (clicksField && typeof measures[clicksField] === 'number') {
          app.clicks[date] = (app.clicks[date] || 0) + measures[clicksField];
        }
      }

      // ── 7. eCPM из revenue/impressions ──
      for (const app of Object.values(appsMap)) {
        for (const date of Object.keys(app.impressions)) {
          const imp = app.impressions[date];
          const rev = app.revenue[date];
          if (imp > 0 && rev !== undefined) {
            app.ecpm[date] = (rev / imp) * 1000;
          }
        }
      }

      // ── 8. Формируем результат ──
      const apps = Object.entries(appsMap).map(([name, m]) => ({
        appId: name,
        name: name,
        platform: 'rsya',
        metrics: {
          revenue: m.revenue,
          impressions: m.impressions,
          clicks: m.clicks,
          ecpm: m.ecpm,
        },
      }));

      log('done', `${apps.length} приложений через API`);

      return {
        success: true,
        data: {
          platform: 'rsya',
          timestamp: new Date().toISOString(),
          dateRange: null,
          apps,
          _source: 'api',
          _debugLog: LOG,
        },
      };
    } catch (e) {
      log('error', e.message);
      return {
        success: false,
        error: e.message,
        _debugLog: LOG,
        _source: 'api',
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Извлечение OAuth-токена из контекста страницы
  // ═══════════════════════════════════════════════════════════

  function searchObjectForToken(obj, depth = 0, visited = new Set()) {
    if (depth > 4 || !obj || typeof obj !== 'object') return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    if (typeof obj === 'string') {
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
      if (kl.includes('token') || kl.includes('oauth') || kl.includes('auth') || kl.includes('access')) {
        if (typeof val === 'string' && val.length > 20 && /^[A-Za-z0-9_-]+$/.test(val)) {
          return val;
        }
      }
      if (typeof val === 'object' && val !== null) {
        const r = searchObjectForToken(val, depth + 1, visited);
        if (r) return r;
      }
    }
    return null;
  }

  function extractTokenFromStorage() {
    const candidates = [];

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        try {
          const val = localStorage.getItem(key);
          if (!val) continue;
          if (/^AQ[A-Za-z0-9_-]{20,}$/.test(val)) {
            candidates.push({ source: `localStorage:${key}`, token: val });
            continue;
          }
          try {
            const parsed = JSON.parse(val);
            const found = searchObjectForToken(parsed);
            if (found) candidates.push({ source: `localStorage:${key}`, token: found });
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}

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

    try {
      if (window.__REDUX_DEVTOOLS_EXTENSION__) {
        const store = window.__store__ || window.store;
        if (store?.getState) {
          const found = searchObjectForToken(store.getState());
          if (found) candidates.push({ source: 'redux.store', token: found });
        }
      }
    } catch (_) {}

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

  /**
   * Monkey-patch fetch чтобы перехватить Authorization header из следующего API-запроса.
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
        const [, opts] = args;
        const authHeader = opts?.headers?.Authorization || opts?.headers?.authorization;
        if (authHeader && typeof authHeader === 'string') {
          const match = authHeader.match(/OAuth\s+(.+)/i);
          if (match?.[1]) {
            found = match[1].trim();
            clearTimeout(timer);
            window.fetch = origFetch;
            resolve(found);
            return origFetch.apply(this, args);
          }
        }
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

      try {
        window.dispatchEvent(new Event('resize'));
      } catch (_) {}
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  DOM-парсер (fallback)
  // ═══════════════════════════════════════════════════════════

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

  async function scrollWidgetTable(widgetEl) {
    const scrollable =
      widgetEl.querySelector('.public_fixedDataTable_body') ||
      widgetEl.querySelector('.fixedDataTableLayout_rowsContainer');

    if (!scrollable) return;

    await DELAY(200);

    const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
    if (maxScroll <= 0) return;

    const step = Math.max(200, Math.floor(maxScroll / 40));
    let pos = 0;

    while (pos < maxScroll) {
      pos = Math.min(pos + step, maxScroll);
      scrollable.scrollTop = pos;
      await DELAY(120);
    }

    scrollable.scrollTop = 0;
    await DELAY(200);
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
      if (link && table) result.push(card);
    }
    return result;
  }

  async function collectData() {
    try {
      log('dom-init', window.location.href);

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

        const cellEls = widget.querySelectorAll('[data-testid="Cell"]');
        const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

        const rows = parseRows(cellTexts, metricInfo);
        const metrics = buildMetrics(rows, metricInfo.order);

        allApps.push({
          appId: appName,
          name: appName,
          platform: 'rsya',
          metrics,
        });
      }

      log('dom-done', `${allApps.length} приложений`);
      return {
        success: true,
        data: {
          platform: 'rsya',
          timestamp: new Date().toISOString(),
          dateRange: null,
          apps: allApps,
          _source: 'dom',
          _debugLog: LOG,
        },
      };
    } catch (e) {
      LOG.push({ t: Date.now(), step: 'FATAL', detail: e.message });
      return { success: false, error: e.message, _debugLog: LOG, _source: 'dom' };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Обработчик сообщений от service worker / popup
  // ═══════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // ── API-запрос РСЯ (выполняется здесь, на partner.yandex.ru) ──
    if (msg.action === 'collectRsyaApi') {
      const token = msg.data?.token || null;
      collectRsyaViaApi(token).then(sendResponse);
      return true; // async
    }

    // ── Быстрый тест: только tree.json ──
    if (msg.action === 'testRsyaTree') {
      const token = msg.data?.token || null;
      const headers = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `OAuth ${token}`;

      fetch('https://partner.yandex.ru/api/statistics2/tree.json?lang=ru&pretty=1', {
        credentials: 'same-origin',
        headers,
      })
        .then(r => r.text())
        .then(text => {
          try {
            const json = JSON.parse(text);
            sendResponse({
              success: true,
              result: json.result,
              treeLength: json.data?.tree?.length || 0,
              treeTitle: json.data?.tree?.[0]?.title || '',
              rawPreview: text.substring(0, 1000),
            });
          } catch (_) {
            sendResponse({ success: false, error: 'Не JSON', rawPreview: text.substring(0, 500) });
          }
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    // ── Извлечение OAuth-токена из страницы ──
    if (msg.action === 'extractRsyaToken') {
      const candidates = extractTokenFromStorage();
      if (candidates.length > 0) {
        sendResponse({ token: candidates[0].token, source: candidates[0].source, allCandidates: candidates });
        return false;
      }

      interceptNextFetch(5000).then((token) => {
        if (token) {
          sendResponse({ token, source: 'fetch-intercept' });
        } else {
          sendResponse({ token: null, error: 'Токен не найден' });
        }
      });
      return true;
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

} // end __amhRsyaLoaded guard