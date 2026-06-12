// content/rustore.js — RuStore Statistics Parser

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH ${step}]`, detail);
  }

  const SEL = {
    dateRangeTrigger: '[data-testid="advancedAppStatisticsPage-filterDateRange-textSelectTrigger"]',
    viewsTab: '[data-testid="advancedAppStatisticsPage-views"]',
    installationsTab: '[data-testid="advancedAppStatisticsPage-installations"]',
    chartsContainer: '[data-testid="advancedAppStatisticsPage-charts"]',
  };

  function waitForElement(selector, root, timeoutMs = 12000) {
    const parent = root || document;
    return new Promise((resolve, reject) => {
      const el = parent.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = parent.querySelector(selector);
        if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
      });
      observer.observe(parent.body || parent, { childList: true, subtree: true });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Таймаут: ${selector}`)); }, timeoutMs);
    });
  }

  function waitFor(checkFn, timeoutMs = 10000, intervalMs = 300) {
    return new Promise((resolve, reject) => {
      if (checkFn()) return resolve();
      const timer = setTimeout(() => { clearInterval(poller); reject(new Error('Таймаут waitFor')); }, timeoutMs);
      const poller = setInterval(() => { if (checkFn()) { clearTimeout(timer); clearInterval(poller); resolve(); } }, intervalMs);
    });
  }

  async function waitForStatsPage() {
    try {
      await waitForElement(SEL.chartsContainer, document, 15000);
      await waitFor(() => {
        const c = document.querySelector(`${SEL.chartsContainer} canvas`);
        return c && c.width > 0 && c.height > 0;
      }, 10000);
      await DELAY(500);
    } catch (_) {
      throw new Error('Страница статистики RuStore не загрузилась');
    }
  }

  // Панель по индексу таба. RuStore НЕ использует aria-controls/id.
  function panelAt(idx) {
    return document.querySelectorAll('[role="tabpanel"]')[idx] || null;
  }

  async function clickTab(testId) {
    const tab = document.querySelector(testId);
    if (!tab) throw new Error(`Таб не найден: ${testId}`);
    if (tab.getAttribute('aria-selected') === 'true') return;
    tab.click();
    await waitFor(() => tab.getAttribute('aria-selected') === 'true', 5000);
    await DELAY(3000);
  }

  // Прочитать ячейки таблицы из панели (СВЕЖИЙ запрос, без кэширования ссылок)
  function readCells(panelIdx, n = 15) {
    const panel = panelAt(panelIdx);
    const table = panel?.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('td, th')).slice(0, n).map((c) => c.textContent.trim());
  }

  // Дождаться TABLE mode и загрузки таблицы
  async function ensureTable(panelIdx) {
    const panel = panelAt(panelIdx);
    if (!panel) throw new Error(`Панель ${panelIdx} не найдена`);
    const radio = panel.querySelector('input[value="TABLE"]');
    if (!radio) throw new Error('TABLE radio не найден');
    if (!radio.checked) radio.click();
    await waitFor(() => panelAt(panelIdx)?.querySelector('table') !== null, 10000);
    await DELAY(3000);
  }

  function parseDate(s) {
    s = (s || '').trim();
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) return `${new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  function parseNumber(str) {
    if (!str || typeof str !== 'string') return 0;
    const v = parseFloat(str.replace(/\s/g, '').replace(/,/g, '.').replace(/[^\d.\-]/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function isDateLike(s) {
    if (!s || typeof s !== 'string') return false;
    return /^\d{1,2}\.\d{1,2}(\.\d{2,4})?$/.test(s.trim()) || /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
  }

  function parseTableData(panel) {
    const table = panel?.querySelector('table');
    if (!table) return {};
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) return {};
    const getCells = (r) => Array.from(r.querySelectorAll('td, th')).map((c) => c.textContent.trim());
    const allRows = rows.map(getCells);
    const headers = allRows[0];
    const dataRows = allRows.slice(1);

    let totalRow = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const f = (dataRows[i][0] || '').toLowerCase();
      if (f.includes('итог') || f.includes('total') || f.includes('всего')) { totalRow = i; break; }
    }
    let totalCol = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = (headers[i] || '').toLowerCase();
      if (h.includes('итог') || h.includes('total') || h.includes('всего')) { totalCol = i; break; }
    }

    const firstColDates = dataRows.filter((r) => r.length > 0 && isDateLike(r[0]));
    const dateHeaders = headers.filter((h) => isDateLike(h));
    const result = {};

    if (firstColDates.length > dataRows.length / 2) {
      for (const row of dataRows) {
        if (row.length < 2) continue;
        const d = parseDate(row[0]); if (!d) continue;
        result[d] = totalCol >= 0 && totalCol < row.length ? parseNumber(row[totalCol])
          : row.slice(1).reduce((s, v) => s + parseNumber(v), 0);
      }
    } else if (dateHeaders.length > 0) {
      for (let ci = 0; ci < headers.length; ci++) {
        if (!isDateLike(headers[ci])) continue;
        const d = parseDate(headers[ci]); if (!d) continue;
        result[d] = totalRow >= 0 && ci < dataRows[totalRow].length ? parseNumber(dataRows[totalRow][ci])
          : dataRows.reduce((s, r) => s + (ci < r.length ? parseNumber(r[ci]) : 0), 0);
      }
    } else {
      for (const row of dataRows) {
        for (const cell of row) {
          if (isDateLike(cell)) {
            const d = parseDate(cell);
            if (d && !result[d]) {
              const ni = row.indexOf(cell);
              const nums = row.slice(ni + 1).map(parseNumber).filter((n) => n > 0);
              result[d] = nums.length > 0 ? nums[0] : 0;
            }
            break;
          }
        }
      }
    }
    return result;
  }

  function extractDateRange() {
    const el = document.querySelector(SEL.dateRangeTrigger);
    if (!el) return null;
    const m = (el.textContent || '').match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);
    return m ? { from: m[1], to: m[2] } : null;
  }

  function extractAppId() {
    const m = window.location.pathname.match(/\/apps\/(\d+)\//);
    return m ? m[1] : null;
  }

  // ═══════════════════════════════════════════════════════════
  async function collectData() {
    try {
      await waitForStatsPage();
      log('init', window.location.href);

      const result = {
        appId: extractAppId(), platform: 'rustore',
        timestamp: new Date().toISOString(), dateRange: extractDateRange(), metrics: {},
      };

      // ── 1. Просмотры (панель 0) ──
      log('1-clickViews', '');
      await clickTab(SEL.viewsTab);
      log('1-ensureTable', '');
      await ensureTable(0);
      const vCells = readCells(0, 15);
      log('1-cells', vCells);
      result.metrics.views = parseTableData(panelAt(0));
      log('1-parsed', result.metrics.views);

      // Запоминаем «Всего» из просмотров чтобы потом сравнить
      const viewsTotal = vCells[9] || '';

      // ── 2. Установки (панель 1) ──
      log('2-clickInst', '');
      await clickTab(SEL.installationsTab);

      // После клика: ждём пока ячейка[9] в панели 1 изменится с viewsTotal.
      // Каждый тик делаем СВЕЖИЙ запрос panelAt(1) — React может пересоздать элемент.
      log('2-pollStart', `waiting cell[9] != "${viewsTotal}"`);
      let dataLoaded = false;
      for (let i = 0; i < 30; i++) { // 30 × 500мс = 15с максимум
        await DELAY(500);
        const cells = readCells(1, 12);
        log(`2-poll-${i}`, cells);
        if (cells.length > 9 && cells[9] !== viewsTotal) {
          dataLoaded = true;
          log('2-pollDone', `cell[9]="${cells[9]}" (was "${viewsTotal}")`);
          break;
        }
      }

      if (!dataLoaded) {
        log('2-pollFail', 'Данные не обновились за 15с, пробуем CHARTS→TABLE');
        const p = panelAt(1);
        const ch = p?.querySelector('input[value="CHARTS"]');
        const tb = p?.querySelector('input[value="TABLE"]');
        if (ch) ch.click();
        await DELAY(1500);
        if (tb) tb.click();
        await DELAY(5000);
      }

      // Финальное чтение — СВЕЖИЙ запрос панели
      await ensureTable(1);
      const iCells = readCells(1, 15);
      log('2-finalCells', iCells);
      result.metrics.installations = parseTableData(panelAt(1));
      log('2-parsed', result.metrics.installations);

      result._debugLog = LOG;
      return { success: true, data: result };
    } catch (e) {
      LOG.push({ t: Date.now(), step: 'FATAL', detail: e.message });
      return { success: false, error: e.message, _debugLog: LOG };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.action === 'collectRuStore') { collectData().then(sendResponse); return true; }
    if (msg.action === 'ping') {
      sendResponse({ alive: true, platform: 'rustore', appId: extractAppId(), url: window.location.href });
      return false;
    }
  });
})();