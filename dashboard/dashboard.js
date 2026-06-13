// dashboard/dashboard.js — Полностраничный дашборд расширения

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════

let allApps = [];
let currentData = null;
let currentBlockType = null;
let selectedGroupId = '';  // "" = все, "ungrouped:ID" = одиночное, иначе groupId
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
  btnManageApps: $('#btn-manage-apps'),
  btnCollect: $('#btn-collect'),
  collectStatus: $('#collect-status'),
  summaryCards: $('#summary-cards'),
  tablesContainer: $('#tables-container'),
  blockTypeSection: $('#block-type-section'),
  blockTypeTables: $('#block-type-tables'),
  promptSection: $('#prompt-section'),
  btnGenPrompt: $('#btn-gen-prompt'),
  btnCopyPrompt: $('#btn-copy-prompt'),
  promptText: $('#prompt-text'),
};

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════

async function init() {
  const today = new Date();
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 13);
  el.fDateFrom.value = fmtInputDate(twoWeeksAgo);
  el.fDateTo.value = fmtInputDate(today);

  el.btnApply.addEventListener('click', applyFilters);
  el.btnCollect.addEventListener('click', collectData);
  el.btnManageApps.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('apps/apps.html') });
  });
  el.btnGenPrompt.addEventListener('click', generatePrompt);
  el.btnCopyPrompt.addEventListener('click', copyPrompt);

  await loadData();
}

function fmtInputDate(d) { return d.toISOString().split('T')[0]; }

// ═══════════════════════════════════════════════════════════
//  App Groups: вычисление групп из списка приложений
// ═══════════════════════════════════════════════════════════

function buildGroups() {
  // Возвращает Map<groupId, { name, apps: [...] }>
  const groups = new Map();
  const ungrouped = [];

  for (const a of allApps) {
    if (a.groupId) {
      if (!groups.has(a.groupId)) {
        groups.set(a.groupId, { name: a.groupId, apps: [] });
      }
      groups.get(a.groupId).apps.push(a);
    } else {
      ungrouped.push(a);
    }
  }

  // Для негруппированных — каждое отдельно
  for (const a of ungrouped) {
    const key = `ungrouped:${a.id}`;
    groups.set(key, { name: a.name, apps: [a], isUngrouped: true });
  }

  return groups;
}

function getLinkedAppIds(groupId) {
  const groups = buildGroups();
  const group = groups.get(groupId);
  if (!group) return [];
  return group.apps.map(a => ({ platform: a.platform, appId: a.appId }));
}

function getGroupApps(groupId) {
  const groups = buildGroups();
  return groups.get(groupId)?.apps || [];
}

// ═══════════════════════════════════════════════════════════
//  Data Loading
// ═══════════════════════════════════════════════════════════

