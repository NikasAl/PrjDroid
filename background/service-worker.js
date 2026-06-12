// background/service-worker.js
// Оркестрация сбора данных, управление storage, форматирование в Markdown

const KEYS = {
  APPS: 'amh_apps',
  DATA: 'amh_dailyData',
  STATUS: 'amh_collectionStatus',
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

// ═══════════════════════════════════════════════════════════
//  Merge: вливаем новые данные в хранилище (без перезаписи старых дат)
// ═══════════════════════════════════════════════════════════

function mergeData(stored, platform, appId, metrics) {
  if (!stored[platform]) stored[platform] = {};
  if (!stored[platform][appId]) stored[platform][appId] = {};

  for (const [metricName, dateValues] of Object.entries(metrics)) {
    if (metricName.startsWith('_')) continue; // пропускаем _error
    if (typeof dateValues !== 'object' || dateValues === null) continue;

    if (!stored[platform][appId][metricName])
      stored[platform][appId][metricName] = {};

    // Новые данные перезаписывают старые для той же даты
    Object.assign(stored[platform][appId][metricName], dateValues);
  }
  return stored;
}

// ═══════════════════════════════════════════════════════════
//  Таб-менеджмент: открытие, ожидание загрузки, отправка сообщения
// ═══════════════════════════════════════════════════════════

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    // Если уже загружен
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
//  Сбор данных с одного URL
// ═══════════════════════════════════════════════════════════

const PLATFORM_ACTION = {
  rustore: 'collectRuStore',
  googleplay: 'collectGooglePlay',
  rsya: 'collectYandexAds',
};

async function collectFromUrl(url, platform) {
  let tabId;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId);
    // SPA — даём React время отрендерить
    await new Promise((r) => setTimeout(r, 3500));

    const action = PLATFORM_ACTION[platform];
    if (!action) throw new Error(`Неизвестная платформа: ${platform}`);

    const response = await sendToTab(tabId, { action });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Content script не вернул данные');
    }
    return response.data;
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
    }
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

  await setStatus({ status: 'collecting', current: 0, total });

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];

    chrome.action.setBadgeText({ text: `${i + 1}/${total}` });
    chrome.action.setBadgeBackgroundColor({ color: '#4361ee' });

    await setStatus({
      status: 'collecting',
      current: i + 1,
      total,
      appName: app.name,
    });

    try {
      const data = await collectFromUrl(app.url, app.platform);
      const metrics = data.metrics || {};
      const effectiveAppId = data.appId || app.appId;
      dailyData = mergeData(dailyData, app.platform, effectiveAppId, metrics);
      results.push({ app: app.name, success: true, appId: effectiveAppId });
    } catch (e) {
      results.push({ app: app.name, success: false, error: e.message });
    }

    // Сохраняем после каждого приложения (на случай прерывания)
    await saveDailyData(dailyData);
  }

  // Готово
  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#2ec4b6' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);

  await setStatus({
    status: 'done',
    results,
    timestamp: new Date().toISOString(),
  });

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

      // Просмотры
      L.push('### RuStore — Просмотры страницы по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '| ' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rustore', 'views', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      // Установки
      L.push('### RuStore — Все установки по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '| ' +
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
          '| ' +
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
          '| ' +
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

      // Показы
      L.push('### РСЯ — Показы рекламы по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '| ' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rsya', 'impressions', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      // Клики
      L.push('### РСЯ — Клики по дням');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '| ' +
            fmtDate(d) +
            ' | ' +
            ids
              .map((id) => num(getCol(id, 'rsya', 'clicks', d, dailyData)))
              .join(' | ') +
            ' |'
        );
      }
      L.push('');

      // Доход
      L.push('### РСЯ — Доход по дням (руб.)');
      L.push('| Дата | ' + names.join(' | ') + ' |');
      L.push(sep);
      for (const d of dates) {
        L.push(
          '| ' +
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
        let action = null;
        if (url.includes('console.rustore.ru')) action = 'collectRuStore';
        else if (url.includes('play.google.com/console')) action = 'collectGooglePlay';
        else if (url.includes('partner.yandex.ru')) action = 'collectYandexAds';

        if (!action) {
          sendResponse({ success: false, error: 'Эта страница не поддерживается' });
          return;
        }
        chrome.tabs
          .sendMessage(tabs[0].id, { action })
          .then(async (resp) => {
            if (resp?.success) {
              const data = resp.data;
              const metrics = data.metrics || {};
              const dailyData = await getDailyData();
              const merged = mergeData(
                dailyData,
                data.platform,
                data.appId,
                metrics
              );
              await saveDailyData(merged);
            }
            sendResponse(resp);
          })
          .catch((e) =>
            sendResponse({ success: false, error: e.message })
          );
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
        let tabId;
        try {
          const tab = await chrome.tabs.create({
            url: 'https://console.rustore.ru/apps',
            active: false,
          });
          tabId = tab.id;
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
        } finally {
          if (tabId) {
            try { await chrome.tabs.remove(tabId); } catch (_) {}
          }
        }
      })();
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