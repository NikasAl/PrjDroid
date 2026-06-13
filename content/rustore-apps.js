// content/rustore-apps.js — Парсер списка приложений RuStore
// Запускается на https://console.rustore.ru/apps

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.action === 'scanRuStoreApps') {
      const rows = document.querySelectorAll('a[data-testid="apps-appsListItem-row"]');
      const apps = Array.from(rows)
        .map((row) => {
          const href = row.getAttribute('href') || '';
          const match = href.match(/\/apps\/(\d+)/);
          const appId = match ? match[1] : null;
          if (!appId) return null;

          // Имя — из data-testid="XXXX-appName"
          const nameEl = document.querySelector(`[data-testid="${appId}-appName"]`);
          const name = nameEl ? nameEl.textContent.trim() : row.textContent.trim().split('\n')[0].trim();

          return {
            appId,
            name: name || `App ${appId}`,
            platform: 'rustore',
            url: `https://console.rustore.ru/apps/${appId}/statistics`,
          };
        })
        .filter(Boolean);

      sendResponse({ success: true, apps });
      return false;
    }
  });
})();