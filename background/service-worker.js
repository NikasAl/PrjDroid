// background/service-worker.js
// Оркестрация сбора данных, управление storage, форматирование в Markdown

const KEYS = {
  APPS: 'amh_apps',
  DATA: 'amh_dailyData',
  STATUS: 'amh_collectionStatus',
  RSYA_TOKEN: 'amh_rsyaToken',
};

// ═══════════════════════════════════════════════════════════
//  Storage helpers
// ═══════════════════════════════════════════════════════════

async function getApps() {
  return (await chrome.storage.local.get(KEYS.APPS))[KEYS.APPS] || [];
}
async function saveApps(apps) {
  await chrome.storage.local.set({ [KEYS.APPS]: apps });
}
async function getDailyData() {
  return (await chrome.storage.local.get(KEYS.DATA))[KEYS.DATA] || {};
}
async function saveDailyData(data) {
  await chrome.storage.local.set({ [KEYS.DATA]: data });
}
async function getStatus() {
  return (
    (await chrome.storage.local.get(KEYS.STATUS))[KEYS.STATUS] || {
      status: 'idle',
    }
  );
}
async function setStatus(s) {
  await chrome.storage.local.set({ [KEYS.STATUS]: s });
}
async function getRsyaToken() {
  return (await chrome.storage.local.get(KEYS.RSYA_TOKEN))[KEYS.RSYA_TOKEN] || '';
}
async function saveRsyaToken(token) {
  await chrome.storage.local.set({ [KEYS.RSYA_TOKEN]: token });
}

// ═══════════════════════════════════════════════════════════
//  Merge: вливаем новые данные в хранилище (без перезаписи старых дат)
// ═══════════════════════════════════════════════════════════

function mergeData(stored, platform, appId, metrics) {
  if (!stored[platform]) stored[platform] = {};
  if (!stored[platform][appId]) stored[platform][appId] = {};

  for (const [metricName, dateValues] of Object.entries(metrics)) {
    if (metricName.startsWith('_')) continue;
    if (typeof dateValues !== 'object' || dateValues === null) continue;

    if (!stored[platform][appId][metricName])
      stored[platform][appId][metricName] = {};

    Object.assign(stored[platform][appId][metricName], dateValues);
  }
  return stored;
}

// Мердж данных РСЯ: несколько приложений с дэшборда за один вызов
function mergeRsyaData(stored, apps) {
  for (const app of apps) {
    const appId = app.appId;
    for (const metric of ['impressions', 'revenue', 'clicks', 'ecpm']) {
      const dateValues = app.metrics[metric];
      if (!dateValues || typeof dateValues !== 'object') continue;
      const cleanValues = {};
      for (const [date, val] of Object.entries(dateValues)) {
        if (typeof val === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          cleanValues[date] = val;
        }
      }
      if (Object.keys(cleanValues).length > 0) {
        mergeData(stored, 'rsya', appId, { [metric]: cleanValues });
      }
    }
  }
  return stored;
}

