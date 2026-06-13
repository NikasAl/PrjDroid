// apps/apps.js — Управление приложениями (отдельная страница расширения)

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════

let apps = [];
let editingAppId = null;

// ═══════════════════════════════════════════════════════════
//  Elements
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);

const el = {
  editPanel: $('#edit-panel'),
  editTitle: $('#edit-title'),
  fName: $('#f-name'),
  fPlatform: $('#f-platform'),
  fAppId: $('#f-appid'),
  fUrl: $('#f-url'),
  fGroupId: $('#f-group-id'),
  fRustoreUrl: $('#f-rustore-url'),
  fGpUrl: $('#f-gp-url'),
  fRepoUrl: $('#f-repo-url'),
  groupList: $('#group-list'),
  btnAdd: $('#btn-add'),
  btnCancelEdit: $('#btn-cancel-edit'),
  btnSaveEdit: $('#btn-save-edit'),
  btnScanRuStore: $('#btn-scan-rustore'),
  btnAutoLink: $('#btn-auto-link'),
  linkResult: $('#link-result'),
  appsTable: $('#apps-table'),
  emptyState: $('#empty-state'),
  statsRow: $('#stats-row'),
};

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════

async function init() {
  apps = await sendMsg('getApps') || [];
  renderTable();
  renderStats();
  bindEvents();
}

function bindEvents() {
  el.btnAdd.addEventListener('click', () => openEditForm());
  el.btnCancelEdit.addEventListener('click', closeEditForm);
  el.btnSaveEdit.addEventListener('click', saveEdit);
  el.btnScanRuStore.addEventListener('click', scanRuStore);
  el.btnAutoLink.addEventListener('click', autoLink);
  el.fPlatform.addEventListener('change', autofillUrl);
  el.fAppId.addEventListener('input', autofillUrl);
}

// ═══════════════════════════════════════════════════════════
//  Form: open / close / save
// ═══════════════════════════════════════════════════════════

function openEditForm(appId) {
  editingAppId = appId || null;
  populateGroupDatalist();

  if (editingAppId) {
    const app = apps.find((a) => a.id === editingAppId);
    if (!app) return;
    el.fName.value = app.name || '';
    el.fPlatform.value = app.platform || 'rustore';
    el.fAppId.value = app.appId || '';
    el.fUrl.value = app.url || '';
    el.fGroupId.value = app.groupId || '';
    el.fRustoreUrl.value = app.rustoreUrl || '';
    el.fGpUrl.value = app.googlePlayUrl || '';
    el.fRepoUrl.value = app.repoUrl || '';
    el.editTitle.textContent = 'Редактировать: ' + app.name;
    el.btnSaveEdit.textContent = 'Обновить';
  } else {
    clearForm();
    el.editTitle.textContent = 'Добавить приложение';
    el.btnSaveEdit.textContent = 'Сохранить';
  }

  el.editPanel.classList.remove('hidden');
  el.editPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.fName.focus();
}

function closeEditForm() {
  el.editPanel.classList.add('hidden');
  editingAppId = null;
}

function clearForm() {
  el.fName.value = '';
  el.fPlatform.value = 'rustore';
  el.fAppId.value = '';
  el.fUrl.value = '';
  el.fGroupId.value = '';
  el.fRustoreUrl.value = '';
  el.fGpUrl.value = '';
  el.fRepoUrl.value = '';
}

function populateGroupDatalist() {
  const groups = new Set();
  for (const a of apps) {
    if (a.groupId) groups.add(a.groupId);
  }
  el.groupList.innerHTML = [...groups]
    .map((g) => `<option value="${esc(g)}">`)
    .join('');
}

function autofillUrl() {
  const platform = el.fPlatform.value;
  const appId = el.fAppId.value.trim();
  if (!appId) return;
  if (platform === 'rustore' && !el.fUrl.value) {
    el.fUrl.value = `https://console.rustore.ru/apps/${appId}/statistics`;
  }
}

