// content/rustore.js — RuStore Statistics Parser
// Извлекает "Просмотры страницы" и "Все установки" по дням из консоли RuStore

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Логирование ───
  const LOG = [];
  function log(step, detail) {
    const entry = {
      t: Date.now(),
      step,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    };
    LOG.push(entry);
    console.log(`[AMH ${step}]`, detail);
  }

  // ─── Selectors ───
  const SEL = {
    pageTitle: '[data-testid="advancedAppStatisticsPage-title"]',
    dateRangeTrigger:
      '[data-testid="advancedAppStatisticsPage-filterDateRange-textSelectTrigger"]',
    viewsTab: '[data-testid="advancedAppStatisticsPage-views"]',
    installationsTab: '[data-testid="advancedAppStatisticsPage-installations"]',
    chartsContainer: '[data-testid="advancedAppStatisticsPage-charts"]',
  };

  // ─── Utility: wait for element ───
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
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Таймаут ожидания элемента: ${selector}`));
      }, timeoutMs);
    });
  }

  // ─── Utility: wait until condition is true ───
  function waitFor(checkFn, timeoutMs = 10000, intervalMs = 300) {
    return new Promise((resolve, reject) => {
      if (checkFn()) return resolve();
      const timer = setTimeout(() => {
        clearInterval(poller);
        reject(new Error('Таймаут waitFor'));
      }, timeoutMs);
      const poller = setInterval(() => {
        if (checkFn()) { clearTimeout(timer); clearInterval(poller); resolve(); }
      }, intervalMs);
    });
  }

  // ─── Страница статистики загрузилась ───
  async function waitForStatsPage() {
    try {
      await waitForElement(SEL.chartsContainer, document, 15000);
      await waitFor(
        () => {
          const canvas = document.querySelector(`${SEL.chartsContainer} canvas`);
          return canvas && canvas.width > 0 && canvas.height > 0;
        },
        10000
      );
      await DELAY(500);
    } catch (e) {
      throw new Error('Страница статистики RuStore не загрузилась вовремя');
    }
  }

  // ─── Найти панель по индексу таба (tabs[i] ↔ panels[i]) ───
  // RuStore НЕ использует aria-controls/aria-labelledby/id на панелях,
  // поэтому единственный надёжный способ — по порядковому индексу.
  function getPanelByTabIndex(tabIndex) {
    const panels = document.querySelectorAll('[role="tabpanel"]');
    return panels[tabIndex] || null;
  }

  function getActiveTabIndex() {
    const tabs = document.querySelectorAll('[role="tab"]');
    const arr = Array.from(tabs);
    return arr.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  }

  // ─── Нажать на таб метрики ───
  async function clickMetricTab(testId) {
    const tab = document.querySelector(testId);
    if (!tab) throw new Error(`Таб не найден: ${testId}`);
    if (tab.getAttribute('aria-selected') === 'true') return;
    tab.click();
    await waitFor(() => tab.getAttribute('aria-selected') === 'true', 5000);
    await DELAY(3000);
  }

  // ─── Прочитать первые N ячеек таблицы в панели ───
  function getTableCells(panel, n = 15) {
    const table = panel?.querySelector('table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('td, th'))
      .slice(0, n)
      .map((c) => c.textContent.trim());
  }

  // ─── Дождаться обновления данных в таблице панели ───
  // RuStore обновляет данные IN-PLACE (тот же DOM-элемент, другой textContent).
  // Поэтому мы поллим содержимое ячеек, сравнивая с «старым» значением.
  // compareIdx — индекс ячейки для сравнения (например, 9 = «Всего»).
  async function waitForTableDataChange(panel, staleCells, compareIdx = 9, timeoutMs = 12000) {
    const staleValue = staleCells[compareIdx] || '';
    log('waitForChange', `polling cell[${compareIdx}], stale="${staleValue}"`);

    try {
      await waitFor(
        () => {
          const cells = getTableCells(panel, compareIdx + 1);
          return cells.length > compareIdx && cells[compareIdx] !== staleValue;
        },
        timeoutMs,
        500
      );
      const newCells = getTableCells(panel, 15);
      log('waitForChange-done', newCells);
      return true;
    } catch (_) {
      log('waitForChange-timeout', `за ${timeoutMs}мс ячейка не изменилась, текущие: ${JSON.stringify(getTableCells(panel, 15))}`);
      return false;
    }
  }

  // ─── Переключить панель в TABLE, дождаться таблицы ───
  async function switchToTable(panel) {
    const tableRadio = panel.querySelector('input[value="TABLE"]');
    if (!tableRadio) throw new Error('Переключатель TABLE не найден');
    if (!tableRadio.checked) tableRadio.click();
    await waitFor(() => panel.querySelector('table') !== null, 10000);
    await DELAY(3000);
  }

  // ─── Парсинг даты ───
  function parseDate(dateStr) {
    const s = (dateStr || '').trim();
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) return `${new Date().getFullYear()}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  function parseNumber(str) {
    if (!str || typeof str !== 'string') return 0;
    const cleaned = str.replace(/\s/g, '').replace(/,/g, '.').replace(/[^\d.\-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  function isDateLike(str) {
    if (!str || typeof str !== 'string') return false;
    return (
      /^\d{1,2}\.\d{1,2}(\.\d{2,4})?$/.test(str.trim()) ||
      /^\d{4}-\d{2}-\d{2}$/.test(str.trim())
    );
  }

  // ─── Извлечь данные из таблицы ───
  function parseTableData(panel) {
    const table = panel.querySelector('table');
    if (!table) return {};
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) return {};

    const getCells = (row) =>
      Array.from(row.querySelectorAll('td, th')).map((c) => c.textContent.trim());
    const allRows = rows.map(getCells);
    const headers = allRows[0];
    const dataRows = allRows.slice(1);

    let totalRowIndex = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const first = (dataRows[i][0] || '').toLowerCase();
      if (first.includes('итог') || first.includes('total') || first.includes('всего')) {
        totalRowIndex = i;
        break;
      }
    }

    let totalColIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = (headers[i] || '').toLowerCase();
      if (h.includes('итог') || h.includes('total') || h.includes('всего')) {
        totalColIndex = i;
        break;
      }
    }

    const firstColDates = dataRows.filter((r) => r.length > 0 && isDateLike(r[0]));
    const dateHeaders = headers.filter((h) => isDateLike(h));
    const result = {};

    if (firstColDates.length > dataRows.length / 2) {
      for (const row of dataRows) {
        if (row.length < 2) continue;
        const date = parseDate(row[0]);
        if (!date) continue;
        if (totalColIndex >= 0 && totalColIndex < row.length) {
          result[date] = parseNumber(row[totalColIndex]);
        } else {
          result[date] = row.slice(1).reduce((sum, val) => sum + parseNumber(val), 0);
        }
      }
    } else if (dateHeaders.length > 0) {
      for (let ci = 0; ci < headers.length; ci++) {
        if (!isDateLike(headers[ci])) continue;
        const date = parseDate(headers[ci]);
        if (!date) continue;
        if (totalRowIndex >= 0) {
          const totalRow = dataRows[totalRowIndex];
          result[date] = ci < totalRow.length ? parseNumber(totalRow[ci]) : 0;
        } else {
          result[date] = dataRows.reduce((sum, row) => {
            return sum + (ci < row.length ? parseNumber(row[ci]) : 0);
          }, 0);
        }
      }
    } else {
      for (const row of dataRows) {
        for (const cell of row) {
          if (isDateLike(cell)) {
            const date = parseDate(cell);
            if (date && !result[date]) {
              const numIdx = row.indexOf(cell);
              const nums = row.slice(numIdx + 1).map(parseNumber).filter((n) => n > 0);
              result[date] = nums.length > 0 ? nums[0] : 0;
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
    const text = el.textContent || '';
    const m = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);
    return m ? { from: m[1], to: m[2] } : null;
  }

  function extractAppId() {
    const m = window.location.pathname.match(/\/apps\/(\d+)\//);
    return m ? m[1] : null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Главная функция сбора данных
  // ═══════════════════════════════════════════════════════════
  async function collectData() {
    try {
      await waitForStatsPage();
      log('init', `URL: ${window.location.href}`);

      const result = {
        appId: extractAppId(),
        platform: 'rustore',
        timestamp: new Date().toISOString(),
        dateRange: extractDateRange(),
        metrics: {},
      };

      // Индексы табов: 0=Просмотры, 1=Установки
      const VIEWS_IDX = 0;
      const INST_IDX = 1;

      // ── 1. Просмотры ──
      log('step1', 'Таб Просмотры → TABLE → чтение');
      await clickMetricTab(SEL.viewsTab);
      const viewsPanel = getPanelByTabIndex(VIEWS_IDX);
      await switchToTable(viewsPanel);
      const viewsCells = getTableCells(viewsPanel, 15);
      log('step1-cells', viewsCells);
      result.metrics.views = parseTableData(viewsPanel);
      log('step1-parsed', result.metrics.views);

      // ── 2. Установки ──
      log('step2', 'Таб Установки → ждём обновление данных → чтение');
      const instPanel = getPanelByTabIndex(INST_IDX);
      const staleCells = getTableCells(instPanel, 15);
      log('step2-stale', staleCells);

      await clickMetricTab(SEL.installationsTab);

      // RuStore обновляет данные IN-PLACE (тот же элемент <table>, другой textContent).
      // Поллим ячейку[9] («Всего»): когда изменится — данные загрузились.
      const changed = await waitForTableDataChange(instPanel, staleCells, 9, 12000);

      if (!changed) {
        // Данные не обновились сами — принудительно CHARTS→TABLE
        log('step2-forceSwitch', 'Данные не обновились, CHARTS→TABLE');
        const charts = instPanel.querySelector('input[value="CHARTS"]');
        const tableR = instPanel.querySelector('input[value="TABLE"]');
        if (charts) { charts.click(); await DELAY(1000); }
        if (tableR) { tableR.click(); await DELAY(1000); }
        await waitFor(() => instPanel.querySelector('table') !== null, 10000);
        await DELAY(3000);
      }

      const instCells = getTableCells(instPanel, 15);
      log('step2-finalCells', instCells);
      result.metrics.installations = parseTableData(instPanel);
      log('step2-parsed', result.metrics.installations);

      result._debugLog = LOG;
      return { success: true, data: result };
    } catch (e) {
      LOG.push({ t: Date.now(), step: 'FATAL', detail: e.message });
      return { success: false, error: e.message, _debugLog: LOG };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Обработчик сообщений
  // ═══════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'collectRuStore') {
      collectData().then(sendResponse);
      return true;
    }
    if (message.action === 'ping') {
      sendResponse({
        alive: true,
        platform: 'rustore',
        appId: extractAppId(),
        url: window.location.href,
      });
      return false;
    }
  });
})();