// ═══════════════════════════════════════════════════════════
//  Таб-менеджмент: открытие, ожидание загрузки, отправка сообщения
// ═══════════════════════════════════════════════════════════

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') return resolve();
    });

    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToTab(tabId, message, retries = 6, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      if (i === retries - 1)
        throw new Error(
          `Не удалось отправить сообщение в таб ${tabId} после ${retries} попыток`
        );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  РСЯ API Collector — запросы к partner.yandex.ru/api/statistics2
// ═══════════════════════════════════════════════════════════

const RSYA_API = 'https://partner.yandex.ru/api/statistics2';

/**
 * Обёртка над fetch для API РСЯ.
 * Поддерживает cookies (credentials:include) и OAuth-токен.
 */
async function rsyaApiFetch(endpoint, params = {}, token = null) {
  const url = new URL(`${RSYA_API}/${endpoint}`);
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

  const resp = await fetch(url.toString(), {
    credentials: 'include',
    headers,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API ${endpoint}: HTTP ${resp.status} — ${body.substring(0, 300)}`);
  }

  return resp.json();
}

/**
 * Поиск ID поля по ключевым словам в label/title/id.
 */
function findFieldId(fields, ...keywords) {
  if (!fields || !Array.isArray(fields)) return null;
  for (const f of fields) {
    const haystack = ((f.label || '') + ' ' + (f.title || '') + ' ' + (f.id || '')).toLowerCase();
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) return f.id;
  }
  return null;
}

/**
 * Основной сборщик РСЯ через API.
 * 1. Запрашивает tree.json для обнаружения доступных полей
 * 2. Запрашивает get.json со всеми метриками за 90 дней
 * 3. Парсит ответ в формат расширения
 */
async function collectRsyaViaApi(token = null) {
  const LOG = [];
  const log = (step, detail) => {
    LOG.push({ t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    console.log(`[AMH-RSYA-API ${step}]`, detail);
  };

  try {
    log('start', token ? 'Используем сохранённый токен' : 'Пробуем с session cookies');

    // ── 1. Получаем дерево статистики ──
    const treeResp = await rsyaApiFetch('tree.json', { pretty: 1 }, token);
    if (treeResp.result !== 'ok' || !treeResp.data?.tree?.length) {
      throw new Error(`tree.json вернул: ${treeResp.result || 'пустой ответ'}`);
    }

    const node = treeResp.data.tree[0];
    const ef = node.entity_fields || [];
    const mf = node.fields || [];

    log('tree', `node="${node.id}" (${node.title}), entity_fields=${ef.length}, fields=${mf.length}`);

    // ── 2. Обнаруживаем ID полей по названиям ──
    // Поля-группировки (entity_fields)
    const appIdField = findFieldId(ef, 'page id', 'page_id');
    const appNameField = findFieldId(ef, 'название пейджа', 'page name', 'page caption', 'название блока');
    const blockTypeField = findFieldId(ef, 'блочный уровень', 'block level', 'тип блока', 'block type', 'ad format', 'ad unit name', 'блок');

    // Метрики (fields)
    const revenueField = findFieldId(mf, 'вознаграждение', 'доход', 'revenue', 'partner_wo');
    const showsField = findFieldId(mf, 'показы рекламы', 'показы в блок', 'shows');
    const showsVisibleField = findFieldId(mf, 'видимые показы', 'visible shows', 'visible impressions');
    const clicksField = findFieldId(mf, 'клик', 'click');
    const ecpmField = findFieldId(mf, 'ecpm');

    const effectiveShows = showsField || showsVisibleField;

    log('discovered', {
      entity: { appIdField, appNameField, blockTypeField },
      metrics: { revenueField, showsField: effectiveShows, showsVisibleField, clicksField, ecpmField },
    });

    if (!appIdField && !appNameField) {
      throw new Error('В дереве статистики не найдены поля для идентификации приложения');
    }
    if (!revenueField && !effectiveShows) {
      throw new Error('В дереве статистики не найдены метрики (вознаграждение/показы)');
    }

    // ── 3. Собираем entity_field и field для запроса ──
    const entityFields = [];
    if (appIdField) entityFields.push(appIdField);
    if (appNameField && appNameField !== appIdField) entityFields.push(appNameField);
    // block_type добавляем отдельно — чтобы можно было агрегировать
    const useBlockType = !!blockTypeField && blockTypeField !== appIdField && blockTypeField !== appNameField;
    if (useBlockType) entityFields.push(blockTypeField);

    const metricFields = [revenueField, effectiveShows, clicksField, ecpmField].filter(Boolean);

    // ── 4. Запрашиваем данные с пагинацией ──
    const allPoints = [];
    let offset = 0;
    const limit = 1000;
    let pageNum = 0;

    while (true) {
      pageNum++;
      const params = {
        dimension_field: 'date|day',
        period: '90days',
        pretty: 1,
        limits: JSON.stringify({ limit, offset }),
        entity_field: entityFields,
        field: metricFields,
      };

      const data = await rsyaApiFetch('get.json', params, token);

      if (data.result !== 'ok') {
        throw new Error(`get.json вернул: ${data.result}`);
      }

      const points = data.data?.points || [];
      allPoints.push(...points);

      log('page', `страница ${pageNum}: ${points.length} точек (всего: ${allPoints.length})`);

      if (data.data?.is_last_page !== false || points.length === 0) break;
      offset += limit;
      if (pageNum >= 10) break; // safety
    }

    log('total', `${allPoints.length} точек данных получено`);

    // ── 5. Определяем ключи dimensions из первой точки ──
    let appNameKey = null;
    let blockTypeKey = null;

    for (const point of allPoints) {
      const dims = point.dimensions || {};
      for (const key of Object.keys(dims)) {
        if (key === 'date') continue;
        const val = dims[key];
        if (typeof val === 'string' && val.length > 2 && !appNameKey) {
          // Первое строковое поле (не date) — скорее всего название
          appNameKey = key;
        } else if (typeof val === 'string' && val.length > 0 && appNameKey && key !== appNameKey && !blockTypeKey) {
          blockTypeKey = key;
        }
      }
      if (appNameKey) break;
    }

    log('keys', { appNameKey, blockTypeKey });

    // ── 6. Группируем точки по приложениям и датам ──
    const appsMap = {}; // appName → { revenue: {date: val}, impressions: {...}, ... }

    for (const point of allPoints) {
      const dims = point.dimensions || {};
      const measures = point.measures?.[0] || {};

      const dateArr = dims.date;
      if (!dateArr?.[0]) continue;
      const date = dateArr[0];

      const appName = appNameKey ? String(dims[appNameKey] || 'Unknown') : 'Unknown';

      if (!appsMap[appName]) {
        appsMap[appName] = { revenue: {}, impressions: {}, clicks: {}, ecpm: {}, _raw: [] };
      }

      const app = appsMap[appName];

      // Суммируем метрики (для агрегации по block_type)
      if (revenueField && typeof measures[revenueField] === 'number') {
        app.revenue[date] = (app.revenue[date] || 0) + measures[revenueField];
      }
      if (effectiveShows && typeof measures[effectiveShows] === 'number') {
        app.impressions[date] = (app.impressions[date] || 0) + measures[effectiveShows];
      }
      if (clicksField && typeof measures[clicksField] === 'number') {
        app.clicks[date] = (app.clicks[date] || 0) + measures[clicksField];
      }
      // eCPM рассчитаем после агрегации
    }

    // ── 7. Рассчитываем eCPM из revenue/impressions ──
    for (const [appName, app] of Object.entries(appsMap)) {
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

    log('done', `${apps.length} приложений собрано через API`);

    return {
      success: true,
      data: {
        platform: 'rsya',
        timestamp: new Date().toISOString(),
        dateRange: null,
        apps,
        _source: 'api',
        _debugLog: LOG,
        _discoveredFields: {
          entity: { appIdField, appNameField, blockTypeField },
          metrics: { revenueField, showsField: effectiveShows, clicksField, ecpmField },
        },
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

/**
 * Пробуем получить токен из страницы (content script).
 * Ищет в localStorage, sessionStorage, глобальных переменных.
 */
async function extractTokenFromPage(tabId) {
  try {
    const resp = await sendToTab(tabId, { action: 'extractRsyaToken' }, 3, 1000);
    if (resp?.token) return resp.token;
  } catch (_) {}
  return null;
}

// ═══════════════════════════════════════════════════════════
//  Сбор данных с одного URL
// ═══════════════════════════════════════════════════════════

const PLATFORM_ACTION = {
  rustore: 'collectRuStore',
  googleplay: 'collectGooglePlay',
  rsya: 'collectYandexAds',
};

async function collectFromUrl(url, platform, reuseTabId) {
  let tabId = reuseTabId;
  try {
    if (tabId) {
      await chrome.tabs.update(tabId, { url, active: true });
    } else {
      const tab = await chrome.tabs.create({ url, active: true });
      tabId = tab.id;
    }

    await waitForTabLoad(tabId);
    const spaDelay = platform === 'rsya' ? 10000 : 3500;
    await new Promise((r) => setTimeout(r, spaDelay));

    const action = PLATFORM_ACTION[platform];
    if (!action) throw new Error(`Неизвестная платформа: ${platform}`);

    const response = await sendToTab(tabId, { action });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Content script не вернул данные');
    }
    return { data: response.data, tabId };
  } finally {
    // Вкладку НЕ закрываем
  }
}

// ═══════════════════════════════════════════════════════════
//  Сбор со всех настроенных приложений
// ═══════════════════════════════════════════════════════════

async function collectAll() {
  const apps = await getApps();
  if (apps.length === 0) {
    return { success: false, error: 'Нет настроенных приложений' };
  }

  let dailyData = await getDailyData();
  const results = [];
  const total = apps.length;
  let workerTabId = null;

  // Разделяем приложения: РСЯ и остальные
  const rsyaApps = apps.filter((a) => a.platform === 'rsya');
  const otherApps = apps.filter((a) => a.platform !== 'rsya');

  const effectiveTotal = (rsyaApps.length > 0 ? 1 : 0) + otherApps.length;
  await setStatus({ status: 'collecting', current: 0, total: effectiveTotal });

  // ── РСЯ: пробуем API (один запрос для всех приложений) ──
  if (rsyaApps.length > 0) {
    chrome.action.setBadgeText({ text: `РСЯ` });
    chrome.action.setBadgeBackgroundColor({ color: '#4361ee' });
    await setStatus({ status: 'collecting', current: 1, total: effectiveTotal, appName: 'РСЯ (API)' });

    const rsyaResult = await tryCollectRsya(null);
    if (rsyaResult.success) {
      mergeRsyaData(dailyData, rsyaResult.data.apps);
      results.push({
        app: `${rsyaResult.data.apps.length} РСЯ приложений (API)`,
        success: true,
        source: 'api',
      });
    } else {
      // API не сработал — пробуем DOM-парсинг
      console.log('[AMH] РСЯ API failed, trying DOM fallback:', rsyaResult.error);
      await setStatus({ status: 'collecting', current: 1, total: effectiveTotal, appName: 'РСЯ (DOM)' });

      try {
        const rsyaUrl = rsyaApps[0]?.url || 'https://partner.yandex.ru/v2/dashboard';
        const { data, tabId: usedTabId } = await collectFromUrl(rsyaUrl, 'rsya', workerTabId);
        if (usedTabId) workerTabId = usedTabId;

        if (data.apps) {
          mergeRsyaData(dailyData, data.apps);
          results.push({
            app: `${data.apps.length} РСЯ приложений (DOM)`,
            success: true,
            source: 'dom',
          });
        }
      } catch (e) {
        results.push({ app: 'РСЯ', success: false, error: e.message, apiError: rsyaResult.error });
      }
    }

    await saveDailyData(dailyData);
  }

  // ── Остальные платформы: по одному приложению через DOM ──
  for (let i = 0; i < otherApps.length; i++) {
    const app = otherApps[i];
    const idx = (rsyaApps.length > 0 ? 1 : 0) + i + 1;

    chrome.action.setBadgeText({ text: `${idx}/${effectiveTotal}` });
    chrome.action.setBadgeBackgroundColor({ color: '#4361ee' });
    await setStatus({ status: 'collecting', current: idx, total: effectiveTotal, appName: app.name });

    try {
      const { data, tabId: usedTabId } = await collectFromUrl(app.url, app.platform, workerTabId);
      if (usedTabId) workerTabId = usedTabId;

      const metrics = data.metrics || {};
      const effectiveAppId = data.appId || app.appId;
      dailyData = mergeData(dailyData, app.platform, effectiveAppId, metrics);
      results.push({ app: app.name, success: true, appId: effectiveAppId });
    } catch (e) {
      results.push({ app: app.name, success: false, error: e.message });
    }

    await saveDailyData(dailyData);
  }

  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#2ec4b6' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);

  await setStatus({ status: 'done', results, timestamp: new Date().toISOString() });
  return { success: true, results, data: dailyData };
}

/**
 * Три подхода для получения данных РСЯ:
 * 1. Cookies only (credentials:include)
 * 2. Токен из storage расширения
 * 3. Токен из страницы (через content script)
 */
async function tryCollectRsya(tabId) {
  // Подход 1: Cookies only
  let result = await collectRsyaViaApi(null);
  if (result.success) return result;

  const cookieError = result.error;
  console.log('[AMH] РСЯ API cookies-only failed:', cookieError);

  // Подход 2: Токен из storage расширения
  const savedToken = await getRsyaToken();
  if (savedToken) {
    result = await collectRsyaViaApi(savedToken);
    if (result.success) return result;
    console.log('[AMH] РСЯ API with saved token failed:', result.error);
  }

  // Подход 3: Попробовать извлечь токен из страницы
  if (tabId) {
    const pageToken = await extractTokenFromPage(tabId);
    if (pageToken) {
      console.log('[AMH] Found token from page, length:', pageToken.length);
      // Сохраняем для будущего использования
      await saveRsyaToken(pageToken);

      result = await collectRsyaViaApi(pageToken);
      if (result.success) return result;
      console.log('[AMH] РСЯ API with page token failed:', result.error);
    }
  }

  // Ни один подход не сработал
  return {
    success: false,
    error: `API: ${cookieError}${savedToken ? ' | Token: ' + result.error : ''}`,
    _debugLog: result._debugLog,
    _source: 'api-all-failed',
  };
}

// ═══════════════════════════════════════════════════════════
//  Форматирование в Markdown для LLM
// ═══════════════════════════════════════════════════════════

function fmtDate(d) {
  const [, m, day] = d.split('-');
  return `${day}.${m}`;
}

function num(val) {
  if (val === undefined || val === null) return '—';
  if (typeof val === 'number') {
    return Number.isInteger(val)
      ? val.toLocaleString('ru-RU')
      : val.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(val);
}

function getAllDates(dailyData) {
  const dates = new Set();
  for (const platform of Object.values(dailyData)) {
    for (const appData of Object.values(platform)) {
      for (const metricData of Object.values(appData)) {
        if (typeof metricData === 'object' && metricData !== null) {
          Object.keys(metricData).forEach((d) => dates.add(d));
        }
      }
    }
  }
  return Array.from(dates).sort();
}

function getCol(appId, platform, metric, date, dailyData) {
  return dailyData[platform]?.[appId]?.[metric]?.[date];
}

function formatMarkdown(dailyData, apps) {
  if (!dailyData || Object.keys(dailyData).length === 0) {
    return 'Нет собранных данных. Нажмите "Собрать все данные" в расширении.';
  }

  const appName = (platform, appId) => {
    const a = apps.find(
      (a) => a.platform === platform && (a.appId === appId || a.url?.includes(appId))
    );
    return a ? a.name : appId;
  };

  const dates = getAllDates(dailyData);
  const L = [];

  const now = new Date().toLocaleDateString('ru-RU');
  L.push(`## Статистика приложений — сбор от ${now}`);
  L.push('');

  // ── RuStore ──
  if (dailyData.rustore) {
    const ids = Object.keys(dailyData.rustore);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('rustore', id));
      const sep = '|' + '------|'.repeat(ids.length + 1);

      L.push('### RuStore — Просмотры страницы по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rustore', 'views', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      L.push('### RuStore — Все установки по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rustore', 'installations', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');
    }
  }

  // ── Google Play ──
  if (dailyData.googleplay) {
    const ids = Object.keys(dailyData.googleplay);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('googleplay', id));
      const sep = '|' + '------|'.repeat(ids.length + 1);

      L.push('### Google Play — Просмотры страницы по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'googleplay', 'views', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      L.push('### Google Play — Все установки по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) =>
                num(getCol(id, 'googleplay', 'installations', d, dailyData))
              )
              .join(' | ') +
            ' |'
        );
      }
      L.push('');
    }
  }

  // ── РСЯ ──
  if (dailyData.rsya) {
    const ids = Object.keys(dailyData.rsya);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('rsya', id));
      const sep = '|' + '------|'.repeat(ids.length + 1);

      L.push('### РСЯ — Показы рекламы по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rsya', 'impressions', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      L.push('### РСЯ — Клики по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rsya', 'clicks', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      L.push('### РСЯ — Доход по дням (руб.)');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => {
                const v = getCol(id, 'rsya', 'revenue', d, dailyData);
                return v !== undefined && v !== null ? num(v) + ' ₽' : '—';
              })
              .join(' | ') +
            ' |'
        );
      }
      L.push('### РСЯ — eCPM по дням (руб.)');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '|' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => {
                const v = getCol(id, 'rsya', 'ecpm', d, dailyData);
                return v !== undefined && v !== null ? num(v) + ' ₽' : '—';
              })
              .join(' | ') +
            ' |'
        );
      }
      L.push('');
    }
  }

  L.push('---');
  L.push(
    'Контекст: Разработчик мобильных приложений, хочет максимизировать прибыль от приложений и рекламы.'
  );
  L.push('Задача: Проанализируй статистику выше и предложи:');
  L.push('1. Какие приложения показывают рост/падение и возможные причины');
  L.push('2. Конверсия просмотров в установки по каждому приложению и магазину');
  L.push('3. Эффективность монетизации через РСЯ по каждому приложению');
  L.push('4. Конкретные рекомендации по максимизации прибыли');

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  Обработчик сообщений от popup
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'getApps':
      getApps().then(sendResponse);
      return true;

    case 'saveApps':
      saveApps(msg.data.apps).then(() => sendResponse({ success: true }));
      return true;

    case 'getDailyData':
      getDailyData().then(sendResponse);
      return true;

    case 'collectAll':
      collectAll().then(sendResponse);
      return true;

    case 'collectCurrentPage': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs.length) {
          sendResponse({ success: false, error: 'Нет активной вкладки' });
          return;
        }
        const url = tabs[0].url || '';

        // ── РСЯ: сначала пробуем API ──
        if (url.includes('partner.yandex.ru')) {
          tryCollectRsya(tabs[0].id)
            .then(async (apiResult) => {
              if (apiResult.success) {
                const dailyData = await getDailyData();
                mergeRsyaData(dailyData, apiResult.data.apps);
                await saveDailyData(dailyData);
                sendResponse(apiResult);
              } else {
                // Fallback на DOM-парсинг
                chrome.tabs
                  .sendMessage(tabs[0].id, { action: 'collectYandexAds' })
                  .then(async (resp) => {
                    if (resp?.success) {
                      const data = resp.data;
                      const dailyData = await getDailyData();
                      if (data.apps) {
                        mergeRsyaData(dailyData, data.apps);
                        await saveDailyData(dailyData);
                      }
                    }
                    sendResponse(
                      resp?.success
                        ? resp
                        : { success: false, error: `API: ${apiResult.error}\nDOM: ${resp?.error || 'нет ответа'}` }
                    );
                  })
                  .catch((e) =>
                    sendResponse({ success: false, error: `API: ${apiResult.error}\nDOM: ${e.message}` })
                  );
              }
            });
          return true; // async response
        }

        // ── RuStore / Google Play — как раньше ──
        let action = null;
        if (url.includes('console.rustore.ru')) action = 'collectRuStore';
        else if (url.includes('play.google.com/console')) action = 'collectGooglePlay';

        if (!action) {
          sendResponse({ success: false, error: 'Эта страница не поддерживается' });
          return;
        }
        chrome.tabs
          .sendMessage(tabs[0].id, { action })
          .then(async (resp) => {
            if (resp?.success) {
              const data = resp.data;
              const dailyData = await getDailyData();
              const metrics = data.metrics || {};
              const merged = mergeData(dailyData, data.platform, data.appId, metrics);
              await saveDailyData(merged);
            }
            sendResponse(resp);
          })
          .catch((e) => sendResponse({ success: false, error: e.message }));
      });
      return true;
    }

    case 'exportMarkdown':
      Promise.all([getDailyData(), getApps()]).then(([data, apps]) => {
        sendResponse({ success: true, markdown: formatMarkdown(data, apps) });
      });
      return true;

    case 'clearData':
      chrome.storage.local.set({ [KEYS.DATA]: {} }).then(() => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ success: true });
      });
      return true;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true;

    case 'scanRuStoreApps': {
      (async () => {
        try {
          const tab = await chrome.tabs.create({
            url: 'https://console.rustore.ru/apps',
            active: true,
          });
          const tabId = tab.id;
          await waitForTabLoad(tabId);
          await new Promise((r) => setTimeout(r, 3000));

          const resp = await sendToTab(tabId, { action: 'scanRuStoreApps' });
          if (!resp?.success) {
            sendResponse({ success: false, error: resp?.error || 'Скан не вернул данные' });
            return;
          }

          const existing = await getApps();
          const existingRuStoreIds = new Set(
            existing.filter((a) => a.platform === 'rustore').map((a) => a.appId)
          );

          const newApps = resp.apps
            .filter((a) => !existingRuStoreIds.has(a.appId))
            .map((a) => ({
              id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
              ...a,
            }));

          const merged = [...existing, ...newApps];
          await saveApps(merged);

          sendResponse({
            success: true,
            added: newApps.length,
            total: resp.apps.length,
            apps: merged,
          });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Тест РСЯ API (для диагностики) ──
    case 'testRsyaApi': {
      (async () => {
        const token = await getRsyaToken();
        const result = await collectRsyaViaApi(token || null);
        sendResponse(result);
      })();
      return true;
    }

    // ── Сохранить РСЯ токен вручную ──
    case 'saveRsyaToken': {
      saveRsyaToken(msg.data?.token || '').then(() => sendResponse({ success: true }));
      return true;
    }

    case 'getRsyaToken': {
      getRsyaToken().then(sendResponse);
      return true;
    }
  }
});

// Инициализация при установке
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(KEYS.APPS, (r) => {
    if (!r[KEYS.APPS]) {
      chrome.storage.local.set({ [KEYS.APPS]: [] });
    }
  });
});