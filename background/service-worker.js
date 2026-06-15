// background/service-worker.js
// Оркестрация сбора данных, управление storage, форматирование в Markdown

const KEYS = {
  APPS: 'amh_apps',
  DATA: 'amh_dailyData',
  STATUS: 'amh_collectionStatus',
  RSYA_TOKEN: 'amh_rsyaToken',
  RSYA_BY_BLOCK: 'amh_rsyaByBlockType',
  GP_OVERVIEW: 'amh_gpOverview',
  GP_APP_LIST_URL: 'amh_gpAppListUrl',
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
async function getRsyaByBlockType() {
  return (await chrome.storage.local.get(KEYS.RSYA_BY_BLOCK))[KEYS.RSYA_BY_BLOCK] || {};
}
async function saveRsyaByBlockType(data) {
  await chrome.storage.local.set({ [KEYS.RSYA_BY_BLOCK]: data });
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

// Мердж данных РСЯ по типам блоков
function mergeRsyaByBlockType(stored, byBlockType) {
  if (!byBlockType || typeof byBlockType !== 'object') return stored;

  for (const [appName, blocks] of Object.entries(byBlockType)) {
    if (!stored[appName]) stored[appName] = {};
    for (const [blockType, metrics] of Object.entries(blocks)) {
      if (!stored[appName][blockType]) {
        stored[appName][blockType] = { clicks: {}, shows: {}, revenue: {} };
      }
      for (const [metricName, dateValues] of Object.entries(metrics)) {
        if (!dateValues || typeof dateValues !== 'object') continue;
        if (!stored[appName][blockType][metricName]) {
          stored[appName][blockType][metricName] = {};
        }
        Object.assign(stored[appName][blockType][metricName], dateValues);
      }
    }
  }
  return stored;
}

// ═══════════════════════════════════════════════════════════
//  Auto-register РСЯ apps discovered during collection
// ═══════════════════════════════════════════════════════════

async function ensureRsyaAppsRegistered(rsyaApps) {
  if (!rsyaApps || !Array.isArray(rsyaApps)) return { added: 0, total: 0 };

  const existing = await getApps();
  const existingRsyaIds = new Set(
    existing.filter((a) => a.platform === 'rsya').map((a) => a.appId)
  );

  const newApps = rsyaApps
    .filter((a) => !existingRsyaIds.has(a.appId))
    .map((a) => ({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      appId: a.appId,
      name: a.name,
      platform: 'rsya',
      url: '',
      groupId: '',
      rustoreUrl: '',
      googlePlayUrl: '',
      repoUrl: '',
    }));

  if (newApps.length > 0) {
    const merged = [...existing, ...newApps];
    await saveApps(merged);
    return { added: newApps.length, total: merged.length, apps: merged };
  }

  return { added: 0, total: existing.length, apps: existing };
}

// ═══════════════════════════════════════════════════════════
//  Auto-link: fuzzy name matching across platforms
// ═══════════════════════════════════════════════════════════

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
      );
    }
  }
  return dp[m][n];
}

function nameSimilarity(name1, name2) {
  const a = normalizeName(name1);
  const b = normalizeName(name2);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.85;

  // Word-based Jaccard similarity
  const wordsA = new Set(a.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 2));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  // Levenshtein similarity
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const levSim = maxLen > 0 ? 1 - dist / maxLen : 0;

  return Math.max(jaccard, levSim);
}

