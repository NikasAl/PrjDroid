// dashboard/dashboard.js — Полностраничный дашборд расширения

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════

let allApps = [];
let currentData = null;       // отфильтрованные dailyData
let currentBlockType = null;  // отфильтрованные byBlockType
let selectedApp = '';
let selectedBtFilter = 'all';

// ═══════════════════════════════════════════════════════════
//  Elements
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const el = {
  fApp: $('#f-app'),
  fDateFrom: $('#f-date-from'),
  fDateTo: $('#f-date-to'),
  btnApply: $('#btn-apply'),
  btnCollect: $('#btn-collect'),
  btnCopyApp: $('#btn-copy-app'),
  collectStatus: $('#collect-status'),
  summaryCards: $('#summary-cards'),
  tablesContainer: $('#tables-container'),
  blockTypeSection: $('#block-type-section'),
  blockTypeTables: $('#block-type-tables'),
};

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════

async function init() {
  // Устанавливаем даты по умолчанию: последние 14 дней
  const today = new Date();
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 13);
  el.fDateFrom.value = fmtInputDate(twoWeeksAgo);
  el.fDateTo.value = fmtInputDate(today);

  el.btnApply.addEventListener('click', applyFilters);
  el.btnCollect.addEventListener('click', collectData);
  el.btnCopyApp.addEventListener('click', copyAppData);

  await loadData();
}

function fmtInputDate(d) {
  return d.toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════════════
//  Data Loading
// ═══════════════════════════════════════════════════════════

async function loadData() {
  try {
    const resp = await sendMsg('getDashboardData', {
      platform: selectedApp ? undefined : undefined,
      appId: selectedApp || undefined,
      dateFrom: el.fDateFrom.value || undefined,
      dateTo: el.fDateTo.value || undefined,
      includeBlockType: true,
    });

    allApps = resp.apps || [];
    currentData = resp.dailyData || {};
    currentBlockType = resp.byBlockType || null;

    populateAppSelect();
    renderSummaryCards();
    renderTables();
    renderBlockTypeSection();
    updateCopyButton();
  } catch (e) {
    el.tablesContainer.innerHTML = `<p class="empty-state">Ошибка: ${e.message}</p>`;
  }
}

function populateAppSelect() {
  // Собираем уникальные приложения из данных и из списка
  const appMap = new Map();

  for (const a of allApps) {
    const key = `${a.platform}:${a.appId}`;
    if (!appMap.has(key)) {
      appMap.set(key, { platform: a.platform, appId: a.appId, name: a.name });
    }
  }

  // Добавляем appId из данных, которых может не быть в списке приложений
  for (const [platform, platData] of Object.entries(currentData)) {
    for (const appId of Object.keys(platData)) {
      const key = `${platform}:${appId}`;
      if (!appMap.has(key)) {
        appMap.set(key, { platform, appId, name: appId });
      }
    }
  }

  const currentVal = el.fApp.value;
  el.fApp.innerHTML = '<option value="">Все приложения</option>';

  const platformOrder = { rsya: 0, rustore: 1, googleplay: 2 };
  const sorted = [...appMap.values()].sort((a, b) => {
    const pa = platformOrder[a.platform] ?? 9;
    const pb = platformOrder[b.platform] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, 'ru');
  });

  const platformLabel = { rsya: 'РСЯ', rustore: 'RuStore', googleplay: 'GP' };

  for (const app of sorted) {
    const opt = document.createElement('option');
    opt.value = app.appId;
    opt.textContent = `[${platformLabel[app.platform] || app.platform}] ${app.name}`;
    opt.dataset.platform = app.platform;
    el.fApp.appendChild(opt);
  }

  // Восстанавливаем выбор
  if (currentVal) el.fApp.value = currentVal;
}

// ═══════════════════════════════════════════════════════════
//  Filters
// ═══════════════════════════════════════════════════════════

function applyFilters() {
  selectedApp = el.fApp.value;
  selectedBtFilter = 'all';
  loadData();
}

