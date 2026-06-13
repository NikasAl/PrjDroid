// content/yandex-ads.js — РСЯ Dashboard Parser
// Парсит виртуализированные таблицы с дэшборда https://partner.yandex.ru/v2/dashboard

(function () {
  'use strict';

  const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

  const LOG = [];
  function log(step, detail) {
    const entry = { t: Date.now(), step, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    LOG.push(entry);
    console.log(`[AMH-RSYA ${step}]`, detail);
  }

  // ── Хелперы парсинга ──

  function parseNum(s) {
    if (!s || typeof s !== 'string') return 0;
    const cleaned = s.replace(/\u205f/g, '').replace(/\s/g, '').replace(/[^\d.\-]/g, '');
    const v = parseFloat(cleaned.replace(',', '.'));
    return isNaN(v) ? 0 : v;
  }

  function parseMoney(s) {
    if (!s || typeof s !== 'string') return 0;
    const cleaned = s.replace(/\u205f/g, '').replace(/[₽\s]/g, '').replace(',', '.');
    const v = parseFloat(cleaned);
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
      .replace(/&nbsp;/g, ' ')
      .replace(/\u205f/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Скролл виртуализированной таблицы до конца ──

  async function scrollTableToEnd(widgetEl) {
    const scrollable = widgetEl.querySelector('.public_fixedDataTable_rowsContainer')
      || widgetEl.querySelector('.fixedDataTableCellGroupLayout_main')
      || widgetEl.querySelector('[style*="overflow"]');

    if (!scrollable) {
      log('scroll', 'no scrollable container found, skipping scroll');
      return;
    }

    const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
    log('scroll', `scrollHeight=${scrollable.scrollHeight}, clientHeight=${scrollable.clientHeight}, maxScroll=${maxScroll}`);

    if (maxScroll <= 0) return;

    // Скроллим порциями, ожидая подгрузки
    const step = Math.max(200, Math.floor(maxScroll / 30));
    let current = 0;
    while (current < maxScroll) {
      current = Math.min(current + step, maxScroll);
      scrollable.scrollTop = current;
      await DELAY(150);
    }

    // Скроллим обратно наверх для надёжности
    scrollable.scrollTop = 0;
    await DELAY(300);
    log('scroll', 'scroll complete');
  }

  // ── Определить порядок метрик по заголовкам ──

  function buildMetricOrder(headerTexts) {
    const order = [];
    let hasImpressions = false;
    for (const h of headerTexts) {
      const hl = h.toLowerCase();
      if (hl === 'дата' || hl === 'тип блока' || hl === 'итого' || hl === '') continue;
      if (/\d/.test(h)) continue;
      if (hl.includes('вознаграждение')) order.push('revenue');
      else if (hl.includes('видимые показы')) {
        // Запоминаем но пока не добавляем — если будет "Показы", он заменит
        order.push('visibleImpressions');
      }
      else if (hl === 'показы') {
        // Если уже есть visibleImpressions — заменим
        const vi = order.indexOf('visibleImpressions');
        if (vi >= 0) order[vi] = 'impressions';
        else order.push('impressions');
        hasImpressions = true;
      }
      else if (hl === 'ecpm') order.push('ecpm');
      else if (hl.includes('клик')) order.push('clicks');
      else if (hl.includes('ctr')) order.push('ctr');
    }
    // Если visibleImpressions остался (нет "Показы") — считаем как impressions
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'visibleImpressions') order[i] = 'impressions';
    }
    return order;
  }

  // ── Парсинг одного виджета (ПОСЛЕ скролла) ──

  function parseWidget(widgetEl) {
    const linkEl = widgetEl.querySelector('[data-testid="Link"]');
    const appName = getText(linkEl) || 'Unknown App';

    const headerEls = widgetEl.querySelectorAll('[data-testid^="HeaderCell"]');
    const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
    const metricOrder = buildMetricOrder(headerTexts);
    const hasBlockType = headerTexts.some(h => h.toLowerCase() === 'тип блока');
    const fieldsPerRow = 1 + (hasBlockType ? 1 : 0) + metricOrder.length;

    log('parseWidget', `${appName} | metrics: ${JSON.stringify(metricOrder)} | fieldsPerRow: ${fieldsPerRow}`);

    const cellEls = widgetEl.querySelectorAll('[data-testid="Cell"]');
    const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

    if (cellTexts.length === 0) {
      return { appName, rows: [] };
    }

    log('parseWidget', `${appName}: ${cellTexts.length} cells total`);

    // Строгий разбор: каждая строка = fieldsPerRow ячеек
    const rows = [];
    let i = 0;

    while (i < cellTexts.length) {
      const date = parseDate(cellTexts[i]);
      if (!date) { i++; continue; }

      // Проверяем что хватает ячеек на полную строку
      if (i + fieldsPerRow > cellTexts.length) break;

      const row = { date };
      let offset = 1;

      if (hasBlockType) {
        row.blockType = cellTexts[i + offset] || '';
        offset = 2;
      }

      // Читаем метрики строго по порядку
      for (let mi = 0; mi < metricOrder.length; mi++) {
        const val = cellTexts[i + offset + mi];
        const metric = metricOrder[mi];
        if (metric === 'revenue') row.revenue = parseMoney(val);
        else if (metric === 'impressions' || metric === 'clicks') row[metric] = parseNum(val);
        else if (metric === 'ecpm') row.ecpm = parseMoney(val);
        else row[metric] = val; // CTR и прочие — как текст
      }

      rows.push(row);
      i += fieldsPerRow;
    }

    log('parseWidget', `${appName}: ${rows.length} rows parsed`);
    return { appName, rows };
  }

  // ── Агрегация по дате+тип блока, с отдельными метриками ──

  function buildMetrics(rows, metricOrder) {
    // impressions, revenue, clicks, ecpm — каждая { date: value }
    const metrics = {};
    for (const metric of ['impressions', 'revenue', 'clicks', 'ecpm']) {
      if (metricOrder.includes(metric)) {
        metrics[metric] = {};
      }
    }

    for (const row of rows) {
      for (const metric of Object.keys(metrics)) {
        const val = row[metric];
        if (val !== undefined) {
          metrics[metric][row.date] = val;
        }
      }
    }

    return metrics;
  }

  // ── Главный сборщик ──

  async function collectData() {
    try {
      log('init', window.location.href);

      const widgets = document.querySelectorAll('[data-testid="piWidgetRenderer.WidgetStatisticsTable"]');

      if (widgets.length === 0) {
        throw new Error('Таблицы статистики не найдены на странице.');
      }

      log('foundWidgets', `${widgets.length} виджетов`);

      const allApps = [];

      for (let wi = 0; wi < widgets.length; wi++) {
        const widget = widgets[wi];

        // Скроллим таблицу чтобы подгрузить все строки
        log('scrollWidget', `widget ${wi}...`);
        await scrollTableToEnd(widget);

        // Читаем заголовки чтобы знать метрики
        const headerEls = widget.querySelectorAll('[data-testid^="HeaderCell"]');
        const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
        const metricOrder = buildMetricOrder(headerTexts);

        const parsed = parseWidget(widget);
        const metrics = buildMetrics(parsed.rows, metricOrder);

        allApps.push({
          appId: parsed.appName,
          name: parsed.appName,
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