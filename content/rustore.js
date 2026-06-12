// content/rustore.js — RuStore Statistics Parser
// Извлекает "Просмотры страницы" и "Все установки" по дням из консоли RuStore

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Логирование: в console + в массив для возврата ───
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

  function snapshotTable(label, panel) {
    const table = panel?.querySelector('table');
    if (!table) {
      log(label, 'table = null');
      return null;
    }
    const cells = Array.from(table.querySelectorAll('td, th')).map(
      (c) => c.textContent.trim()
    );
    const html = table.outerHTML;
    // Обрезаем HTML для лога (оставляем первые 3000 символов)
    const shortHtml = html.length > 3000 ? html.slice(0, 3000) + '...[truncated]' : html;
    const info = {
      cellsCount: cells.length,
      rowsCount: table.querySelectorAll('tr').length,
      first20Cells: cells.slice(0, 20),
      html: shortHtml,
    };
    log(label, info);
    return info;
  }

  // ─── Selectors (основаны на data-testid из HTML RuStore) ───
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
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(parent.body || parent, {
        childList: true,
        subtree: true,
      });

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
        if (checkFn()) {
          clearTimeout(timer);
          clearInterval(poller);
          resolve();
        }
      }, intervalMs);
    });
  }

  // ─── Ждём, пока страница статистики RuStore полностью отрендерится (SPA) ───
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

  // ─── Нажать на таб метрики ───
  async function clickMetricTab(testId) {
    const tab = document.querySelector(testId);
    if (!tab) throw new Error(`Таб не найден: ${testId}`);

    const isSelected = tab.getAttribute('aria-selected') === 'true';
    if (!isSelected) {
      tab.click();
      await waitFor(
        () => tab.getAttribute('aria-selected') === 'true',
        5000
      );
      await DELAY(3000);
    }
  }

  // ─── Информация обо всех табах и панелях ───
  function dumpTabsAndPanels() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
    const info = {
      tabsCount: tabs.length,
      panelsCount: panels.length,
      tabs: tabs.map((t, i) => ({
        idx: i,
        text: t.textContent.trim().slice(0, 40),
        ariaSelected: t.getAttribute('aria-selected'),
        ariaControls: t.getAttribute('aria-controls'),
        id: t.getAttribute('id'),
        testid: t.getAttribute('data-testid'),
      })),
      panels: panels.map((p, i) => {
        const table = p.querySelector('table');
        const tableRadio = p.querySelector('input[value="TABLE"]');
        const chartsRadio = p.querySelector('input[value="CHARTS"]');
        return {
          idx: i,
          hidden: p.hasAttribute('hidden'),
          ariaLabelledby: p.getAttribute('aria-labelledby'),
          id: p.getAttribute('id'),
          hasTable: !!table,
          tableRows: table ? table.querySelectorAll('tr').length : 0,
          firstTableCells: table
            ? Array.from(table.querySelectorAll('td, th'))
                .slice(0, 10)
                .map((c) => c.textContent.trim())
            : [],
          tableChecked: tableRadio?.checked,
          chartsChecked: chartsRadio?.checked,
        };
      }),
    };
    log('tabs&panels', info);
    return info;
  }

  // ─── Получить активную панель ───
  function getActivePanel() {
    const tabs = document.querySelectorAll('[role="tab"]');
    const panels = document.querySelectorAll('[role="tabpanel"]');

    // Стратегия 1: aria-controls → id
    for (const tab of tabs) {
      if (tab.getAttribute('aria-selected') !== 'true') continue;
      const controlsId = tab.getAttribute('aria-controls');
      if (controlsId) {
        const panel = document.getElementById(controlsId);
        if (panel) return panel;
      }
    }

    // Стратегия 2: id таба → aria-labelledby
    for (const tab of tabs) {
      if (tab.getAttribute('aria-selected') !== 'true') continue;
      const tabId = tab.getAttribute('id');
      if (tabId) {
        for (const panel of panels) {
          if (panel.getAttribute('aria-labelledby') === tabId) return panel;
        }
      }
    }

    // Стратегия 3: по индексу
    const tabArr = Array.from(tabs);
    const activeIdx = tabArr.findIndex(
      (t) => t.getAttribute('aria-selected') === 'true'
    );
    if (activeIdx >= 0 && activeIdx < panels.length) return panels[activeIdx];

    // Стратегия 4: без hidden
    for (const panel of panels) {
      if (!panel.hasAttribute('hidden')) return panel;
    }

    return panels[0] || null;
  }

  // ─── Переключить активную панель в TABLE ───
  async function switchToTable() {
    const panel = getActivePanel();
    if (!panel) throw new Error('Активная панель не найдена');

    const tableRadio = panel.querySelector('input[value="TABLE"]');
    if (!tableRadio) throw new Error('Переключатель TABLE не найден');

    log('switchToTable', `checked=${tableRadio.checked}, panelIdx=[${getPanelIndex(panel)}]`);

    if (!tableRadio.checked) tableRadio.click();

    await waitFor(
      () => getActivePanel()?.querySelector('table') !== null,
      10000
    );
    await DELAY(3000);
  }

  function getPanelIndex(panel) {
    const panels = document.querySelectorAll('[role="tabpanel"]');
    return Array.from(panels).indexOf(panel);
  }

  // ─── Парсинг даты ───
  function parseDate(dateStr) {
    const s = (dateStr || '').trim();
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) {
      const y = new Date().getFullYear();
      return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  // ─── Парсинг числа ───
  function parseNumber(str) {
    if (!str || typeof str !== 'string') return 0;
    const cleaned = str.replace(/\s/g, '').replace(/,/g, '.').replace(/[^\d.\-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }

  // ─── Проверка, похожа ли строка на дату ───
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

  // ─── Извлечь период из заголовка ───
  function extractDateRange() {
    const el = document.querySelector(SEL.dateRangeTrigger);
    if (!el) return null;
    const text = el.textContent || '';
    const m = text.match(/(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/);
    if (m) return { from: m[1], to: m[2] };
    return null;
  }

  // ─── Извлечь ID приложения из URL ───
  function extractAppId() {
    const m = window.location.pathname.match(/\/apps\/(\d+)\//);
    return m ? m[1] : null;
  }

  // ═══════════════════════════════════════════════════════════
  //  Главная функция сбора данных RuStore
  // ═══════════════════════════════════════════════════════════
  async function collectData() {
    try {
      await waitForStatsPage();
      log('init', `URL: ${window.location.href}`);

      // Дамп состояния ДО всего
      dumpTabsAndPanels();

      const result = {
        appId: extractAppId(),
        platform: 'rustore',
        timestamp: new Date().toISOString(),
        dateRange: extractDateRange(),
        metrics: {},
      };

      // ── 1. Просмотры ──
      log('step1-start', 'Переключаемся на таб Просмотры');
      await clickMetricTab(SEL.viewsTab);
      dumpTabsAndPanels();

      log('step1-switchToTable', 'Переключаем в TABLE для просмотров');
      await switchToTable();

      const viewsPanel = getActivePanel();
      const viewsSnapshot = snapshotTable('step1-table', viewsPanel);
      const viewsData = parseTableData(viewsPanel);
      log('step1-parsed', viewsData);
      result.metrics.views = viewsData;

      // ── 2. Установки ──
      log('step2-start', 'Начинаем сбор установок');

      // Запоминаем таблицу в панели установок ДО клика
      const allPanels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
      const instPanelBefore = allPanels[1];
      log('step2-instPanelBefore', {
        exists: !!instPanelBefore,
        idx: 1,
        hasTable: !!instPanelBefore?.querySelector('table'),
        tableCells: instPanelBefore?.querySelector('table')
          ? Array.from(instPanelBefore.querySelector('table').querySelectorAll('td, th'))
              .slice(0, 10)
              .map((c) => c.textContent.trim())
          : [],
        tableHtml: instPanelBefore?.querySelector('table')?.outerHTML?.slice(0, 500),
      });

      const staleTable = instPanelBefore?.querySelector('table');
      let staleSameAsViews = false;
      if (staleTable && viewsSnapshot) {
        // Проверяем, та же ли это таблица (по содержимому первых ячеек)
        const staleCells = Array.from(staleTable.querySelectorAll('td, th'))
          .slice(0, 5)
          .map((c) => c.textContent.trim());
        staleSameAsViews =
          JSON.stringify(staleCells) === JSON.stringify(viewsSnapshot.first20Cells.slice(0, 5));
        log('step2-staleCompare', { staleCells, viewsCells: viewsSnapshot.first20Cells.slice(0, 5), same: staleSameAsViews });
      }

      log('step2-clickTab', 'Кликаем таб Установки');
      await clickMetricTab(SEL.installationsTab);

      // Дамп после клика на таб
      dumpTabsAndPanels();

      // Проверяем что стало с панелью установок
      const instPanelAfter = allPanels[1]; // тот же элемент из массива
      log('step2-instPanelAfterClick', {
        stillInDom: instPanelBefore ? document.body.contains(instPanelBefore) : 'N/A',
        staleTableInDom: staleTable ? document.body.contains(staleTable) : 'N/A',
        staleInInstPanel: instPanelBefore && staleTable ? instPanelBefore.contains(staleTable) : 'N/A',
        newTableExists: !!instPanelBefore?.querySelector('table'),
        newTableCells: instPanelBefore?.querySelector('table')
          ? Array.from(instPanelBefore.querySelector('table').querySelectorAll('td, th'))
              .slice(0, 10)
              .map((c) => c.textContent.trim())
          : [],
        newTableHtml: instPanelBefore?.querySelector('table')?.outerHTML?.slice(0, 500),
      });

      // Если старая таблица всё ещё там — ждём её исчезновения
      if (staleTable && instPanelBefore.contains(staleTable)) {
        log('step2-waitingStale', 'Старая таблица всё ещё в панели, ждём исчезновения...');
        try {
          await waitFor(() => !instPanelBefore.contains(staleTable), 8000);
          log('step2-staleGone', 'Старая таблица исчезла!');
        } catch (_) {
          log('step2-staleTimeout', 'Старая таблица НЕ исчезла за 8с — fallback CHARTS→TABLE');
          const charts = instPanelBefore.querySelector('input[value="CHARTS"]');
          const tableBtn = instPanelBefore.querySelector('input[value="TABLE"]');
          log('step2-fallbackBtns', { chartsChecked: charts?.checked, tableChecked: tableBtn?.checked });
          if (charts) charts.click();
          await DELAY(1000);
          if (tableBtn) tableBtn.click();
          await DELAY(3000);
        }
      }

      // Проверяем после ожидания/fallback
      log('step2-afterWait', {
        panelInDom: instPanelBefore ? document.body.contains(instPanelBefore) : 'N/A',
        tableExists: !!instPanelBefore?.querySelector('table'),
        tableCells: instPanelBefore?.querySelector('table')
          ? Array.from(instPanelBefore.querySelector('table').querySelectorAll('td, th'))
              .slice(0, 10)
              .map((c) => c.textContent.trim())
          : [],
      });

      // getActivePanel() — что она возвращает?
      const activePanelNow = getActivePanel();
      log('step2-activePanel', {
        activePanelIdx: getPanelIndex(activePanelNow),
        isSameAsInst: activePanelNow === instPanelBefore,
        isSameElement: activePanelNow === allPanels[1],
      });

      log('step2-switchToTable', 'Переключаем в TABLE для установок');
      await switchToTable();

      // Финальный дамп
      dumpTabsAndPanels();

      const finalPanel = getActivePanel();
      log('step2-finalPanel', {
        panelIdx: getPanelIndex(finalPanel),
        isSameAsInst: finalPanel === instPanelBefore,
      });

      const instSnapshot = snapshotTable('step2-finalTable', finalPanel);
      const instData = parseTableData(finalPanel);
      log('step2-parsed', instData);

      result.metrics.installations = instData;

      // Сохраняем лог в результате
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