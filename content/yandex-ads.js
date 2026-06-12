// content/yandex-ads.js — Заглушка парсера Yandex Advertising Network (РСЯ)
// Будет реализован после получения HTML-кода страницы статистики РСЯ

(function () {
  'use strict';

  function extractAppId() {
    // Для РСЯ ID приложения может быть в URL или в заголовке страницы
    // Будет уточнено после получения HTML
    const m = window.location.pathname.match(/\/(\d+)\//);
    return m ? m[1] : window.location.pathname.split('/').filter(Boolean).pop() || 'unknown';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'collectYandexAds') {
      // TODO: реализовать парсинг после получения HTML страницы РСЯ
      sendResponse({
        success: false,
        error: 'Парсер РСЯ (Yandex Ads) ещё не реализован. Пришлите HTML-код страницы статистики.',
        appId: extractAppId(),
        platform: 'rsya',
      });
      return false;
    }

    if (message.action === 'ping') {
      sendResponse({
        alive: true,
        platform: 'rsya',
        appId: extractAppId(),
        url: window.location.href,
      });
      return false;
    }
  });
})();