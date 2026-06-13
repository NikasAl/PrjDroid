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

  // ── Определить порядок метрик по заголовкам виджета ──
  // Заголовки двойные: "Вознаграждение" | "276,43 ₽" | "Показы" | "6 325" | ...
  // Нам нужны только текстовые (суммы пропускаем)

  function buildMetricOrder(headerTexts) {
    const order = []; // массив имён метрик в порядке их следования в ячейках
    for (const h of headerTexts) {
      const hl = h.toLowerCase();
      if (hl === 'дата' || hl === 'тип блока' || hl === 'итого' || hl === '') continue;
      // Пропускаем ячейки-суммы (содержат цифры)
      if (/\d/.test(h)) continue;
      if (hl.includes('вознаграждение')) order.push('revenue');
      else if (hl.includes('видимые показы')) order.push('visibleImpressions');
      else if (hl === 'показы') order.push('impressions');
      else if (hl === 'ecpm') order.push('ecpm');
      else if (hl.includes('клик')) order.push('clicks');
      else if (hl.includes('ctr')) order.push('ctr');
    }
    return order;
  }

  // ── Парсинг одного виджета ──

  function parseWidget(widgetEl) {
    const linkEl = widgetEl.querySelector('[data-testid="Link"]');
    const appName = getText(linkEl) || 'Unknown App';

    const headerEls = widgetEl.querySelectorAll('[data-testid^="HeaderCell"]');
    const headerTexts = Array.from(headerEls).map(getText).filter(Boolean);
    const metricOrder = buildMetricOrder(headerTexts);
    const hasBlockType = headerTexts.some(h => h.toLowerCase() === 'тип блока');

    log('parseWidget', `${appName} | metricOrder: ${JSON.stringify(metricOrder)} | hasBlockType: ${hasBlockType}`);

    // Все ячейки
    const cellEls = widgetEl.querySelectorAll('[data-testid="Cell"]');
    const cellTexts = Array.from(cellEls).map(getText).filter(Boolean);

    if (cellTexts.length === 0) {
      return { appName, rows: [] };
    }

    // Разбиваем ячейки на строки по датам
    // Каждая строка: [Дата, Тип блока?, метрика1, метрика2, ...]
    const rows = [];
    let i = 0;

    while (i < cellTexts.length) {
      const date = parseDate(cellTexts[i]);
      if (!date) { i++; continue; }

      // Собираем все строки с этой датой (может быть несколько типов блоков)
      while (i < cellTexts.length && parseDate(cellTexts[i]) === date) {
        const row = { date };

        let offset = 1; // после даты
        if (hasBlockType && i + offset < cellTexts.length && !parseDate(cellTexts[i + offset])) {
          row.blockType = cellTexts[i + offset];
          offset = 2;
        }

        // Читаем метрики в порядке из заголовков
        for (let mi = 0; mi < metricOrder.length && (i + offset + mi) < cellTexts.length; mi++) {
          const val = cellTexts[i + offset + mi];
          // Если наткнулись на следующую дату — стоп
          if (parseDate(val)) break;

          const metric = metricOrder[mi];
          if (metric === 'revenue') row.revenue = parseMoney(val);
          else if (metric === 'impressions' || metric === 'visibleImpressions' || metric === 'clicks') {
            row[metric] = parseNum(val);
          }
          // eCPM и CTR не сохраняем — они производные
        }

        rows.push(row);
        i += offset + metricOrder.length;
      }
    }

    log('parseWidget', `${appName}: ${rows.length} rows`);
    return { appName, rows };
  }

  // ── Агрегация по дате (складываем разные типы блоков) ──

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

      const widgets = document.querySelectorAll('[data-testid="piWidgetRenderer.WidgetStatisticsTable"]');

      if (widgets.length === 0) {
        throw new Error('Таблицы статистики не найдены на странице.');
      }

      log('foundWidgets', `${widgets.length} виджетов`);

      const allApps = [];

      for (const widget of widgets) {
        const parsed = parseWidget(widget);
        const aggregated = aggregateByDate(parsed.rows);

        allApps.push({
          appId: parsed.appName,
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