async function loadData() {
  try {
    // Если выбрана группа, передаём все appIds из неё
    let appIds = undefined;
    if (selectedGroupId) {
      appIds = getLinkedAppIds(selectedGroupId);
    }

    const resp = await sendMsg('getDashboardData', {
      appIds: appIds || undefined,
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
    updatePromptVisibility();
  } catch (e) {
    el.tablesContainer.innerHTML = `<p class="empty-state">Ошибка: ${e.message}</p>`;
  }
}

function populateAppSelect() {
  const groups = buildGroups();
  const currentVal = el.fApp.value;
  el.fApp.innerHTML = '<option value="">Все приложения</option>';

  const platformOrder = { rsya: 0, rustore: 1, googleplay: 2 };
  const sorted = [...groups.entries()].sort((a, b) => {
    // Сгруппированные первыми
    if (a[1].isUngrouped && !b[1].isUngrouped) return 1;
    if (!a[1].isUngrouped && b[1].isUngrouped) return -1;
    if (!a[1].isUngrouped && !b[1].isUngrouped) {
      return a[1].name.localeCompare(b[1].name, 'ru');
    }
    // Негруппированные по платформе и имени
    const pa = platformOrder[a[1].apps[0]?.platform] ?? 9;
    const pb = platformOrder[b[1].apps[0]?.platform] ?? 9;
    if (pa !== pb) return pa - pb;
    return a[1].name.localeCompare(b[1].name, 'ru');
  });

  for (const [key, group] of sorted) {
    const opt = document.createElement('option');
    opt.value = key;
    const platforms = [...new Set(group.apps.map(a => a.platform))].map(p => {
      const labels = { rsya: 'РСЯ', rustore: 'RuStore', googleplay: 'GP' };
      return labels[p] || p;
    }).join('+');
    opt.textContent = group.isUngrouped
      ? `[${platforms}] ${group.name}`
      : `[${platforms}] ${group.name}`;
    el.fApp.appendChild(opt);
  }

  if (currentVal) el.fApp.value = currentVal;
}

// ═══════════════════════════════════════════════════════════
//  Filters
// ═══════════════════════════════════════════════════════════

function applyFilters() {
  selectedGroupId = el.fApp.value;
  selectedBtFilter = 'all';
  loadData();
}

function updatePromptVisibility() {
  if (selectedGroupId) {
    el.promptSection.classList.remove('hidden');
  } else {
    el.promptSection.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════
//  Summary Cards
// ═══════════════════════════════════════════════════════════

function renderSummaryCards() {
  const totals = { impressions: 0, clicks: 0, revenue: 0, views: 0, installations: 0 };
  for (const platData of Object.values(currentData)) {
    for (const metrics of Object.values(platData)) {
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
  return `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value">${esc(value)}</div>${sub ? `<div class="sc-sub">${esc(sub)}</div>` : ''}</div>`;
}
function sumMetric(totals, key, dateObj) {
  if (!dateObj || typeof dateObj !== 'object') return;
  for (const v of Object.values(dateObj)) { if (typeof v === 'number') totals[key] += v; }
}

// ═══════════════════════════════════════════════════════════
//  Main Tables
// ═══════════════════════════════════════════════════════════

function renderTables() {
  let html = '';
  if (currentData.rustore && Object.keys(currentData.rustore).length > 0)
    html += renderPlatformSection('rustore', 'RuStore', ['views', 'installations'], ['Просмотры', 'Установки'], [fmtNum, fmtNum]);
  if (currentData.googleplay && Object.keys(currentData.googleplay).length > 0)
    html += renderPlatformSection('googleplay', 'Google Play', ['views', 'installations'], ['Просмотры', 'Установки'], [fmtNum, fmtNum]);
  if (currentData.rsya && Object.keys(currentData.rsya).length > 0)
    html += renderPlatformSection('rsya', 'РСЯ', ['impressions', 'clicks', 'revenue', 'ecpm'], ['Показы', 'Клики', 'Доход (₽)', 'eCPM (₽)'], [fmtNum, fmtNum, fmtMoney, fmtMoney]);
  el.tablesContainer.innerHTML = html || '<p class="empty-state">Нет данных за выбранный период</p>';
}

function renderPlatformSection(platform, title, metrics, metricLabels, formatters) {
  const platData = currentData[platform];
  const appIds = Object.keys(platData);
  const datesSet = new Set();
  for (const appData of Object.values(platData))
    for (const metric of metrics) { const m = appData[metric]; if (m && typeof m === 'object') for (const d of Object.keys(m)) datesSet.add(d); }
  const dates = Array.from(datesSet).sort();
  if (dates.length === 0) return '';

  const badgeClass = platform === 'rsya' ? 'badge-rsya' : platform === 'rustore' ? 'badge-rustore' : 'badge-gp';
  let html = `<div class="platform-section"><h2 class="section-title">${esc(title)} <span class="badge ${badgeClass}">${appIds.length} прилож.</span></h2><div class="table-scroll"><table class="metric-table">`;

  html += '<thead><tr><th>Дата</th>';
  for (const aid of appIds) html += `<th colspan="${metrics.length}" style="text-align:center;font-size:11px">${esc(resolveAppName(platform, aid))}</th>`;
  html += '</tr><tr><th></th>';
  for (const aid of appIds) for (let i = 0; i < metrics.length; i++) html += `<th>${esc(metricLabels[i])}</th>`;
  html += '</tr></thead><tbody>';

  for (const d of dates) {
    html += `<tr><td>${fmtDate(d)}</td>`;
    for (const aid of appIds) for (let i = 0; i < metrics.length; i++) { const v = platData[aid]?.[metrics[i]]?.[d]; html += `<td>${v !== undefined ? formatters[i](v) : '—'}</td>`; }
    html += '</tr>';
  }
  html += '<tr style="font-weight:600;background:#f5f5ff"><td>Итого</td>';
  for (const aid of appIds) for (let i = 0; i < metrics.length; i++) {
    const m = platData[aid]?.[metrics[i]]; let total = 0, hasData = false;
    if (m) for (const d of dates) { if (typeof m[d] === 'number') { total += m[d]; hasData = true; } }
    html += `<td>${hasData ? formatters[i](total) : '—'}</td>`;
  }
  html += '</tr></tbody></table></div></div>';
  return html;
}

// ═══════════════════════════════════════════════════════════
//  Block Type Section
// ═══════════════════════════════════════════════════════════

function renderBlockTypeSection() {
  if (!currentBlockType || Object.keys(currentBlockType).length === 0) { el.blockTypeSection.classList.add('hidden'); return; }
  el.blockTypeSection.classList.remove('hidden');

  const allBt = new Set();
  for (const blocks of Object.values(currentBlockType)) for (const bt of Object.keys(blocks)) allBt.add(bt);
  const btList = [...allBt].sort();

  el.blockTypeSection.querySelector('.block-type-tabs').innerHTML =
    `<button class="bt-tab ${selectedBtFilter === 'all' ? 'active' : ''}" data-bt="all">Все</button>` +
    btList.map(bt => `<button class="bt-tab ${selectedBtFilter === bt ? 'active' : ''}" data-bt="${esc(bt)}">${esc(bt)}</button>`).join('');
  el.blockTypeSection.querySelector('.block-type-tabs').querySelectorAll('.bt-tab').forEach(tab => {
    tab.addEventListener('click', () => { selectedBtFilter = tab.dataset.bt; renderBlockTypeSection(); });
  });

  const filtered = {};
  for (const [app, blocks] of Object.entries(currentBlockType)) {
    filtered[app] = {};
    for (const [bt, metrics] of Object.entries(blocks)) {
      if (selectedBtFilter !== 'all' && bt !== selectedBtFilter) continue;
      filtered[app][bt] = metrics;
    }
    if (Object.keys(filtered[app]).length === 0) delete filtered[app];
  }

  let html = '';
  for (const [appName, blocks] of Object.entries(filtered)) {
    const datesSet = new Set();
    for (const metrics of Object.values(blocks)) if (metrics.clicks) Object.keys(metrics.clicks).forEach(d => datesSet.add(d));
    const dates = Array.from(datesSet).sort();
    if (dates.length === 0) continue;
    const btEntries = Object.entries(blocks).sort((a, b) => a[0].localeCompare(b[0], 'ru'));

    html += `<div class="table-scroll" style="margin-bottom:12px"><table class="metric-table"><thead><tr><th>Дата</th>`;
    for (const [btName] of btEntries) html += `<th colspan="2" style="text-align:center;font-size:11px">${esc(btName)}</th>`;
    html += '</tr><tr><th></th>';
    for (const [,] of btEntries) html += '<th>Клики</th><th>Показы</th>';
    html += '</tr></thead><tbody>';

    for (const d of dates) {
      html += `<tr><td>${fmtDate(d)}</td>`;
      for (const [, metrics] of btEntries) {
        html += `<td>${metrics.clicks?.[d] !== undefined ? fmtNum(metrics.clicks[d]) : '—'}</td>`;
        html += `<td>${metrics.shows?.[d] !== undefined ? fmtNum(metrics.shows[d]) : '—'}</td>`;
      }
      html += '</tr>';
    }

    html += '<tr style="font-weight:600;background:#f5f5ff"><td>Итого</td>';
    for (const [, metrics] of btEntries) {
      let tc = 0, ts = 0, hc = false, hs = false;
      if (metrics.clicks) for (const v of Object.values(metrics.clicks)) { if (typeof v === 'number') { tc += v; hc = true; } }
      if (metrics.shows) for (const v of Object.values(metrics.shows)) { if (typeof v === 'number') { ts += v; hs = true; } }
      html += `<td>${hc ? fmtNum(tc) : '—'}</td><td>${hs ? fmtNum(ts) : '—'}</td>`;
    }
    html += '</tr></tbody></table></div>';
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
      el.collectStatus.className = errors.length ? 'collect-status err' : 'collect-status ok';
      el.collectStatus.textContent = errors.length ? `Ошибки: ${errors.map(e => e.app).join(', ')}` : 'Данные собраны';
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
//  LLM Prompt Generator
// ═══════════════════════════════════════════════════════════

function generatePrompt() {
  if (!selectedGroupId) return;

  const groupApps = getGroupApps(selectedGroupId);
  // Имя группы или первого приложения
  const groupName = groupApps.find(a => a.groupId)?.groupId || groupApps[0]?.name || 'Приложение';

  // Собираем все даты из текущих данных
  const allDates = new Set();
  for (const platData of Object.values(currentData))
    for (const metrics of Object.values(platData))
      for (const dateVals of Object.values(metrics))
        if (dateVals && typeof dateVals === 'object') Object.keys(dateVals).forEach(d => allDates.add(d));
  const dates = Array.from(allDates).sort();

  let prompt = `Вот данные моего приложения:\n\n## ${groupName}\n`;

  // Собираем метаданные из первого приложения группы
  let rustoreUrl = '';
  let googlePlayUrl = '';
  let repoUrl = '';
  for (const app of groupApps) {
    if (app.rustoreUrl) rustoreUrl = app.rustoreUrl;
    if (app.googlePlayUrl) googlePlayUrl = app.googlePlayUrl;
    if (app.repoUrl) repoUrl = app.repoUrl;
  }

  // ── РСЯ: общие показатели ──
  const rsyaApp = groupApps.find(a => a.platform === 'rsya');
  const rsyaAppId = rsyaApp?.appId;
  if (rsyaAppId && currentData.rsya?.[rsyaAppId]) {
    const m = currentData.rsya[rsyaAppId];
    prompt += `\n### РСЯ — Общие показатели\n`;
    prompt += '| Дата | Показы | Клики | Доход (₽) | eCPM (₽) |\n';
    prompt += '|------|--------|-------|-----------|----------|\n';
    for (const d of dates) {
      const imp = m.impressions?.[d]; const clicks = m.clicks?.[d];
      const rev = m.revenue?.[d]; const ecpm = m.ecpm?.[d];
      prompt += `| ${fmtDate(d)} | ${imp ?? '—'} | ${clicks ?? '—'} | ${rev !== undefined ? rev.toFixed(2) : '—'} | ${ecpm !== undefined ? ecpm.toFixed(2) : '—'} |\n`;
    }
  }

  // ── РСЯ: клики по типам блоков ──
  if (currentBlockType && rsyaAppId && currentBlockType[rsyaAppId]) {
    const blocks = currentBlockType[rsyaAppId];
    const btEntries = Object.entries(blocks).sort((a, b) => a[0].localeCompare(b[0], 'ru'));

    // Собираем даты блоков
    const btDatesSet = new Set();
    for (const [, metrics] of btEntries)
      if (metrics.clicks) Object.keys(metrics.clicks).forEach(d => btDatesSet.add(d));
    const btDates = Array.from(btDatesSet).sort();

    if (btDates.length > 0) {
      const btNames = btEntries.map(([n]) => n);

      prompt += `\n### РСЯ — Клики по типам блоков\n`;
      prompt += '| Дата | ' + btNames.map(n => `${n} (клики)`).join(' | ') + ' |\n';
      prompt += '|' + '------|'.repeat(btNames.length + 1) + '\n';
      for (const d of btDates) {
        prompt += `| ${fmtDate(d)} | ` + btEntries.map(([, metrics]) => metrics.clicks?.[d] ?? '—').join(' | ') + ' |\n';
      }

      prompt += `\n### РСЯ — Показы по типам блоков\n`;
      prompt += '| Дата | ' + btNames.map(n => `${n} (показы)`).join(' | ') + ' |\n';
      prompt += '|' + '------|'.repeat(btNames.length + 1) + '\n';
      for (const d of btDates) {
        prompt += `| ${fmtDate(d)} | ` + btEntries.map(([, metrics]) => metrics.shows?.[d] ?? '—').join(' | ') + ' |\n';
      }
    }
  }

  // ── RuStore ──
  const rsApp = groupApps.find(a => a.platform === 'rustore');
  if (rsApp && currentData.rustore?.[rsApp.appId]) {
    const m = currentData.rustore[rsApp.appId];
    // Используем имя как в RuStore (может отличаться от groupId)
    const sectionName = rsApp.name !== groupName ? rsApp.name : 'RuStore';
    prompt += `\n## ${sectionName}\n\n### RuStore\n`;
    prompt += '| Дата | Просмотры | Установки |\n';
    prompt += '|------|-----------|------------|\n';
    for (const d of dates) {
      prompt += `| ${fmtDate(d)} | ${m.views?.[d] ?? '—'} | ${m.installations?.[d] ?? '—'} |\n`;
    }
    if (rsApp.rustoreUrl) prompt += `\nСтраница приложения в RuStore - ${rsApp.rustoreUrl}\n`;
  }

  // ── Google Play ──
  const gpApp = groupApps.find(a => a.platform === 'googleplay');
  if (gpApp && currentData.googleplay?.[gpApp.appId]) {
    const m = currentData.googleplay[gpApp.appId];
    const sectionName = gpApp.name !== groupName ? gpApp.name : 'Google Play';
    prompt += `\n## ${sectionName}\n\n### Google Play\n`;
    prompt += '| Дата | Просмотры | Установки |\n';
    prompt += '|------|-----------|------------|\n';
    for (const d of dates) {
      prompt += `| ${fmtDate(d)} | ${m.views?.[d] ?? '—'} | ${m.installations?.[d] ?? '—'} |\n`;
    }
    if (gpApp.googlePlayUrl) prompt += `\nСтраница приложения в Google Play - ${gpApp.googlePlayUrl}\n`;
  }

  // ── Ссылки и завершение ──
  const links = [];
  if (rsApp?.rustoreUrl) links.push(`Страница приложения в Rustore - ${rsApp.rustoreUrl}`);
  if (gpApp?.googlePlayUrl) links.push(`Страница приложения в Google Play - ${gpApp.googlePlayUrl}`);
  if (repoUrl) links.push(`Код приложения - ${repoUrl}`);
  if (links.length > 0 && !rsApp?.rustoreUrl && !gpApp?.googlePlayUrl) {
    // Если ссылки ещё не были добавлены в секции RuStore/GP
    prompt += '\n' + links.join('\n') + '\n';
  }

  prompt += '\nКак можно оптимизировать его по доходности?';

  el.promptText.value = prompt;
  el.btnCopyPrompt.disabled = false;
}

async function copyPrompt() {
  const text = el.promptText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Промпт скопирован', 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Промпт скопирован', 'success');
  }
}

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

function sendMsg(action, data) {
  const msg = data !== undefined ? { action, data } : { action };
  return new Promise((resolve) => { chrome.runtime.sendMessage(msg, (resp) => resolve(resp)); });
}

function fmtDate(d) { const [, m, day] = d.split('-'); return `${day}.${m}`; }
function fmtNum(v) {
  if (v === undefined || v === null) return '—';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? v.toLocaleString('ru-RU') : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}
function fmtMoney(v) {
  if (v === undefined || v === null) return '—';
  return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

function resolveAppName(platform, appId) {
  const a = allApps.find(a => a.platform === platform && (a.appId === appId || a.url?.includes(appId)));
  return a ? a.name : appId;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}