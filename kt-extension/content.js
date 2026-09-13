if (document.getElementById('ktImportBtn')) {
  document.documentElement.setAttribute('data-kt-extension', 'true');

  // Manual trigger from the app
  window.addEventListener('kt-sync-request', () => {
    chrome.runtime.sendMessage({action: 'fetchKtDiary'}, (response) => {
      window.dispatchEvent(new CustomEvent('kt-sync-response', {detail: response}));
    });
  });

  // Auto-sync when Fitness Diary page opens
  chrome.runtime.sendMessage({action: 'autoSync'});
}