async function saveEdit() {
  const name = el.fName.value.trim();
  const platform = el.fPlatform.value;
  const appId = el.fAppId.value.trim();
  let url = el.fUrl.value.trim();
  const groupId = el.fGroupId.value.trim();
  const rustoreUrl = el.fRustoreUrl.value.trim();
  const googlePlayUrl = el.fGpUrl.value.trim();
  const repoUrl = el.fRepoUrl.value.trim();

  if (!name) return alert('Введите название приложения');
  if (!appId) return alert('Введите App ID');

  if (!url) {
    if (platform === 'rustore') {
      url = `https://console.rustore.ru/apps/${appId}/statistics`;
    } else if (platform === 'rsya') {
      url = '';
    } else {
      return alert('Введите URL статистики');
    }
  }

  if (editingAppId) {
    const idx = apps.findIndex((a) => a.id === editingAppId);
    if (idx >= 0) {
      apps[idx] = {
        ...apps[idx],
        name,
        platform,
        appId,
        url,
        groupId,
        rustoreUrl,
        googlePlayUrl,
        repoUrl,
      };
    }
  } else {
    apps.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      name,
      platform,
      appId,
      url,
      groupId,
      rustoreUrl,
      googlePlayUrl,
      repoUrl,
    });
  }

  await sendMsg('saveApps', { apps });
  closeEditForm();
  renderTable();
  renderStats();
  showToast(editingAppId ? 'Приложение обновлено' : 'Приложение добавлено', 'success');
}

// ═══════════════════════════════════════════════════════════
//  Delete / Unlink
// ═══════════════════════════════════════════════════════════

function deleteApp(id) {
  const app = apps.find((a) => a.id === id);
  if (!app) return;
  if (!confirm(`Удалить "${app.name}" (${app.platform})?`)) return;
  apps = apps.filter((a) => a.id !== id);
  sendMsg('saveApps', { apps });
  renderTable();
  renderStats();
  showToast('Приложение удалено', 'success');
}

function unlinkApp(id) {
  const idx = apps.findIndex((a) => a.id === id);
  if (idx >= 0) {
    const oldGroup = apps[idx].groupId;
    apps[idx].groupId = '';
    sendMsg('saveApps', { apps });
    renderTable();
    renderStats();
    showToast(`Отвязано от группы "${oldGroup}"`, 'success');
  }
}

// ═══════════════════════════════════════════════════════════
//  Render table
// ═══════════════════════════════════════════════════════════

