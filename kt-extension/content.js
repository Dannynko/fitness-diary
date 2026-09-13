if (document.getElementById('ktImportBtn')) {
  document.documentElement.setAttribute('data-kt-extension', 'true');

  window.addEventListener('kt-sync-request', () => {
    chrome.runtime.sendMessage({action: 'fetchKtDiary'}, (response) => {
      window.dispatchEvent(new CustomEvent('kt-sync-response', {detail: response}));
    });
  });
}
