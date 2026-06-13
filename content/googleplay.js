// content/googleplay.js — Заглушка парсера Google Play Console
// Будет реализован после получения HTML-кода страницы статистики Google Play Console

(function () {
  'use strict';

  function extractAppId() {
    // Пример: /console/u/0/developers/1234567890/app/9876543210/vitals/stats
    const m = window.location.pathname.match(/\/app\/(\d+)\//);
    return m ? m[1] : window.location.pathname;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'collectGooglePlay') {
      // TODO: реализовать парсинг после получения HTML страницы GP Console
      sendResponse({
        success: false,
        error: 'Парсер Google Play Console ещё не реализован. Пришлите HTML-код страницы статистики.',
        appId: extractAppId(),
        platform: 'googleplay',
      });
      return false;
    }

    if (message.action === 'ping') {
      sendResponse({
        alive: true,
        platform: 'googleplay',
        appId: extractAppId(),
        url: window.location.href,
      });
      return false;
    }
  });
})();