function renderTable() {
  const tbody = el.appsTable.querySelector('tbody');

  if (apps.length === 0) {
    el.emptyState.classList.remove('hidden');
    tbody.innerHTML = '';
    return;
  }

  el.emptyState.classList.add('hidden');

  const platformLabel = { rustore: 'RuStore', googleplay: 'Google Play', rsya: 'РСЯ' };
  const platformBadgeClass = {
    rustore: 'badge-rustore',
    googleplay: 'badge-googleplay',
    rsya: 'badge-rsya',
  };

  // Sort: grouped first (by group name), then ungrouped by platform then name
  const sorted = [...apps].sort((a, b) => {
    if (a.groupId && !b.groupId) return -1;
    if (!a.groupId && b.groupId) return 1;
    if (a.groupId && b.groupId) {
      if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId, 'ru');
      // Within same group, by platform order
      const po = { rsya: 0, rustore: 1, googleplay: 2 };
      if (po[a.platform] !== po[b.platform]) return po[a.platform] - po[b.platform];
    }
    const po = { rsya: 0, rustore: 1, googleplay: 2 };
    if (po[a.platform] !== po[b.platform]) return po[a.platform] - po[b.platform];
    return a.name.localeCompare(b.name, 'ru');
  });

  let html = '';
  let lastGroup = null;

  for (const a of sorted) {
    // Visual separator between groups
    if (a.groupId && a.groupId !== lastGroup) {
      if (lastGroup !== null) {
        html += `<tr class="group-separator"><td colspan="5"></td></tr>`;
      }
      lastGroup = a.groupId;
    } else if (!a.groupId && lastGroup !== null) {
      html += `<tr class="group-separator"><td colspan="5"></td></tr>`;
      lastGroup = null;
    }

    const groupCell = a.groupId
      ? `<span class="group-badge">
           <span class="group-text" title="${esc(a.groupId)}">${esc(a.groupId)}</span>
           <button class="unlink-btn" data-unlink="${a.id}" title="Отвязать от группы">&times;</button>
         </span>`
      : '<span class="no-group">—</span>';

    html += `<tr>
      <td><span class="platform-badge ${platformBadgeClass[a.platform] || ''}">${esc(platformLabel[a.platform] || a.platform)}</span></td>
      <td class="app-name-cell"><span class="app-name-text" title="${esc(a.name)}">${esc(a.name)}</span></td>
      <td class="app-id" title="${esc(a.appId)}">${esc(a.appId)}</td>
      <td>${groupCell}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" data-edit="${a.id}">Ред.</button>
        <button class="btn btn-sm btn-danger" data-delete="${a.id}">Удалить</button>
      </td>
    </tr>`;
  }

  tbody.innerHTML = html;

  // Bind events
  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditForm(btn.dataset.edit));
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteApp(btn.dataset.delete));
  });
  tbody.querySelectorAll('[data-unlink]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      unlinkApp(btn.dataset.unlink);
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  Stats
// ═══════════════════════════════════════════════════════════

function renderStats() {
  const byPlatform = {};
  for (const a of apps) {
    byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;
  }
  const groups = new Set(apps.filter((a) => a.groupId).map((a) => a.groupId));
  const linkedCount = apps.filter((a) => a.groupId).length;

  const labels = { rsya: 'РСЯ', rustore: 'RuStore', googleplay: 'Google Play' };

  let html = '';
  for (const [plat, count] of Object.entries(byPlatform)) {
    html += `<div class="stat-chip"><strong>${count}</strong>${labels[plat] || plat}</div>`;
  }
  html += `<div class="stat-chip"><strong>${groups.size}</strong>связанных групп</div>`;
  if (linkedCount > 0) {
    html += `<div class="stat-chip"><strong>${linkedCount}</strong>приложений в группах</div>`;
  }

  el.statsRow.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
//  Scan RuStore
// ═══════════════════════════════════════════════════════════

async function scanRuStore() {
  el.btnScanRuStore.disabled = true;
  el.btnScanRuStore.textContent = 'Загрузка...';
  try {
    const result = await sendMsg('scanRuStoreApps');
    if (result.success) {
      apps = result.apps;
      renderTable();
      renderStats();
      showToast(
        `Найдено ${result.total}, добавлено ${result.added} новых`,
        'success'
      );
    } else {
      showToast(result.error || 'Ошибка сканирования', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    el.btnScanRuStore.disabled = false;
    el.btnScanRuStore.textContent = '🔄 Из RuStore';
  }
}

// ═══════════════════════════════════════════════════════════
//  Auto-link
// ═══════════════════════════════════════════════════════════

async function autoLink() {
  el.btnAutoLink.disabled = true;
  el.btnAutoLink.textContent = 'Анализ...';
  try {
    const result = await sendMsg('autoLinkApps');

    if (result.success) {
      // Reload apps after potential changes
      apps = (await sendMsg('getApps')) || [];
      renderTable();
      renderStats();

      el.linkResult.classList.remove('hidden');

      if (result.groups && result.groups.length > 0) {
        const platformLabels = { rsya: 'РСЯ', rustore: 'RuStore', googleplay: 'GP' };
        const platformBadge = {
          rsya: 'badge-rsya',
          rustore: 'badge-rustore',
          googleplay: 'badge-googleplay',
        };
        el.linkResult.innerHTML =
          `<h4>${esc(result.message)}</h4>` +
          result
            .map(
              (g) =>
                `<div class="group-item">
            <span class="group-name">${esc(g.groupId)}</span> →
            <span class="group-apps">
              ${g.apps
                .map(
                  (a) =>
                    `<span class="platform-badge ${platformBadge[a.platform] || ''}" style="font-size:10px;padding:1px 6px;margin-right:4px">${platformLabels[a.platform] || a.platform}</span>${esc(a.name)}`
                )
                .join(' &nbsp;·&nbsp; ')}
            </span>
          </div>`
            )
            .join('');
      } else {
        el.linkResult.innerHTML = `<p style="color:#666">${esc(result.message)}</p>`;
      }

      showToast(result.message, result.linked > 0 ? 'success' : 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    el.btnAutoLink.disabled = false;
    el.btnAutoLink.textContent = 'Автосвязывание';
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

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}