// popup/popup.js — Упрощённый UI (редактор перенесён на apps/apps.html)

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════
//  Элементы
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const el = {
  appList: $('#app-list'),
  appCount: $('#app-count'),
  btnManageApps: $('#btn-manage-apps'),
  btnScanRuStore: $('#btn-scan-rustore'),
  btnScanGooglePlay: $('#btn-scan-googleplay'),
  btnCollectAll: $('#btn-collect-all'),
  btnCollectCurrent: $('#btn-collect-current'),
  statusBar: $('#status-bar'),
  dataSummary: $('#data-summary'),
  btnExport: $('#btn-export'),
  btnClear: $('#btn-clear'),
  btnTestRsya: $('#btn-test-rsya'),
  rsyaStatus: $('#rsya-status'),
  fRsyaToken: $('#f-rsya-token'),
  btnSaveToken: $('#btn-save-token'),
  btnDashboard: $('#btn-dashboard'),
};

// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════

let apps = [];
let dailyData = {};

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════

async function init() {
  apps = (await sendMsg('getApps')) || [];
  dailyData = (await sendMsg('getDailyData')) || {};
  renderAppList();
  renderDataSummary();
  updateButtons();
  bindEvents();

  const status = await sendMsg('getStatus');
  if (status && status.status === 'collecting') {
    showStatus('collecting', `Сбор: ${status.current}/${status.total} — ${status.appName}...`);
    pollStatus();
  }

  const tokenResp = await sendMsg('getRsyaToken');
  if (tokenResp) {
    el.fRsyaToken.value = tokenResp.token || '';
  }
}

// ═══════════════════════════════════════════════════════════
//  Events
// ═══════════════════════════════════════════════════════════

function bindEvents() {
  el.btnManageApps.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('apps/apps.html') });
  });
  el.btnScanGooglePlay.addEventListener('click', scanGooglePlayApps);
  el.btnScanRuStore.addEventListener('click', scanRuStoreApps);
  el.btnCollectAll.addEventListener('click', collectAll);
  el.btnCollectCurrent.addEventListener('click', collectCurrentPage);
  el.btnExport.addEventListener('click', exportMarkdown);
  el.btnClear.addEventListener('click', clearData);
  el.btnTestRsya.addEventListener('click', testRsyaApi);
  el.btnSaveToken.addEventListener('click', saveRsyaToken);
  el.btnDashboard.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// ═══════════════════════════════════════════════════════════
//  App list (read-only)
// ═══════════════════════════════════════════════════════════

function renderAppList() {
  const count = apps.length;
  el.appCount.textContent = count > 0 ? `(${count})` : '';

  if (count === 0) {
    el.appList.innerHTML = '<p class="empty-state">Нет добавленных приложений</p>';
    return;
  }

  const platformLabel = { rustore: 'RuStore', googleplay: 'GP', rsya: 'РСЯ' };
  const platformOrder = { rsya: 0, rustore: 1, googleplay: 2 };

  const sorted = [...apps].sort((a, b) => {
    // Grouped first
    if (a.groupId && !b.groupId) return -1;
    if (!a.groupId && b.groupId) return 1;
    if (a.groupId && b.groupId && a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId, 'ru');
    const pa = platformOrder[a.platform] ?? 9;
    const pb = platformOrder[b.platform] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, 'ru');
  });

  el.appList.innerHTML = sorted
    .map((a) => {
      const groupTag = a.groupId ? `<span class="group-tag" title="Группа: ${esc(a.groupId)}">🔗</span>` : '';
      return `
    <div class="app-item">
      <span class="platform-badge ${a.platform}">${platformLabel[a.platform] || a.platform}</span>
      <span class="app-name" title="${esc(a.name)}">${esc(a.name)}</span>
      ${groupTag}
    </div>`;
    })
    .join('');
}

// ═══════════════════════════════════════════════════════════
//  Сканирование Google Play
// ═══════════════════════════════════════════════════════════