// ═══════════════════════════════════════════════════════════
//  Summary Cards
// ═══════════════════════════════════════════════════════════

function renderSummaryCards() {
  const totals = { impressions: 0, clicks: 0, revenue: 0, views: 0, installations: 0 };

  for (const [platform, platData] of Object.entries(currentData)) {
    for (const [appId, metrics] of Object.entries(platData)) {
      sumMetric(totals, 'impressions', metrics.impressions);
      sumMetric(totals, 'clicks', metrics.clicks);
      sumMetric(totals, 'revenue', metrics.revenue);
      sumMetric(totals, 'views', metrics.views);
      sumMetric(totals, 'installations', metrics.installations);
    }
  }

  const hasRsya = totals.impressions > 0 || totals.revenue > 0;
  const hasStores = totals.views > 0 || totals.installations > 0;

  let html = '';
  if (hasRsya) {
    const ecpm = totals.impressions > 0 ? (totals.revenue / totals.impressions * 1000) : 0;
    const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0;
    html += summaryCard('Показы РСЯ', fmtNum(totals.impressions));
    html += summaryCard('Клики РСЯ', fmtNum(totals.clicks), `CTR ${ctr.toFixed(2)}%`);
    html += summaryCard('Доход РСЯ', fmtMoney(totals.revenue));
    html += summaryCard('eCPM РСЯ', fmtMoney(ecpm));
  }
  if (hasStores) {
    html += summaryCard('Просмотры', fmtNum(totals.views));
    html += summaryCard('Установки', fmtNum(totals.installations));
  }

  el.summaryCards.innerHTML = html || '<p class="empty-state">Нет данных за выбранный период</p>';
}

function summaryCard(label, value, sub) {
  return `<div class="summary-card">
    <div class="sc-label">${esc(label)}</div>
    <div class="sc-value">${esc(value)}</div>
    ${sub ? `<div class="sc-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function sumMetric(totals, key, dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return;
  for (const v of Object.values(dateObj)) {
    if (typeof v === 'number') totals[key] += v;
  }
}

// ═══════════════════════════════════════════════════════════
//  Main Tables
// ═══════════════════════════════════════════════════════════

function renderTables() {
  let html = '';

  // RuStore
  if (currentData.rustore && Object.keys(currentData.rustore).length > 0) {
    html += renderPlatformSection('rustore', 'RuStore', ['views', 'installations'],
      ['Просмотры', 'Установки'], [fmtNum, fmtNum]);
  }

  // Google Play
  if (currentData.googleplay && Object.keys(currentData.googleplay).length > 0) {
    html += renderPlatformSection('googleplay', 'Google Play', ['views', 'installations'],
      ['Просмотры', 'Установки'], [fmtNum, fmtNum]);
  }

  // РСЯ
  if (currentData.rsya && Object.keys(currentData.rsya).length > 0) {
    html += renderPlatformSection('rsya', 'РСЯ',
      ['impressions', 'clicks', 'revenue', 'ecpm'],
      ['Показы', 'Клики', 'Доход (₽)', 'eCPM (₽)'],
      [fmtNum, fmtNum, fmtMoney, fmtMoney]);
  }

  el.tablesContainer.innerHTML = html || '<p class="empty-state">Нет данных за выбранный период</p>';
}

