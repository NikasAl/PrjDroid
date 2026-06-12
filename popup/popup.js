// popup/popup.js — UI-логика расширения App Metrics Harvester

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════
//  Элементы
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const el = {
  appList: $('#app-list'),
  addForm: $('#add-form'),
  fName: $('#f-name'),
  fPlatform: $('#f-platform'),
  fAppId: $('#f-appid'),
  fUrl: $('#f-url'),
  btnAdd: $('#btn-add'),
  btnSaveApp: $('#btn-save-app'),
  btnCancelAdd: $('#btn-cancel-add'),
  btnCollectAll: $('#btn-collect-all'),
  btnCollectCurrent: $('#btn-collect-current'),
  statusBar: $('#status-bar'),
  dataSummary: $('#data-summary'),
  btnExport: $('#btn-export'),
  btnClear: $('#btn-clear'),
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
  apps = await sendMsg('getApps') || [];
  dailyData = await sendMsg('getDailyData') || {};
  renderAppList();
  renderDataSummary();
  updateButtons();
  bindEvents();

  // Проверить статус сбора
  const status = await sendMsg('getStatus');
  if (status && status.status === 'collecting') {
    showStatus('collecting', `Сбор: ${status.current}/${status.total} — ${status.appName}...`);
    pollStatus();
  }
}

// ═══════════════════════════════════════════════════════════
//  Events
// ═══════════════════════════════════════════════════════════

function bindEvents() {
  el.btnAdd.addEventListener('click', toggleAddForm);
  el.btnCancelAdd.addEventListener('click', () => {
    el.addForm.classList.add('hidden');
    clearForm();
  });
  el.btnSaveApp.addEventListener('click', saveApp);
  el.fPlatform.addEventListener('change', autofillUrl);
  el.fAppId.addEventListener('input', autofillUrl);
  el.btnCollectAll.addEventListener('click', collectAll);
  el.btnCollectCurrent.addEventListener('click', collectCurrentPage);
  el.btnExport.addEventListener('click', exportMarkdown);
  el.btnClear.addEventListener('click', clearData);
}

// ═══════════════════════════════════════════════════════════
//  Приложения: CRUD
// ═══════════════════════════════════════════════════════════

function toggleAddForm() {
  el.addForm.classList.toggle('hidden');
  if (!el.addForm.classList.contains('hidden')) {
    el.fName.focus();
  }
}

function clearForm() {
  el.fName.value = '';
  el.fPlatform.value = 'rustore';
  el.fAppId.value = '';
  el.fUrl.value = '';
}

function autofillUrl() {
  const platform = el.fPlatform.value;
  const appId = el.fAppId.value.trim();
  if (!appId) return;

  const urls = {
    rustore: `https://console.rustore.ru/apps/${appId}/statistics`,
    googleplay: '', // Пользователь вводит вручную
    rsya: '', // Пользователь вводит вручную
  };
  if (urls[platform] && !el.fUrl.value) {
    el.fUrl.value = urls[platform];
  }
}

async function saveApp() {
  const name = el.fName.value.trim();
  const platform = el.fPlatform.value;
  const appId = el.fAppId.value.trim();
  let url = el.fUrl.value.trim();

  if (!name) return alert('Введите название приложения');
  if (!appId) return alert('Введите App ID');

  if (!url) {
    if (platform === 'rustore') {
      url = `https://console.rustore.ru/apps/${appId}/statistics`;
    } else {
      return alert('Введите URL статистики');
    }
  }

  apps.push({ id: Date.now().toString(), name, platform, appId, url });
  await sendMsg('saveApps', apps);

  el.addForm.classList.add('hidden');
  clearForm();
  renderAppList();
  updateButtons();
}

function removeApp(id) {
  apps = apps.filter((a) => a.id !== id);
  sendMsg('saveApps', apps);
  renderAppList();
  updateButtons();
}

function renderAppList() {
  if (apps.length === 0) {
    el.appList.innerHTML = '<p class="empty-state">Нет добавленных приложений</p>';
    return;
  }

  const platformLabel = {
    rustore: 'RuStore',
    googleplay: 'GP',
    rsya: 'РСЯ',
  };

  el.appList.innerHTML = apps
    .map(
      (a) => `
    <div class="app-item">
      <span class="platform-badge ${a.platform}">${platformLabel[a.platform] || a.platform}</span>
      <span class="app-name" title="${a.name}">${esc(a.name)}</span>
      <span class="app-id">${esc(a.appId)}</span>
      <button class="btn-icon" data-remove="${a.id}" title="Удалить">&times;</button>
    </div>`
    )
    .join('');

  el.appList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeApp(btn.dataset.remove));
  });
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
      dailyData = await sendMsg('getDailyData') || {};
      showStatus('done', `Данные ${result.data?.platform || ''} собраны`);
      renderDataSummary();
      updateButtons();
    } else {
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
        dailyData = await sendMsg('getDailyData') || {};
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
      showStatus(
        'collecting',
        `${status.current}/${status.total} — ${status.appName}...`
      );
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

  // Собрать все даты
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

  // Показать последние 7 дней
  const recent = sortedDates.slice(-7);
  const fmtDate = (d) => {
    const [, m, day] = d.split('-');
    return `${day}.${m}`;
  };
  const num = (v) =>
    v !== undefined && v !== null ? Number(v).toLocaleString('ru-RU') : '—';

  let html = '';

  // RuStore
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

  // Google Play
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

  // РСЯ
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
        recent, ids, 'revenue', 'rsya', names, fmtDate,
        (v) => (v !== undefined && v !== null ? Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽' : '—')
      );
    }
  }

  el.dataSummary.innerHTML = html;
}

function buildMiniTable(dates, ids, metric, platform, names, fmtDate, num) {
  let h = '<table><thead><tr><th>Дата</th>';
  names.forEach((n) => (h += `<th>${esc(n)}</th>`));
  h += '</tr></thead><tbody>';
  for (const d of dates) {
    h += `<tr><td>${fmtDate(d)}</td>`;
    ids.forEach((id) => {
      const v = dailyData[platform]?.[id]?.[metric]?.[d];
      h += `<td>${num(v)}</td>`;
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
  const msg = data !== undefined ? { action, ...data } : { action };
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      resolve(resp);
    });
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