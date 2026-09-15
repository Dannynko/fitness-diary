if (document.getElementById('ktImportBtn') && chrome.runtime?.id) {
  document.documentElement.setAttribute('data-kt-extension', 'true');

  window.addEventListener('kt-sync-request', () => {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({action: 'fetchKtDiary'}, (response) => {
      window.dispatchEvent(new CustomEvent('kt-sync-response', {detail: response}));
    });
  });

  chrome.runtime.sendMessage({action: 'autoSync'});
}