async function autoLinkApps() {
  const apps = await getApps();
  const THRESHOLD = 0.5;

  // Only consider ungrouped apps
  const ungrouped = apps.filter((a) => !a.groupId);
  if (ungrouped.length < 2) {
    return { success: true, linked: 0, groups: [], message: 'Недостаточно негруппированных приложений' };
  }

  // Union-Find
  const parent = {};
  const find = (x) => {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  };
  const union = (a, b) => { parent[find(a)] = find(b); };

  for (const app of ungrouped) parent[app.id] = app.id;

  // Compare all pairs from different platforms
  const pairs = [];
  for (let i = 0; i < ungrouped.length; i++) {
    for (let j = i + 1; j < ungrouped.length; j++) {
      if (ungrouped[i].platform === ungrouped[j].platform) continue;
      const sim = nameSimilarity(ungrouped[i].name, ungrouped[j].name);
      if (sim >= THRESHOLD) {
        pairs.push({ i, j, sim });
      }
    }
  }

  if (pairs.length === 0) {
    return { success: true, linked: 0, groups: [], message: 'Похожие приложения не найдены (порог: ' + (THRESHOLD * 100) + '%)' };
  }

  pairs.sort((a, b) => b.sim - a.sim);
  for (const { i, j } of pairs) union(ungrouped[i].id, ungrouped[j].id);

  // Build groups
  const groupsMap = {};
  for (const app of ungrouped) {
    const root = find(app.id);
    if (!groupsMap[root]) groupsMap[root] = [];
    groupsMap[root].push(app);
  }

  let linkCount = 0;
  const linkedGroups = [];

  for (const [, members] of Object.entries(groupsMap)) {
    const platforms = new Set(members.map((a) => a.platform));
    if (platforms.size < 2) continue;

    // Use the shortest name as groupId
    const sorted = [...members].sort((a, b) => a.name.length - b.name.length);
    const groupId = sorted[0].name;

    for (const member of members) {
      const idx = apps.findIndex((a) => a.id === member.id);
      if (idx >= 0) {
        apps[idx].groupId = groupId;
        linkCount++;
      }
    }

    linkedGroups.push({
      groupId,
      apps: members.map((a) => ({ name: a.name, platform: a.platform })),
    });
  }

  if (linkCount > 0) await saveApps(apps);

  return {
    success: true,
    linked: linkCount,
    groups: linkedGroups,
    message: linkCount > 0
      ? `Связано ${linkCount} приложений в ${linkedGroups.length} групп(ы)`
      : 'Нет подходящих пар для связывания',
  };
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

async function sendToTab(tabId, message, retries = 4, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      // При первой ошибке пробуем инжектить content script
      if (i === 0) {
        try {
          await injectContentScript(tabId);
        } catch (_) {}
      }
      if (i === retries - 1)
        throw new Error(
          `Не удалось отправить сообщение в таб ${tabId} после ${retries} попыток`
        );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Инжект content script в вкладку если он не загрузился автоматически
 * (например, вкладка была открыта до установки расширения).
 */
async function injectContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';

  let file = null;
  if (url.includes('partner.yandex.ru')) file = 'content/yandex-ads.js';
  else if (url.includes('console.rustore.ru/apps/') && url.includes('/statistics')) file = 'content/rustore.js';
  else if (/console\.rustore\.ru\/apps\/?$/.test(url)) file = 'content/rustore-apps.js';
  else if (url.includes('play.google.com/console')) file = 'content/googleplay.js';

  if (!file) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
  });
  console.log(`[AMH] Injected ${file} into tab ${tabId}`);
  await new Promise(r => setTimeout(r, 300));
}

// ═══════════════════════════════════════════════════════════
//  РСЯ: делегирование API-запросов в content script
//  (content script на partner.yandex.ru имеет доступ к cookies)
// ═══════════════════════════════════════════════════════════

/**
 * Найти или открыть вкладку на partner.yandex.ru и выполнить action.
 */