function renderPlatformSection(platform, title, metrics, metricLabels, formatters) {
  const platData = currentData[platform];
  const appIds = Object.keys(platData);

  // Собираем даты
  const datesSet = new Set();
  for (const appData of Object.values(platData)) {
    for (const metric of metrics) {
      const m = appData[metric];
      if (m && typeof m === 'object') {
        for (const d of Object.keys(m)) datesSet.add(d);
      }
    }
  }
  const dates = Array.from(datesSet).sort();

  if (dates.length === 0) return '';

  const badgeClass = platform === 'rsya' ? 'badge-rsya' : platform === 'rustore' ? 'badge-rustore' : 'badge-gp';

  let html = `<div class="platform-section">
    <h2 class="section-title">${esc(title)} <span class="badge ${badgeClass}">${appIds.length} прилож.</span></h2>
    <div class="table-scroll"><table class="metric-table">`;

  // Header row
  html += '<thead><tr><th>Дата</th>';
  for (const aid of appIds) {
    html += `<th colspan="${metrics.length}" style="text-align:center;font-size:11px">${esc(resolveAppName(platform, aid))}</th>`;
  }
  html += '</tr><tr><th></th>';
  for (const aid of appIds) {
    for (let i = 0; i < metrics.length; i++) {
      html += `<th>${esc(metricLabels[i])}</th>`;
    }
  }
  html += '</tr></thead><tbody>';

  // Data rows
  for (const d of dates) {
    html += `<tr><td>${fmtDate(d)}</td>`;
    for (const aid of appIds) {
      for (let i = 0; i < metrics.length; i++) {
        const v = platData[aid]?.[metrics[i]]?.[d];
        html += `<td>${v !== undefined ? formatters[i](v) : '—'}</td>`;
      }
    }
    html += '</tr>';
  }

  // Totals row
  html += '<tr style="font-weight:600;background:#f5f5ff"><td>Итого</td>';
  for (const aid of appIds) {
    for (let i = 0; i < metrics.length; i++) {
      const m = platData[aid]?.[metrics[i]];
      let total = 0;
      let hasData = false;
      if (m) {
        for (const d of dates) {
          if (typeof m[d] === 'number') { total += m[d]; hasData = true; }
        }
      }
      html += `<td>${hasData ? formatters[i](total) : '—'}</td>`;
    }
  }
  html += '</tr>';

  html += '</tbody></table></div></div>';
  return html;
}

// ═══════════════════════════════════════════════════════════
//  Block Type Section (РСЯ)
// ═══════════════════════════════════════════════════════════

