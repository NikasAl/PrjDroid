// content/yandex-ads.js — РСЯ Dashboard Parser
// Парсит виртуализированные таблицы fixedDataTable с дэшборда

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH-RSYA ${step}]`, detail);
  }

  // ── Хелперы ──

  function parseNum(s) {
    if (!s || typeof s !== 'string') return 0;
    const c = s.replace(/\u205f/g, '').replace(/\s/g, '').replace(/[^\d.\-]/g, '');
    const v = parseFloat(c.replace(',', '.'));
    return isNaN(v) ? 0 : v;
  }

  function parseMoney(s) {
    if (!s || typeof s !== 'string') return 0;
    const c = s.replace(/\u205f/g, '').replace(/[₽\s]/g, '').replace(',', '.');
    const v = parseFloat(c);
    return isNaN(v) ? 0 : v;
  }

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
    return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  function getText(el) {
    if (!el) return '';
    return (el.textContent || el.innerText || '')
      .replace(/&nbsp;/g, ' ').replace(/\u205f/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ── Скролл виртуализированной таблицы ──

  async function scrollWidgetTable(widgetEl) {
    // Ищем scrollable контейнер внутри виджета
    const scrollable =
      widgetEl.querySelector('.public_fixedDataTable_body') ||
      widgetEl.querySelector('.fixedDataTableLayout_rowsContainer');

    if (!scrollable) {
      log('scroll', 'scrollable not found, skip');
      return;
    }

    // Даём tiny delay чтобы браузер отрисовал
    await DELAY(200);

    const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
    if (maxScroll <= 0) {
      log('scroll', `no scroll needed (scrollHeight=${scrollable.scrollHeight})`);
      return;
    }

    log('scroll', `scrolling ${maxScroll}px`);
    const step = Math.max(200, Math.floor(maxScroll / 40));
    let pos = 0;

    while (pos < maxScroll) {
      pos = Math.min(pos + step, maxScroll);
      scrollable.scrollTop = pos;
      await DELAY(120);
    }

    // Скролл наверх
    scrollable.scrollTop = 0;
    await DELAY(200);
    log('scroll', `done, final cells will be read now`);
  }

  // ── Определить порядок метрик по заголовкам ──

  function buildMetricInfo(headerTexts) {
    // Возвращаем: { order: [...], fieldsPerRow: N }
    // Заголовки двойные: "Метрика" | "Сумма" — пропускаем суммы
    const order = [];
    for (const h of headerTexts) {
      const hl = h.toLowerCase();
      if (hl === 'дата' || hl === 'тип блока' || hl === 'итого' || hl === '') continue;
      if (/\d/.test(h)) continue; // пропускаем ячейки-суммы
      if (hl.includes('вознаграждение')) order.push('revenue');
      else if (hl.includes('видимые показы')) order.push('visibleImpressions');
      else if (hl === 'показы') order.push('impressions');
      else if (hl === 'ecpm') order.push('ecpm');
      else if (hl.includes('клик')) order.push('clicks');
      else if (hl.includes('ctr')) order.push('ctr');
    }

    // Если есть "Видимые показы" но нет "Показы" — используем видимые как показы
    const hasImpressions = order.includes('impressions');
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'visibleImpressions' && !hasImpressions) {
        order[i] = 'impressions';
      }
    }

    const hasBlockType = headerTexts.some(h => h.toLowerCase() === 'тип блока');
    const fieldsPerRow = 1 + (hasBlockType ? 1 : 0) + order.length;

    return { order, hasBlockType, fieldsPerRow };
  }

  // ── Парсинг строк из ячеек ──

  function parseRows(cellTexts, metricInfo) {
    const { order, fieldsPerRow } = metricInfo;
    const rows = [];
    let i = 0;

    while (i < cellTexts.length) {
      if (parseDate(cellTexts[i])) {
        if (i + fieldsPerRow > cellTexts.length) break;
        const row = { date: parseDate(cellTexts[i]) };
        let offset = 1;

        if (metricInfo.hasBlockType) {
          row.blockType = cellTexts[i + offset] || '';
          offset = 2;
        }

        for (let mi = 0; mi < order.length; mi++) {
          const val = cellTexts[i + offset + mi];
          const metric = order[mi];
          if (metric === 'revenue' || metric === 'ecpm') {
            row[metric] = parseMoney(val);
          } else {
            row[metric] = parseNum(val);
          }
        }

        rows.push(row);
        i += fieldsPerRow;
      } else {
        i++;
      }
    }

    return rows;
  }

  // ── Построить метрики { impressions: {date: val}, revenue: {...}, ... } ──

  function buildMetrics(rows, metricOrder) {
    const metrics = {};
    for (const m of metricOrder) {
      // visibleImpressions не сохраняем отдельно — он уже в impressions
      if (m === 'visibleImpressions') continue;
      metrics[m] = {};
    }
    for (const row of rows) {
      for (const m of Object.keys(metrics)) {
        if (row[m] !== undefined) {
          metrics[m][row.date] = row[m];
        }
      }
    }
    return metrics;
  }

  // ── Поиск виджетов ──

  function findWidgets() {
    // Основной способ: по data-testid
    let widgets = document.querySelectorAll('[data-testid="piWidgetRenderer.WidgetStatisticsTable"]');

    if (widgets.length > 0) return Array.from(widgets);

    // Фолбэк: ищем Card-контейнеры с таблицами fixedDataTable
    // Каждый виджет обёрнут в dc-Card с заголовком-ссылкой и таблицей
    const cards = document.querySelectorAll('.dc-Card');
    const result = [];
    for (const card of cards) {
      const link = card.querySelector('a[data-testid="Link"]');
      const table = card.querySelector('.public_fixedDataTable_main');
      if (link && table) {
        result.push(card);
      }
    }
    return result;
  }

  // ── Главный сборщик ──

  async function collectData() {
    try {
      log('init', window.location.href);

      const widgets = findWidgets();

      if (widgets.length === 0) {
        throw new Error('Таблицы статистики не найдены на странице.');
      }

      log('foundWidgets', `${widgets.length} виджетов`);

      const allApps = [];

      for (let wi = 0; wi < widgets.length; wi++) {
        const widget = widgets[wi];

        // Скроллим чтобы подгрузить все строки
        await scrollWidgetTable(widget);

        // Название
        const linkEl = widget.querySelector('[data-testid="Link"]');
        const appName = getText(linkEl) || `App ${wi + 1}`;

        // Заголовки
        const headerEls = widget.querySelectorAll('[data-testid^="HeaderCell"]');
        const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
        const metricInfo = buildMetricInfo(headerTexts);

        log('widget', `${appName} | metrics: ${JSON.stringify(metricInfo.order)} | fieldsPerRow: ${metricInfo.fieldsPerRow}`);

        // Ячейки
        const cellEls = widget.querySelectorAll('[data-testid="Cell"]');
        const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

        log('widget', `${appName}: ${cellTexts.length} cells`);

        // Парсим
        const rows = parseRows(cellTexts, metricInfo);
        const metrics = buildMetrics(rows, metricInfo.order);

        log('widget', `${appName}: ${rows.length} rows, dates: ${Object.keys(metrics.impressions || {}).length}`);

        allApps.push({
          appId: appName,
          name: appName,
          platform: 'rsya',
          metrics,
        });
      }

      const result = {
        platform: 'rsya',
        timestamp: new Date().toISOString(),
        dateRange: null,
        apps: allApps,
        _debugLog: LOG,
      };

      log('done', `${allApps.length} приложений`);
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
      sendResponse({ alive: true, platform: 'rsya', url: window.location.href });
      return false;
    }
  });
})();