async function ensureRsyaTabAndSend(action, data = {}) {
  // Ищем уже открытую вкладку
  const tabs = await chrome.tabs.query({ url: '*://partner.yandex.ru/*' });
  let tabId;

  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    // Открываем дашборд
    const tab = await chrome.tabs.create({ url: 'https://partner.yandex.ru/v2/dashboard', active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    // SPA — ждём рендер
    await new Promise(r => setTimeout(r, 5000));
  }

  return sendToTab(tabId, { action, data }, 3, 2000);
}


// ═══════════════════════════════════════════════════════════
//  Сбор данных с одного URL
// ═══════════════════════════════════════════════════════════

const PLATFORM_ACTION = {
  rustore: 'collectRuStore',
  googleplay: 'collectGooglePlay',
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
    const spaDelay = 3500;
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
  let rsyaByBlock = await getRsyaByBlockType();
  const results = [];
  const total = apps.length;
  let workerTabId = null;

  // Разделяем приложения: РСЯ и остальные
  const rsyaApps = apps.filter((a) => a.platform === 'rsya');
  const otherApps = apps.filter((a) => a.platform !== 'rsya');

  const effectiveTotal = (rsyaApps.length > 0 ? 1 : 0) + otherApps.length;
  await setStatus({ status: 'collecting', current: 0, total: effectiveTotal });

  // ── РСЯ: API (один запрос для всех приложений) ──
  if (rsyaApps.length > 0) {
    chrome.action.setBadgeText({ text: `РСЯ` });
    chrome.action.setBadgeBackgroundColor({ color: '#4361ee' });
    await setStatus({ status: 'collecting', current: 1, total: effectiveTotal, appName: 'РСЯ (API)' });

    const token = await getRsyaToken();
    if (token) {
      const rsyaResult = await ensureRsyaTabAndSend('collectRsyaApi', { token });
      if (rsyaResult?.success) {
        mergeRsyaData(dailyData, rsyaResult.data.apps);
        // Сохраняем разбивку по типам блоков
        if (rsyaResult.data.byBlockType) {
          rsyaByBlock = mergeRsyaByBlockType(rsyaByBlock, rsyaResult.data.byBlockType);
          await saveRsyaByBlockType(rsyaByBlock);
        }
        // Auto-register РСЯ apps in the apps list
        await ensureRsyaAppsRegistered(rsyaResult.data.apps);
        results.push({
          app: `${rsyaResult.data.apps.length} РСЯ приложений`,
          success: true,
          source: 'api',
          hasBlockType: !!rsyaResult.data.byBlockType,
        });
      } else {
        results.push({ app: 'РСЯ', success: false, error: rsyaResult?.error || 'нет ответа' });
      }
    } else {
      results.push({ app: 'РСЯ', success: false, error: 'Укажите OAuth-токен РСЯ в настройках' });
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
//  Дашборд: получение данных для отдельной страницы
// ═══════════════════════════════════════════════════════════

async function getDashboardData(payload) {
  const { appIds, dateFrom, dateTo, includeBlockType } = payload;
  const dailyData = await getDailyData();
  const rsyaByBlock = await getRsyaByBlockType();
  const apps = await getApps();

  // Фильтр по списку appIds (от группового селекта дашборда)
  let platformData = dailyData;
  if (appIds && Array.isArray(appIds) && appIds.length > 0) {
    const allowedMap = new Map();
    for (const { platform, appId } of appIds) {
      allowedMap.set(`${platform}:${appId}`, true);
    }
    const filtered = {};
    for (const [plat, platData] of Object.entries(platformData)) {
      filtered[plat] = {};
      for (const [aid, metrics] of Object.entries(platData)) {
        if (!allowedMap.has(`${plat}:${aid}`)) continue;
        filtered[plat][aid] = metrics;
      }
      if (Object.keys(filtered[plat]).length === 0) delete filtered[plat];
    }
    platformData = filtered;
  }

  // Фильтр по датам
  if (dateFrom || dateTo) {
    const filtered = {};
    for (const [plat, platData] of Object.entries(platformData)) {
      filtered[plat] = {};
      for (const [aid, metrics] of Object.entries(platData)) {
        filtered[plat][aid] = {};
        for (const [metric, dateVals] of Object.entries(metrics)) {
          const filteredVals = {};
          for (const [d, v] of Object.entries(dateVals)) {
            if (dateFrom && d < dateFrom) continue;
            if (dateTo && d > dateTo) continue;
            filteredVals[d] = v;
          }
          if (Object.keys(filteredVals).length > 0) {
            filtered[plat][aid][metric] = filteredVals;
          }
        }
        if (Object.keys(filtered[plat][aid]).length === 0) {
          delete filtered[plat][aid];
        }
      }
      if (Object.keys(filtered[plat]).length === 0) {
        delete filtered[plat];
      }
    }
    platformData = filtered;
  }

  // Данные по типам блоков для дашборда
  let blockTypeData = null;
  if (includeBlockType && rsyaByBlock) {
    // Собираем допустимые РСЯ appIds
    const allowedRsyaIds = new Set();
    if (appIds && Array.isArray(appIds)) {
      for (const { platform, appId } of appIds) {
        if (platform === 'rsya') allowedRsyaIds.add(appId);
      }
    }

    blockTypeData = {};
    for (const [appName, blocks] of Object.entries(rsyaByBlock)) {
      // Фильтр по списку appIds (только РСЯ)
      if (allowedRsyaIds.size > 0 && !allowedRsyaIds.has(appName)) continue;

      blockTypeData[appName] = {};
      for (const [btName, metrics] of Object.entries(blocks)) {
        const filteredMetrics = {};
        for (const [metric, dateVals] of Object.entries(metrics)) {
          const filteredVals = {};
          for (const [d, v] of Object.entries(dateVals)) {
            if (dateFrom && d < dateFrom) continue;
            if (dateTo && d > dateTo) continue;
            filteredVals[d] = v;
          }
          if (Object.keys(filteredVals).length > 0) {
            filteredMetrics[metric] = filteredVals;
          }
        }
        if (Object.keys(filteredMetrics).length > 0) {
          blockTypeData[appName][btName] = filteredMetrics;
        }
      }
      if (Object.keys(blockTypeData[appName]).length === 0) {
        delete blockTypeData[appName];
      }
    }
  }

  return { dailyData: platformData, byBlockType: blockTypeData, apps };
}

// ═══════════════════════════════════════════════════════════
//  Обработчик сообщений от popup / dashboard
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

        // ── РСЯ: API через content script (токен обязателен) ──
        if (url.includes('partner.yandex.ru')) {
          const tabId = tabs[0].id;
          (async () => {
            try {
              const token = await getRsyaToken();
              if (!token) {
                sendResponse({ success: false, error: 'Укажите OAuth-токен РСЯ в настройках расширения' });
                return;
              }
              const result = await sendToTab(tabId, { action: 'collectRsyaApi', data: { token } }, 3, 2000);
              if (result?.success) {
                const dailyData = await getDailyData();
                mergeRsyaData(dailyData, result.data.apps);
                await saveDailyData(dailyData);
                // Сохраняем разбивку по типам блоков
                if (result.data.byBlockType) {
                  let rsyaByBlock = await getRsyaByBlockType();
                  rsyaByBlock = mergeRsyaByBlockType(rsyaByBlock, result.data.byBlockType);
                  await saveRsyaByBlockType(rsyaByBlock);
                }
                // Auto-register РСЯ apps
                await ensureRsyaAppsRegistered(result.data.apps);
              }
              sendResponse(result || { success: false, error: 'нет ответа от content script' });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          })();
          return true;
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
      chrome.storage.local.set({ [KEYS.DATA]: {}, [KEYS.RSYA_BY_BLOCK]: {} }).then(() => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ success: true });
      });
      return true;

    case 'saveGpAppListUrl':
      chrome.storage.local.set({ [KEYS.GP_APP_LIST_URL]: msg.data.url }).then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'getGpAppListUrl':
      chrome.storage.local.get(KEYS.GP_APP_LIST_URL).then((r) => {
        sendResponse({ url: r[KEYS.GP_APP_LIST_URL] || '' });
      });
      return true;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true;

    case 'scanGooglePlayApps': {
      (async () => {
        try {
          // Проверяем сохранённый URL
          const stored = (await chrome.storage.local.get(KEYS.GP_APP_LIST_URL))[KEYS.GP_APP_LIST_URL];
          if (!stored) {
            sendResponse({ success: false, needUrl: true });
            return;
          }

          const tab = await chrome.tabs.create({
            url: stored,
            active: true,
          });
          const tabId = tab.id;
          await waitForTabLoad(tabId);
          // SPA — ждём рендеринг Angular
          await new Promise((r) => setTimeout(r, 4000));

          const resp = await sendToTab(tabId, { action: 'scanGooglePlayApps' });
          if (!resp?.success) {
            sendResponse({ success: false, error: resp?.error || 'Скан не вернул данные' });
            return;
          }

          // Регистрация новых приложений
          const existing = await getApps();
          const existingGpIds = new Set(
            existing.filter((a) => a.platform === 'googleplay').map((a) => a.appId)
          );

          const newApps = resp.apps
            .filter((a) => a.appId && !existingGpIds.has(a.appId))
            .map((a) => ({
              id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
              ...a,
            }));

          const merged = [...existing, ...newApps];
          await saveApps(merged);

          // Сохранить обзорные метрики (30-дневные снепшоты)
          const overview = {};
          for (const app of resp.apps) {
            if (app.appId && app.overview) {
              overview[app.appId] = {
                ...app.overview,
                name: app.name,
                status: app.status,
                lastUpdate: app.lastUpdate,
                iconUrl: app.iconUrl,
                googlePlayUrl: app.googlePlayUrl,
                fetchedAt: new Date().toISOString(),
              };
            }
          }
          if (Object.keys(overview).length > 0) {
            await chrome.storage.local.set({ [KEYS.GP_OVERVIEW]: overview });
          }

          sendResponse({
            success: true,
            added: newApps.length,
            total: resp.apps.length,
            apps: merged,
            overview,
          });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
        // Вкладку НЕ закрываем
      })();
      return true;
    }

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

    // ── Тест РСЯ API (tree.json через content script на same-origin) ──
    case 'testRsyaApi': {
      (async () => {
        try {
          const token = await getRsyaToken();
          const result = await ensureRsyaTabAndSend('testRsyaTree', { token: token || null });
          sendResponse(result);
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
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

    // ── Автосвязывание приложений ──
    case 'autoLinkApps': {
      autoLinkApps().then(sendResponse);
      return true;
    }

    // ── Dashboard: получить отфильтрованные данные ──
    case 'getDashboardData': {
      getDashboardData(msg.data || {}).then(sendResponse);
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