function renderBlockTypeSection() {
  if (!currentBlockType || Object.keys(currentBlockType).length === 0) {
    el.blockTypeSection.classList.add('hidden');
    return;
  }

  el.blockTypeSection.classList.remove('hidden');

  // Собираем все типы блоков
  const allBt = new Set();
  for (const blocks of Object.values(currentBlockType)) {
    for (const bt of Object.keys(blocks)) allBt.add(bt);
  }
  const btList = [...allBt].sort();

  // Рендерим табы
  const tabsHtml = `<button class="bt-tab ${selectedBtFilter === 'all' ? 'active' : ''}" data-bt="all">Все</button>` +
    btList.map(bt => `<button class="bt-tab ${selectedBtFilter === bt ? 'active' : ''}" data-bt="${esc(bt)}">${esc(bt)}</button>`).join('');

  el.blockTypeSection.querySelector('.block-type-tabs').innerHTML = tabsHtml;
  el.blockTypeSection.querySelector('.block-type-tabs').querySelectorAll('.bt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      selectedBtFilter = tab.dataset.bt;
      renderBlockTypeSection();
    });
  });

  // Фильтруем по выбранному типу
  const filtered = {};
  for (const [app, blocks] of Object.entries(currentBlockType)) {
    filtered[app] = {};
    for (const [bt, metrics] of Object.entries(blocks)) {
      if (selectedBtFilter !== 'all' && bt !== selectedBtFilter) continue;
      filtered[app][bt] = metrics;
    }
    if (Object.keys(filtered[app]).length === 0) delete filtered[app];
  }

  // Рендерим таблицу кликов по типам блоков
  let html = '';
  for (const [appName, blocks] of Object.entries(filtered)) {
    // Собираем даты
    const datesSet = new Set();
    for (const metrics of Object.values(blocks)) {
      if (metrics.clicks) Object.keys(metrics.clicks).forEach(d => datesSet.add(d));
    }
    const dates = Array.from(datesSet).sort();

    if (dates.length === 0) continue;

    const btEntries = Object.entries(blocks).sort((a, b) => a[0].localeCompare(b[0], 'ru'));

    html += `<div class="table-scroll" style="margin-bottom:12px"><table class="metric-table">
      <thead><tr>
        <th>Дата</th>`;

    // Для каждого типа блока — клики и показы
    for (const [btName] of btEntries) {
      html += `<th colspan="2" style="text-align:center;font-size:11px">${esc(btName)}</th>`;
    }
    html += '</tr><tr><th></th>';
    for (const [btName] of btEntries) {
      html += `<th>Клики</th><th>Показы</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const d of dates) {
      html += `<tr><td>${fmtDate(d)}</td>`;
      for (const [, metrics] of btEntries) {
        const clicks = metrics.clicks?.[d];
        const shows = metrics.shows?.[d];
        html += `<td>${clicks !== undefined ? fmtNum(clicks) : '—'}</td>`;
        html += `<td>${shows !== undefined ? fmtNum(shows) : '—'}</td>`;
      }
      html += '</tr>';
    }

    // Итого
    html += '<tr style="font-weight:600;background:#f5f5ff"><td>Итого</td>';
    for (const [, metrics] of btEntries) {
      let tc = 0, ts = 0, hc = false, hs = false;
      if (metrics.clicks) for (const v of Object.values(metrics.clicks)) { if (typeof v === 'number') { tc += v; hc = true; } }
      if (metrics.shows) for (const v of Object.values(metrics.shows)) { if (typeof v === 'number') { ts += v; hs = true; } }
      html += `<td>${hc ? fmtNum(tc) : '—'}</td>`;
      html += `<td>${hs ? fmtNum(ts) : '—'}</td>`;
    }
    html += '</tr>';

    html += '</tbody></table></div>';
  }

  el.blockTypeTables.innerHTML = html || '<p class="empty-state">Нет данных по типам блоков</p>';
}

// ═══════════════════════════════════════════════════════════
//  Collect
// ═══════════════════════════════════════════════════════════

async function collectData() {
  el.btnCollect.disabled = true;
  el.collectStatus.className = 'collect-status loading';
  el.collectStatus.textContent = 'Сбор данных...';

  try {
    const result = await sendMsg('collectAll');
    if (result.success) {
      const errors = result.results.filter(r => !r.success);
      if (errors.length > 0) {
        el.collectStatus.className = 'collect-status err';
        el.collectStatus.textContent = `Готово с ошибками: ${errors.map(e => e.app).join(', ')}`;
      } else {
        el.collectStatus.className = 'collect-status ok';
        el.collectStatus.textContent = 'Данные собраны успешно';
      }
      await loadData();
    } else {
      el.collectStatus.className = 'collect-status err';
      el.collectStatus.textContent = result.error || 'Ошибка';
    }
  } catch (e) {
    el.collectStatus.className = 'collect-status err';
    el.collectStatus.textContent = e.message;
  } finally {
    el.btnCollect.disabled = false;
    setTimeout(() => { el.collectStatus.textContent = ''; }, 5000);
  }
}

// ═══════════════════════════════════════════════════════════
//  Copy
// ═══════════════════════════════════════════════════════════

function updateCopyButton() {
  el.btnCopyApp.disabled = !selectedApp;
}

async function copyAppData() {
  if (!selectedApp) return;

  // Формируем текст для копирования
  const appData = currentData;
  const blockData = currentBlockType;
  const appName = resolveAppNameForCopy(selectedApp);
  let text = `## ${appName}\n`;

  // Собираем даты
  const datesSet = new Set();
  for (const platData of Object.values(appData)) {
    for (const metrics of Object.values(platData)) {
      for (const dateVals of Object.values(metrics)) {
        if (dateVals && typeof dateVals === 'object') {
          Object.keys(dateVals).forEach(d => datesSet.add(d));
        }
      }
    }
  }
  const dates = Array.from(datesSet).sort();

  // РСЯ таблицы
  if (appData.rsya && appData.rsya[selectedApp]) {
    const m = appData.rsya[selectedApp];
    text += '\n### РСЯ — Общие показатели\n';
    text += '| Дата | Показы | Клики | Доход (₽) | eCPM (₽) |\n';
    text += '|------|--------|-------|-----------|----------|\n';
    for (const d of dates) {
      const imp = m.impressions?.[d];
      const clicks = m.clicks?.[d];
      const rev = m.revenue?.[d];
      const ecpm = m.ecpm?.[d];
      text += `| ${fmtDate(d)} | ${imp ?? '—'} | ${clicks ?? '—'} | ${rev !== undefined ? rev.toFixed(2) : '—'} | ${ecpm !== undefined ? ecpm.toFixed(2) : '—'} |\n`;
    }
  }

  // Блок-типы
  if (blockData && blockData[selectedApp]) {
    const blocks = blockData[selectedApp];
    const btEntries = Object.entries(blocks).sort((a, b) => a[0].localeCompare(b[0], 'ru'));

    text += '\n### РСЯ — Клики по типам блоков\n';
    const btNames = btEntries.map(([n]) => n);
    text += '| Дата | ' + btNames.map(n => `${n} (клики)`).join(' | ') + ' |\n';
    text += '|' + '------|'.repeat(btNames.length + 1) + '\n';

    // Собираем даты для блоков
    const btDatesSet = new Set();
    for (const [, metrics] of btEntries) {
      if (metrics.clicks) Object.keys(metrics.clicks).forEach(d => btDatesSet.add(d));
    }
    const btDates = Array.from(btDatesSet).sort();

    for (const d of btDates) {
      text += `| ${fmtDate(d)} | `;
      text += btEntries.map(([, metrics]) => metrics.clicks?.[d] ?? '—').join(' | ');
      text += ' |\n';
    }

    // Показы по типам блоков
    text += '\n### РСЯ — Показы по типам блоков\n';
    text += '| Дата | ' + btNames.map(n => `${n} (показы)`).join(' | ') + ' |\n';
    text += '|' + '------|'.repeat(btNames.length + 1) + '\n';
    for (const d of btDates) {
      text += `| ${fmtDate(d)} | `;
      text += btEntries.map(([, metrics]) => metrics.shows?.[d] ?? '—').join(' | ');
      text += ' |\n';
    }
  }

  // RuStore
  if (appData.rustore && appData.rustore[selectedApp]) {
    const m = appData.rustore[selectedApp];
    text += '\n### RuStore\n';
    text += '| Дата | Просмотры | Установки |\n';
    text += '|------|-----------|------------|\n';
    for (const d of dates) {
      text += `| ${fmtDate(d)} | ${m.views?.[d] ?? '—'} | ${m.installations?.[d] ?? '—'} |\n`;
    }
  }

  // Google Play
  if (appData.googleplay && appData.googleplay[selectedApp]) {
    const m = appData.googleplay[selectedApp];
    text += '\n### Google Play\n';
    text += '| Дата | Просмотры | Установки |\n';
    text += '|------|-----------|------------|\n';
    for (const d of dates) {
      text += `| ${fmtDate(d)} | ${m.views?.[d] ?? '—'} | ${m.installations?.[d] ?? '—'} |\n`;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('Данные скопированы в буфер обмена', 'success');
  } catch (e) {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Данные скопированы', 'success');
  }
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

function fmtDate(d) {
  const [, m, day] = d.split('-');
  return `${day}.${m}`;
}

function fmtNum(v) {
  if (v === undefined || v === null) return '—';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? v.toLocaleString('ru-RU') : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function fmtMoney(v) {
  if (v === undefined || v === null) return '—';
  return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function resolveAppName(platform, appId) {
  const a = allApps.find(a => a.platform === platform && (a.appId === appId || a.url?.includes(appId)));
  return a ? a.name : appId;
}

function resolveAppNameForCopy(appId) {
  for (const a of allApps) {
    if (a.appId === appId) return a.name;
  }
  return appId;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}