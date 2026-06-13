// content/yandex-ads.js — РСЯ Dashboard Parser
// Парсит таблицы с дэшборда https://partner.yandex.ru/v2/dashboard

(function () {
  'use strict';

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH-RSYA ${step}]`, detail);
  }

  // ── Хелперы парсинга чисел и дат ──

  function parseNum(s) {
    if (!s || typeof s !== 'string') return 0;
    // "6\u205f280" -> thin space -> normal space, "276,43 ₽" -> strip currency
    const cleaned = s.replace(/\u205f/g, ' ').replace(/\s/g, '').replace(/[^\d.\-]/g, '');
    const v = parseFloat(cleaned.replace(',', '.'));
    return isNaN(v) ? 0 : v;
  }

  function parseMoney(s) {
    if (!s || typeof s !== 'string') return 0;
    // "276,43 ₽" -> 276.43
    const cleaned = s.replace(/\u205f/g, ' ').replace(/[₽\s]/g, '').replace(',', '.');
    const v = parseFloat(cleaned);
    return isNaN(v) ? 0 : v;
  }

  // "13 июня 2026, сб" -> "2026-06-13"
  function parseDate(s) {
    if (!s || typeof s !== 'string') return null;
    const months = {
      'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4,
      'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
      'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12,
    };
    const m = s.match(/(\d{1,2})\s+(\S+?)\s+(\d{4})/);
    if (!m) return null;
    const month = months[m[2].toLowerCase()];
    if (!month) return null;
    const day = m[1].padStart(2, '0');
    return `${m[3]}-${String(month).padStart(2, '0')}-${day}`;
  }

  // ── Получить текстовое содержимое элемента ──

  function getText(el) {
    if (!el) return '';
    // Заменяем &nbsp; и thin space на обычный пробел
    return (el.textContent || el.innerText || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\u205f/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Распознать тип колонки по заголовку ──

  function identifyColumns(headerTexts) {
    const colMap = {};
    for (let i = 0; i < headerTexts.length; i++) {
      const h = headerTexts[i].toLowerCase();
      if (h === 'дата') colMap.date = i;
      else if (h === 'тип блока') colMap.blockType = i;
      else if (h.includes('вознаграждение')) colMap.revenue = i;
      else if (h.includes('видимые показы')) colMap.visibleImpressions = i;
      else if (h === 'показы') colMap.impressions = i;
      else if (h === 'ecpm') colMap.ecpm = i;
      else if (h.includes('клик')) colMap.clicks = i;
      else if (h.includes('ctr')) colMap.ctr = i;
    }
    return colMap;
  }

  // ── Парсинг одного виджета (одного приложения) ──

  function parseWidget(widgetEl) {
    // Название приложения — из ссылки внутри заголовка
    const linkEl = widgetEl.querySelector('[data-testid="Link"]');
    const appName = getText(linkEl) || 'Unknown App';

    // Все заголовки колонок
    const headerEls = widgetEl.querySelectorAll('[data-testid^="HeaderCell"]');
    const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
    const cols = identifyColumns(headerTexts);

    log('parseWidget', `${appName} | columns: ${JSON.stringify(cols)} | headers: ${JSON.stringify(headerTexts)}`);

    // Все ячейки данных
    const cellEls = widgetEl.querySelectorAll('[data-testid="Cell"]');
    const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

    if (cellTexts.length === 0) {
      log('parseWidget', `нет ячеек для ${appName}`);
      return { appName, rows: [] };
    }

    // Определяем ширину строки (сколько полей данных на каждую строку)
    // Паттерн: Дата, Тип блока, [данные...]
    // Считаем количество полей между датами
    const dateIndices = [];
    for (let i = 0; i < cellTexts.length; i++) {
      if (parseDate(cellTexts[i])) dateIndices.push(i);
    }

    if (dateIndices.length === 0) {
      log('parseWidget', `нет дат для ${appName}`);
      return { appName, rows: [] };
    }

    // Ширина строки = позиция второй даты минус позиция первой даты
    let rowWidth = dateIndices.length > 1
      ? dateIndices[1] - dateIndices[0]
      : cellTexts.length - dateIndices[0];

    const rows = [];
    for (let i = 0; i < dateIndices.length; i++) {
      const start = dateIndices[i];
      const end = i + 1 < dateIndices.length ? dateIndices[i + 1] : start + rowWidth;
      const rowCells = cellTexts.slice(start, end);

      const date = parseDate(rowCells[0]);
      if (!date) continue;

      const row = { date };

      // Если есть колонка Тип блока — строки группируются по нему
      if (cols.blockType !== undefined) {
        row.blockType = rowCells[1] || '';
      }

      // Мапим значения по колонкам
      // Порядок в ячейках: Дата, [Тип блока], [Видимые показы], Вознаграждение, Показы, eCPM
      // Но точный порядок зависит от набора колонок в конкретном виджете
      // Поэтому используем смещения относительно известных позиций

      // Собираем все числовые значения из строки
      const numValues = [];
      for (let j = (cols.blockType !== undefined ? 2 : 1); j < rowCells.length; j++) {
        const v = rowCells[j];
        if (v) numValues.push(v);
      }

      // Определяем порядок метрик по заголовкам (пропуская Дата и Тип блока)
      const metricOrder = [];
      for (let j = 0; j < headerTexts.length; j++) {
        const h = headerTexts[j].toLowerCase();
        if (h === 'дата' || h === 'тип блока' || h === 'итого' || h === '') continue;
        // Пропускаем суммарные значения (заголовки с числами вроде "6 280" — это итого)
        if (/\d/.test(headerTexts[j]) && j > 0) continue;
        metricOrder.push(h);
      }

      // Маппинг: по порядку метрик в заголовках берем значения из numValues
      for (let mi = 0; mi < metricOrder.length && mi < numValues.length; mi++) {
        const metric = metricOrder[mi];
        const val = numValues[mi];

        if (metric.includes('вознаграждение')) row.revenue = parseMoney(val);
        else if (metric.includes('видимые показы')) row.visibleImpressions = parseNum(val);
        else if (metric === 'показы') row.impressions = parseNum(val);
        else if (metric === 'ecpm') row.ecpm = parseMoney(val);
        else if (metric.includes('клик')) row.clicks = parseNum(val);
        else if (metric.includes('ctr')) row.ctr = val;
      }

      rows.push(row);
    }

    log('parseWidget', `${appName}: ${rows.length} rows parsed`);
    return { appName, rows };
  }

  // ── Агрегация строк по дате (складываем разные типы блоков) ──

  function aggregateByDate(rows) {
    const byDate = {};
    for (const row of rows) {
      if (!byDate[row.date]) {
        byDate[row.date] = { impressions: 0, revenue: 0, clicks: 0 };
      }
      byDate[row.date].impressions += row.impressions || 0;
      byDate[row.date].revenue += row.revenue || 0;
      byDate[row.date].clicks += row.clicks || 0;
    }
    return byDate;
  }

  // ── Главный сборщик ──

  async function collectData() {
    try {
      log('init', window.location.href);

      // Найти все виджеты-таблицы на дэшборде
      const widgets = document.querySelectorAll('[data-testid="piWidgetRenderer.WidgetStatisticsTable"]');

      if (widgets.length === 0) {
        throw new Error('Таблицы статистики не найдены на странице. Убедитесь что вы на дэшборде.');
      }

      log('foundWidgets', `найдено ${widgets.length} виджетов`);

      const allApps = [];

      for (const widget of widgets) {
        const parsed = parseWidget(widget);
        const aggregated = aggregateByDate(parsed.rows);

        // Используем имя приложения как appId (в РСЯ нет числовых ID на дэшборде)
        const appId = parsed.appName;

        allApps.push({
          appId,
          name: parsed.appName,
          platform: 'rsya',
          metrics: {
            impressions: Object.fromEntries(
              Object.entries(aggregated).map(([d, v]) => [d, v.impressions])
            ),
            revenue: Object.fromEntries(
              Object.entries(aggregated).map(([d, v]) => [d, v.revenue])
            ),
            clicks: Object.fromEntries(
              Object.entries(aggregated).map(([d, v]) => [d, v.clicks])
            ),
          },
        });
      }

      const result = {
        platform: 'rsya',
        timestamp: new Date().toISOString(),
        dateRange: null, // На дэшборде нет явного диапазона
        apps: allApps,
        _debugLog: LOG,
      };

      log('done', `${allApps.length} приложений обработано`);
      return { success: true, data: result };

    } catch (e) {
      LOG.push({ t: Date.now(), step: 'FATAL', detail: e.message });
      return { success: false, error: e.message, _debugLog: LOG };
    }
  }

  // ── Обработчик сообщений ──

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'collectYandexAds') {
      collectData().then(sendResponse);
      return true;
    }

    if (msg.action === 'ping') {
      sendResponse({
        alive: true,
        platform: 'rsya',
        url: window.location.href,
      });
      return false;
    }
  });
})();