// content/googleplay-apps.js — Парсер закреплённых приложений Google Play Console
// Запускается на https://play.google.com/console/* (вкл. /developers/*/app-list)
//
// Извлекает из секции «Закреплённые приложения»:
//   - Название, package ID, статус, дату обновления
//   - Пользователи (30 дн), источники трафика, рейтинг, валовой доход
//   - URL иконки

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
   *  Константы фильтрации текстовых узлов
   * ═══════════════════════════════════════════════════════════ */

  const ICON_TEXTS = new Set([
    'help', 'keep', 'arrow_right_alt', 'arrow_left_alt',
    'star', 'brightness_1', 'expand_less', 'expand_more',
  ]);

  const METRIC_LABELS = new Set([
    'Пользователи, у которых установлено приложение',
    'Источники трафика',
    'Оценка в Google Play',
    'Валовой доход (USD)',
    'Валовой доход',
  ]);

  const SKIP_TEXTS = new Set([
    'Закрепленные приложения',
    'Управлять закрепленными приложениями',
    'Скрыть',
    'Показать',
    'Развернуть',
    'Свернуть',
    'по сравнению с предыдущими 30 днями',
  ]);

  /* ═══════════════════════════════════════════════════════════
   *  Утилиты
   * ═══════════════════════════════════════════════════════════ */

  /** Собрать все текстовые узлы из поддерева, отфильтровав шум */
  function collectTextNodes(root) {
    const result = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t && !ICON_TEXTS.has(t) && !SKIP_TEXTS.has(t)) {
        result.push(t);
      }
    }
    return result;
  }

  /** Проверяет, похож ли текст на Android package ID (com.example.app или ru.astro) */
  function isPackageId(text) {
    return /^[a-z]{2,}(\.[a-z0-9]+)+$/.test(text) && text.length < 100;
  }

  /** Проверяет, является ли текст процентом изменения (2,7 %, -11,1 %) */
  function isChangePercent(text) {
    return /^-?[\d]+(,[\d]+)?\s*%$/.test(text);
  }

  /* ═══════════════════════════════════════════════════════════
   *  Парсер закреплённых приложений
   *
   *  Структура текстовых узлов внутри [debug-id="pinned-apps-section"]
   *  (после фильтрации шума):
   *
   *    <имя приложения>
   *    <package.id>
   *    Последнее обновление: DD MMM YYYY г.
   *    Рабочая версия | Удалено Google
   *    Пользователи, у которых установлено приложение
   *    <значение>
   *    <изменение %>
   *    Источники трафика
   *    <значение>
   *    <изменение %>
   *    Оценка в Google Play
   *    <рейтинг>
   *    Валовой доход (USD) | Валовой доход
   *    <значение | ->
   *    [<изменение %>]
   *    --- следующий блок ---
   * ═══════════════════════════════════════════════════════════ */

  function parsePinnedApps() {
    const section = document.querySelector('[debug-id="pinned-apps-section"]');
    if (!section) return [];

    const texts = collectTextNodes(section);

    // Иконки — img-теги внутри секции, по порядку следования приложений
    const icons = Array.from(
      section.querySelectorAll(
        'img[src*="googleusercontent.com"], img[src*="ggpht.com"]'
      )
    ).map((img) => img.src);

    const apps = [];
    let app = null;
    let nextMetric = null;

    function finishApp() {
      if (app && app.name) {
        app.iconUrl = icons[apps.length] || null;
        apps.push(app);
      }
      app = null;
      nextMetric = null;
    }

    for (const text of texts) {
      /* ── Последнее обновление ── */
      if (text.startsWith('Последнее обновление:')) {
        if (app) app.lastUpdate = text;
        continue;
      }

      /* ── Статус ── */
      if (text === 'Рабочая версия' || text.startsWith('Удалено')) {
        if (app) app.status = text;
        continue;
      }

      /* ── Package ID ── */
      if (isPackageId(text)) {
        if (app) app.packageId = text;
        continue;
      }

      /* ── Лейбл метрики → запоминаем, какое поле следующее ── */
      if (METRIC_LABELS.has(text)) {
        nextMetric = text;
        continue;
      }

      /* ── Значение метрики (идёт сразу после лейбла) ── */
      if (nextMetric && app) {
        const label = nextMetric;
        nextMetric = null;
        app.metrics = app.metrics || {};

        let key;
        if (label.includes('Пользователи')) key = 'users';
        else if (label.includes('Источники')) key = 'trafficSources';
        else if (label.includes('Оценка')) key = 'rating';
        else if (label.includes('доход')) key = 'revenue';

        app.metrics[key] = { value: text, change: null };
        continue;
      }

      /* ── Изменение в % (после значения для users / traffic / revenue) ── */
      if (app?.metrics) {
        const keys = Object.keys(app.metrics);
        const lastKey = keys[keys.length - 1];
        if (
          lastKey &&
          app.metrics[lastKey].change === null &&
          isChangePercent(text)
        ) {
          app.metrics[lastKey].change = text;
          continue;
        }
      }

      /* ── Всё остальное — имя следующего приложения ── */
      // Текущее приложение завершено, если у него уже есть packageId или метрики
      if (app && (app.packageId || (app.metrics && Object.keys(app.metrics).length > 0))) {
        finishApp();
      }

      app = app || { name: '', metrics: {} };
      if (!app.name) app.name = text;
    }

    finishApp();
    return apps;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Обработчик сообщений от service-worker
   * ═══════════════════════════════════════════════════════════ */

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.action === 'scanGooglePlayApps') {
      try {
        const apps = parsePinnedApps();

        // Developer account ID из URL
        const devMatch = window.location.pathname.match(/\/developers\/(\d+)\//);
        const developerId = devMatch ? devMatch[1] : null;

        sendResponse({
          success: true,
          apps: apps.map((a) => ({
            appId: a.packageId || null,
            name: a.name,
            platform: 'googleplay',
            url: '',
            googlePlayUrl: a.packageId
              ? 'https://play.google.com/store/apps/details?id=' + a.packageId
              : '',
            status: a.status || null,
            lastUpdate: a.lastUpdate || null,
            iconUrl: a.iconUrl || null,
            overview: a.metrics || null,
          })),
          developerId,
        });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return false; // синхронный ответ
    }
  });
})();