// content/rustore.js — RuStore Statistics Parser
// Извлекает "Просмотры страницы" и "Все установки" по дням из консоли RuStore

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // Дополнительно ждём, пока canvas получит нормальные размеры
      await waitFor(
        () => {
          const canvas = document.querySelector(
            `${SEL.chartsContainer} canvas`
          );
          return canvas && canvas.width > 0 && canvas.height > 0;
        },
        10000
      );
      await DELAY(500);
    } catch (e) {
      throw new Error('Страница статистики RuStore не загрузилась вовремя');
    }
  }

  // ─── Нажать на таб метрики и дождаться загрузки данных ───
  // Используем фиксированную паузу вместо отслеживания DOM-состояния,
  // потому что RuStore (React SPA) обновляет DOM асинхронно и
  // непредсказуемо: после клика на таб появляется спиннер на ~1 сек,
  // затем рендерится содержимое. Проверки hidden/aria-selected/table
  // ненадёжны — данные могут быть ещё не загружены.
  async function clickMetricTab(testId) {
    const tab = document.querySelector(testId);
    if (!tab) throw new Error(`Таб не найден: ${testId}`);

    const isSelected = tab.getAttribute('aria-selected') === 'true';
    if (!isSelected) {
      tab.click();
      // Ждём изменения aria-selected
      await waitFor(
        () => tab.getAttribute('aria-selected') === 'true',
        5000
      );
      // Фиксированная пауза — даём данным панели прогрузиться
      await DELAY(3000);
    }
  }

  // ─── Получить активную (видимую) панель по ассоциации с активным табом ───
  // RuStore — SPA на React: после клика на таб атрибут hidden обновляется
  // асинхронно, поэтому надёжнее находить панель через связь tab↔panel.
  function getActivePanel() {
    const tabs = document.querySelectorAll('[role="tab"]');
    const panels = document.querySelectorAll('[role="tabpanel"]');

    // Стратегия 1: aria-controls на табе → id панели
    for (const tab of tabs) {
      if (tab.getAttribute('aria-selected') !== 'true') continue;
      const controlsId = tab.getAttribute('aria-controls');
      if (controlsId) {
        const panel = document.getElementById(controlsId);
        if (panel) return panel;
      }
    }

    // Стратегия 2: id таба → aria-labelledby на панели
    for (const tab of tabs) {
      if (tab.getAttribute('aria-selected') !== 'true') continue;
      const tabId = tab.getAttribute('id');
      if (tabId) {
        for (const panel of panels) {
          if (panel.getAttribute('aria-labelledby') === tabId) return panel;
        }
      }
    }

    // Стратегия 3: по порядковому индексу (tabs[i] ↔ panels[i])
    const tabArr = Array.from(tabs);
    const activeIdx = tabArr.findIndex(
      (t) => t.getAttribute('aria-selected') === 'true'
    );
    if (activeIdx >= 0 && activeIdx < panels.length) return panels[activeIdx];

    // Стратегия 4 (fallback): без hidden
    for (const panel of panels) {
      if (!panel.hasAttribute('hidden')) return panel;
    }

    return panels[0] || null;
  }

  // ─── Переключить активную панель в режим TABLE и дождаться данных ───
  // ВАЖНО: не сохраняем ссылку на panel через async-паузы!
  // RuStore React SPA при переключении таба может ЗАМЕНИТЬ элемент
  // panel целиком (detached old → new in DOM). Если держать ссылку
  // на старый элемент, querySelector найдёт таблицу в мёртвом DOM
  // с устаревшими данными. Поэтому все запросы — свежие (getActivePanel()).
  async function switchToTableView() {
    // Найти radio-кнопку TABLE в активной панели (свежий запрос)
    const tableRadio = getActivePanel()?.querySelector('input[value="TABLE"]');
    if (!tableRadio)
      throw new Error(
        'Переключатель TABLE не найден в панели. Возможно, интерфейс RuStore изменился.'
      );

    if (!tableRadio.checked) {
      tableRadio.click();
    }

    // Ждём появления <table> — СВЕЖИЙ запрос каждый тик
    await waitFor(
      () => getActivePanel()?.querySelector('table') !== null,
      10000
    );

    // Фиксированная пауза — даём таблице прогрузиться с данными.
    await DELAY(3000);
  }

  // ─── Переключить обратно в CHARTS ───
  async function switchToChartView() {
    const panel = getActivePanel();
    if (!panel) return;
    const chartsRadio = panel.querySelector('input[value="CHARTS"]');
    if (chartsRadio && !chartsRadio.checked) {
      chartsRadio.click();
      await DELAY(300);
    }
  }

  // ─── Парсинг даты из различных форматов ───
  function parseDate(dateStr) {
    const s = (dateStr || '').trim();
    // DD.MM.YYYY
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    // DD.MM (текущий год)
    m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (m) {
      const y = new Date().getFullYear();
      return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  // ─── Парсинг числа из русского формата (пробелы-разделители, запятая) ───
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

  // ─── Извлечь данные из таблицы → { "YYYY-MM-DD": number, ... } ───
  function parseTableData(panel) {
    const table = panel.querySelector('table');
    if (!table) return {};

    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) return {};

    const getCells = (row) =>
      Array.from(row.querySelectorAll('td, th')).map((c) =>
        c.textContent.trim()
      );

    const allRows = rows.map(getCells);
    const headers = allRows[0];
    const dataRows = allRows.slice(1);

    // ── Стратегия 1: найти строку «Итого» ──
    let totalRowIndex = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const first = (dataRows[i][0] || '').toLowerCase();
      if (first.includes('итог') || first.includes('total') || first.includes('всего')) {
        totalRowIndex = i;
        break;
      }
    }

    // ── Стратегия 2: найти столбец «Итого» ──
    let totalColIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = (headers[i] || '').toLowerCase();
      if (h.includes('итог') || h.includes('total') || h.includes('всего')) {
        totalColIndex = i;
        break;
      }
    }

    // ── Определить ориентацию: даты в строках или столбцах ──
    const firstColDates = dataRows.filter((r) => r.length > 0 && isDateLike(r[0]));
    const dateHeaders = headers.filter((h) => isDateLike(h));

    const result = {};

    if (firstColDates.length > dataRows.length / 2) {
      // ── Даты в строках, версии/размерности — в столбцах ──
      for (const row of dataRows) {
        if (row.length < 2) continue;
        const date = parseDate(row[0]);
        if (!date) continue;

        if (totalColIndex >= 0 && totalColIndex < row.length) {
          // Есть столбец «Итого» — берём его
          result[date] = parseNumber(row[totalColIndex]);
        } else {
          // Суммируем все числовые столбцы (все версии)
          result[date] = row.slice(1).reduce((sum, val) => sum + parseNumber(val), 0);
        }
      }
    } else if (dateHeaders.length > 0) {
      // ── Даты в заголовках (столбцах), версии — в строках ──
      for (let ci = 0; ci < headers.length; ci++) {
        if (!isDateLike(headers[ci])) continue;
        const date = parseDate(headers[ci]);
        if (!date) continue;

        if (totalRowIndex >= 0) {
          // Есть строка «Итого» — берём её
          const totalRow = dataRows[totalRowIndex];
          result[date] =
            ci < totalRow.length ? parseNumber(totalRow[ci]) : 0;
        } else {
          // Суммируем все строки для этого столбца-даты
          result[date] = dataRows.reduce((sum, row) => {
            return sum + (ci < row.length ? parseNumber(row[ci]) : 0);
          }, 0);
        }
      }
    } else {
      // Фоллбэк: пробуем найти строки с датами в любом столбце
      for (const row of dataRows) {
        for (const cell of row) {
          if (isDateLike(cell)) {
            const date = parseDate(cell);
            if (date && !result[date]) {
              // Берём первое число из строки после даты
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

  // ─── Извлечь период из заголовка страницы ───
  function extractDateRange() {
    const el = document.querySelector(SEL.dateRangeTrigger);
    if (!el) return null;
    const text = el.textContent || '';
    const m = text.match(
      /(\d{2}\.\d{2}\.\d{4})\s*[–\-—]\s*(\d{2}\.\d{2}\.\d{4})/
    );
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

      const appId = extractAppId();
      const dateRange = extractDateRange();

      const result = {
        appId,
        platform: 'rustore',
        timestamp: new Date().toISOString(),
        dateRange,
        metrics: {},
      };

      // ── 1. Просмотры страницы ──
      try {
        await clickMetricTab(SEL.viewsTab);
        await switchToTableView();
        // СВЕЖИЙ запрос панели — после всех задержек
        result.metrics.views = parseTableData(getActivePanel());
      } catch (e) {
        result.metrics.views = {};
        result.metrics._viewsError = e.message;
      }

      // ── 2. Все установки ──
      try {
        await clickMetricTab(SEL.installationsTab);
        await switchToTableView();
        // СВЕЖИЙ запрос панели — после всех задержек.
        // React мог заменить элемент панели во время загрузки данных.
        result.metrics.installations = parseTableData(getActivePanel());
      } catch (e) {
        result.metrics.installations = {};
        result.metrics._installationsError = e.message;
      }

      // ── Вернуть первый таб и режим CHARTS ──
      try {
        await clickMetricTab(SEL.viewsTab);
        await switchToChartView();
      } catch (_) {
        // не критично
      }

      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Обработчик сообщений от popup / background
  // ═══════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'collectRuStore') {
      collectData().then(sendResponse);
      return true; // оставить канал открытым для async
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