async function scanGooglePlayApps() {
  el.btnScanGooglePlay.disabled = true;
  el.btnScanGooglePlay.textContent = 'Загрузка...';
  showStatus('collecting', 'Открываем Google Play Console...');

  try {
    const result = await sendMsg('scanGooglePlayApps');
    if (result.success) {
      apps = result.apps;
      renderAppList();
      updateButtons();
      if (result.added > 0) {
        showStatus('done', `GP: найдено ${result.total}, добавлено ${result.added} новых`);
      } else {
        showStatus('done', `GP: найдено ${result.total} приложений — все уже в списке`);
      }
    } else {
      showStatus('error', result.error || 'Ошибка сканирования Google Play');
    }
  } catch (e) {
    showStatus('error', e.message);
  } finally {
    el.btnScanGooglePlay.disabled = false;
    el.btnScanGooglePlay.textContent = '📱 Из Google Play';
  }
}

// ═══════════════════════════════════════════════════════════
//  Сканирование RuStore
// ═══════════════════════════════════════════════════════════

async function scanRuStoreApps() {
  el.btnScanRuStore.disabled = true;
  el.btnScanRuStore.textContent = 'Загрузка...';
  showStatus('collecting', 'Открываем RuStore Console...');

  try {
    const result = await sendMsg('scanRuStoreApps');
    if (result.success) {
      apps = result.apps;
      renderAppList();
      updateButtons();
      if (result.added > 0) {
        showStatus('done', `Найдено ${result.total}, добавлено ${result.added} новых`);
      } else {
        showStatus('done', `Найдено ${result.total} приложений — все уже в списке`);
      }
    } else {
      showStatus('error', result.error || 'Ошибка сканирования');
    }
  } catch (e) {
    showStatus('error', e.message);
  } finally {
    el.btnScanRuStore.disabled = false;
    el.btnScanRuStore.textContent = '🔄 Из RuStore';
  }
}

// ═══════════════════════════════════════════════════════════
//  Сбор данных
// ═══════════════════════════════════════════════════════════

async function collectAll() {
  if (apps.length === 0) return alert('Сначала добавьте приложения');

  el.btnCollectAll.disabled = true;
  showStatus('collecting', 'Запуск сбора данных...');

  try {
    const result = await sendMsg('collectAll');
    if (result.success) {
      dailyData = result.data || {};
      // Reload apps — РСЯ apps may have been auto-registered
      apps = (await sendMsg('getApps')) || [];
      renderAppList();

      const errors = result.results.filter((r) => !r.success);
      if (errors.length > 0) {
        const errText = errors.map((e) => `${e.app}: ${e.error}`).join('\n');
        showStatus('done', `Собрано! Ошибки:\n${errText}`);
      } else {
        showStatus('done', `Собрано успешно (${result.results.length} приложений)`);
      }
      renderDataSummary();
      updateButtons();
    } else {
      showStatus('error', result.error || 'Ошибка сбора');
    }
  } catch (e) {
    showStatus('error', e.message);
  } finally {
    el.btnCollectAll.disabled = false;
  }
}

async function collectCurrentPage() {
  el.btnCollectCurrent.disabled = true;
  showStatus('collecting', 'Парсинг текущей страницы...');

  try {
    const result = await sendMsg('collectCurrentPage');
    if (result.success) {
      if (result.data?._debugLog) {
        console.log('[AMH Debug Log]', result.data._debugLog);
      }
      dailyData = (await sendMsg('getDailyData')) || {};
      // Reload apps — РСЯ apps may have been auto-registered
      apps = (await sendMsg('getApps')) || [];
      renderAppList();

      showStatus('done', `Данные ${result.data?.platform || ''} собраны`);
      renderDataSummary();
      updateButtons();
    } else {
      if (result._debugLog) {
        console.log('[AMH Debug Log]', result._debugLog);
      }
      showStatus('error', result.error || 'Ошибка парсинга');
    }
  } catch (e) {
    showStatus('error', e.message);
  } finally {
    el.btnCollectCurrent.disabled = false;
  }
}

