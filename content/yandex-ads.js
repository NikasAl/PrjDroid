// content/yandex-ads.js — РСЯ: сбор статистики через REST API
// Выполняется на partner.yandex.ru (same-origin → cookies доступны)

if (window.__amhRsyaLoaded) {
  // Уже загружен
} else {
  window.__amhRsyaLoaded = true;

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  API helpers
  // ═══════════════════════════════════════════════════════════

  async function apiFetch(endpoint, params = {}, token) {
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
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const resp = await fetch(url.toString(), { credentials: 'same-origin', headers });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} — ${body.substring(0, 300)}`);
    }

    return resp.json();
  }

  function findFieldId(fields, exactIds = [], keywords = []) {
    if (!fields || !Array.isArray(fields)) return null;
    for (const eid of exactIds) {
      if (fields.find(f => f.id === eid)) return eid;
    }
    if (keywords.length > 0) {
      for (const f of fields) {
        const haystack = ((f.label || '') + ' ' + (f.title || '') + ' ' + (f.id || '')).toLowerCase();
        if (keywords.some(kw => haystack.includes(kw.toLowerCase()))) {
          if (/(?:_own|_direct|rec_)/.test(f.id || '')) continue;
          return f.id;
        }
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Основной сборщик
  // ═══════════════════════════════════════════════════════════

  async function collectRsya(token) {
    const log = [];
    const addLog = (step, detail) => {
      const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
      log.push(entry);
      console.log(`[AMH-RSYA ${step}]`, detail);
    };

    try {
      addLog('start', token ? `Token (${token.length} chars)` : 'No token');

      // ── 1. tree.json ──
      // tree.json может не иметь поля result — проверяем data.tree напрямую
      const treeResp = await apiFetch('tree.json', {}, token);
      const tree = treeResp.data?.tree;
      if (!tree || !Array.isArray(tree) || tree.length === 0) {
        const keys = Object.keys(treeResp);
        const errDetail = treeResp.errors
          ? JSON.stringify(treeResp.errors)
          : `keys=[${keys.join(',')}]`;
        throw new Error(`tree.json не вернул дерево: ${errDetail}`);
      }

      const node = tree[0];
      const ef = node.entity_fields || [];
      const mf = node.fields || [];
      addLog('tree', `${ef.length} entity fields, ${mf.length} metrics`);

      // ── 2. Ищем нужные поля ──
      const appNameField = findFieldId(ef, ['page_caption'], ['название сайта', 'название приложения']);
      const revenueField = findFieldId(mf, ['partner_wo_nds'], ['вознаграждение', 'доход']);
      const showsField = findFieldId(mf, ['shows'], ['видимые показы']);
      const impressionsField = findFieldId(mf, ['impressions'], ['показы']);
      const clicksField = findFieldId(mf, ['clicks'], ['клик']);

      const showField = showsField || impressionsField;

      addLog('fields', JSON.stringify({
        app: appNameField, rev: revenueField, show: showField, clicks: clicksField,
      }));

      if (!appNameField) throw new Error('Не найдено поле page_caption');
      if (!revenueField && !showField) throw new Error('Не найдены метрики');

      // ── 3. get.json ──
      const entityFields = [appNameField];
      const metricFields = [revenueField, showField, clicksField].filter(Boolean);

      const data = await apiFetch('get.json', {
        dimension_field: 'date|day',
        period: '90days',
        entity_field: entityFields,
        field: metricFields,
      }, token);

      if (data.result === 'error' || data.errors) {
        const errMsg = data.errors
          ? Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ')
          : 'unknown error';
        throw new Error(`get.json: ${errMsg}`);
      }

      const points = data.data?.points || [];
      addLog('got-points', `${points.length} точек`);

      // ── 4. Группируем ──
      const appsMap = {};

      for (const pt of points) {
        const dims = pt.dimensions || {};
        const measures = pt.measures?.[0] || {};
        const dateArr = dims.date;
        if (!dateArr?.[0]) continue;
        const date = dateArr[0];
        const name = String(dims[appNameField] || 'Unknown');

        if (!appsMap[name]) {
          appsMap[name] = { revenue: {}, impressions: {}, clicks: {}, ecpm: {} };
        }
        const app = appsMap[name];

        if (revenueField && typeof measures[revenueField] === 'number') {
          app.revenue[date] = (app.revenue[date] || 0) + measures[revenueField];
        }
        if (showField && typeof measures[showField] === 'number') {
          app.impressions[date] = (app.impressions[date] || 0) + measures[showField];
        }
        if (clicksField && typeof measures[clicksField] === 'number') {
          app.clicks[date] = (app.clicks[date] || 0) + measures[clicksField];
        }
      }

      // eCPM = revenue / impressions * 1000
      for (const app of Object.values(appsMap)) {
        for (const d of Object.keys(app.impressions)) {
          const imp = app.impressions[d];
          const rev = app.revenue[d];
          if (imp > 0 && rev !== undefined) {
            app.ecpm[d] = (rev / imp) * 1000;
          }
        }
      }

      const apps = Object.entries(appsMap).map(([name, m]) => ({
        appId: name,
        name: name,
        platform: 'rsya',
        metrics: { revenue: m.revenue, impressions: m.impressions, clicks: m.clicks, ecpm: m.ecpm },
      }));

      addLog('done', `${apps.length} apps, ${points.length} points`);

      return {
        success: true,
        data: { platform: 'rsya', timestamp: new Date().toISOString(), dateRange: null, apps, _source: 'api', _debugLog: log },
      };
    } catch (e) {
      addLog('error', e.message);
      return { success: false, error: e.message, _debugLog: log, _source: 'api' };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Messages
  // ═══════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.action === 'collectRsyaApi') {
      collectRsya(msg.data?.token || null).then(sendResponse);
      return true;
    }

    if (msg.action === 'testRsyaTree') {
      const headers = { Accept: 'application/json' };
      const token = msg.data?.token;
      if (token) headers['Authorization'] = `OAuth ${token}`;

      fetch('https://partner.yandex.ru/api/statistics2/tree.json?lang=ru', {
        credentials: 'same-origin', headers,
      })
        .then(r => r.text())
        .then(text => {
          try {
            const json = JSON.parse(text);
            const tree = json.data?.tree || [];
            sendResponse({
              success: tree.length > 0,
              treeLength: tree.length,
              treeTitle: tree[0]?.title || '',
              rawPreview: text.substring(0, 1000),
            });
          } catch (_) {
            sendResponse({ success: false, error: 'Not JSON', rawPreview: text.substring(0, 500) });
          }
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (msg.action === 'ping') {
      sendResponse({ alive: true, platform: 'rsya', url: window.location.href });
      return false;
    }
  });

})();

} // end __amhRsyaLoaded guard