function pollStatus() {
  const interval = setInterval(async () => {
    const status = await sendMsg('getStatus');
    if (!status || status.status !== 'collecting') {
      clearInterval(interval);
      if (status && status.status === 'done') {
        dailyData = (await sendMsg('getDailyData')) || {};
        apps = (await sendMsg('getApps')) || [];
        renderAppList();
        renderDataSummary();
        updateButtons();
        const errors = (status.results || []).filter((r) => !r.success);
        if (errors.length > 0) {
          showStatus('done', `Готово. ${errors.length} ошибок.`);
        } else {
          showStatus('done', 'Все данные собраны!');
        }
      }
    } else {
      showStatus('collecting', `${status.current}/${status.total} — ${status.appName}...`);
    }
  }, 1500);
}

// ═══════════════════════════════════════════════════════════
//  Предпросмотр данных
// ═══════════════════════════════════════════════════════════

function renderDataSummary() {
  const hasData = Object.keys(dailyData).length > 0;
  if (!hasData) {
    el.dataSummary.innerHTML = '<p class="empty-state">Данные появятся после сбора</p>';
    return;
  }

  const appName = (platform, appId) => {
    const a = apps.find(
      (a) => a.platform === platform && (a.appId === appId || a.url?.includes(appId))
    );
    return a ? a.name : appId;
  };

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
  const sortedDates = Array.from(dates).sort();
  if (sortedDates.length === 0) {
    el.dataSummary.innerHTML = '<p class="empty-state">Данных нет</p>';
    return;
  }

  const recent = sortedDates.slice(-7);
  const fmtDate = (d) => {
    const [, m, day] = d.split('-');
    return `${day}.${m}`;
  };
  const num = (v) =>
    v !== undefined && v !== null ? Number(v).toLocaleString('ru-RU') : '—';

  let html = '';

  if (dailyData.rustore) {
    const ids = Object.keys(dailyData.rustore);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('rustore', id));
      html += '<h3>RuStore — Просмотры</h3>';
      html += buildMiniTable(recent, ids, 'views', 'rustore', names, fmtDate, num);
      html += '<h3>RuStore — Установки</h3>';
      html += buildMiniTable(recent, ids, 'installations', 'rustore', names, fmtDate, num);
    }
  }

  if (dailyData.googleplay) {
    const ids = Object.keys(dailyData.googleplay);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('googleplay', id));
      html += '<h3>Google Play — Просмотры</h3>';
      html += buildMiniTable(recent, ids, 'views', 'googleplay', names, fmtDate, num);
      html += '<h3>Google Play — Установки</h3>';
      html += buildMiniTable(recent, ids, 'installations', 'googleplay', names, fmtDate, num);
    }
  }

  if (dailyData.rsya) {
    const ids = Object.keys(dailyData.rsya);
    if (ids.length > 0) {
      const names = ids.map((id) => appName('rsya', id));
      html += '<h3>РСЯ — Показы</h3>';
      html += buildMiniTable(recent, ids, 'impressions', 'rsya', names, fmtDate, num);
      html += '<h3>РСЯ — Клики</h3>';
      html += buildMiniTable(recent, ids, 'clicks', 'rsya', names, fmtDate, num);
      html += '<h3>РСЯ — Доход</h3>';
      html += buildMiniTable(
        recent, ids, 'revenue', 'rsya', names, fmtDate, num,
        (v) => (v !== undefined && v !== null ? Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '—')
      );
      html += '<h3>РСЯ — eCPM</h3>';
      html += buildMiniTable(
        recent, ids, 'ecpm', 'rsya', names, fmtDate, num,
        (v) => (v !== undefined && v !== null ? Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '—')
      );
    }
  }

  el.dataSummary.innerHTML = html;
}

function buildMiniTable(dates, ids, metric, platform, names, fmtDate, num, customFmt) {
  const fmt = customFmt || num;
  let h = '<table><thead><tr><th>Дата</th>';
  names.forEach((n) => (h += `<th>${esc(n)}</th>`));
  h += '</tr></thead><tbody>';
  for (const d of dates) {
    h += `<tr><td>${fmtDate(d)}</td>`;
    ids.forEach((id) => {
      const v = dailyData[platform]?.[id]?.[metric]?.[d];
      h += `<td>${fmt(v)}</td>`;
    });
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}

// ═══════════════════════════════════════════════════════════
//  Экспорт
// ═══════════════════════════════════════════════════════════

async function exportMarkdown() {
  try {
    const result = await sendMsg('exportMarkdown');
    if (result.success) {
      await navigator.clipboard.writeText(result.markdown);
      const origText = el.btnExport.textContent;
      el.btnExport.textContent = 'Скопировано!';
      el.btnExport.classList.add('btn-primary');
      setTimeout(() => {
        el.btnExport.textContent = origText;
        el.btnExport.classList.remove('btn-primary');
      }, 1500);
    }
  } catch (e) {
    alert('Ошибка копирования: ' + e.message);
  }
}

async function clearData() {
  if (!confirm('Удалить все собранные данные?')) return;
  await sendMsg('clearData');
  dailyData = {};
  renderDataSummary();
  updateButtons();
  showStatus('done', 'Данные очищены');
}

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

function sendMsg(action, data) {
  const msg = data !== undefined ? { action, data } : { action };
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

function showStatus(type, text) {
  el.statusBar.className = `status-bar ${type}`;
  el.statusBar.textContent = text;
  el.statusBar.classList.remove('hidden');
}

function updateButtons() {
  const hasApps = apps.length > 0;
  const hasData = Object.keys(dailyData).length > 0;
  el.btnCollectAll.disabled = !hasApps;
  el.btnExport.disabled = !hasData;
  el.btnClear.disabled = !hasData;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ═══════════════════════════════════════════════════════════
//  РСЯ API: тест и токен
// ═══════════════════════════════════════════════════════════

async function testRsyaApi() {
  el.btnTestRsya.disabled = true;
  el.btnTestRsya.textContent = '...';
  el.rsyaStatus.className = 'rsya-status';
  el.rsyaStatus.textContent = 'Проверяю tree.json (через content script)...';

  try {
    const result = await sendMsg('testRsyaApi');

    if (result.success) {
      let info = `✓ tree.json ответил! узлов: ${result.treeLength}`;
      if (result.treeTitle) info += `\nУзел: "${result.treeTitle}"`;
      if (result.rawPreview) console.log('[AMH] tree.json raw:', result.rawPreview);
      el.rsyaStatus.className = 'rsya-status ok';
      el.rsyaStatus.textContent = info;
    } else {
      const err = result.error || 'Неизвестная ошибка';
      let hint = '';
      if (err.includes('HTTP 401') || err.includes('HTTP 403')) hint = '\n→ Нужен OAuth-токен.';
      else if (err.includes('HTTP 429')) hint = '\n→ Слишком много запросов.';
      else if (err.includes('Failed to fetch')) hint = '\n→ Ошибка сети.';
      el.rsyaStatus.className = 'rsya-status fail';
      el.rsyaStatus.textContent = `✗ ${err}${hint}`;
    }
  } catch (e) {
    el.rsyaStatus.className = 'rsya-status fail';
    el.rsyaStatus.textContent = `✗ ${e.message}`;
  } finally {
    el.btnTestRsya.disabled = false;
    el.btnTestRsya.textContent = 'Тест';
  }
}

async function saveRsyaToken() {
  const token = el.fRsyaToken.value.trim();
  await sendMsg('saveRsyaToken', { token });
  if (token) {
    const orig = el.btnSaveToken.textContent;
    el.btnSaveToken.textContent = '✓';
    setTimeout(() => {
      el.btnSaveToken.textContent = orig;
    }, 1200);
  }
}