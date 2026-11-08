function clearClipboard() {
  const ta = document.getElementById('clip');
  const forceEmptyClipboardOnCopy = (e) => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', forceEmptyClipboardOnCopy);
  try {
    ta.value = '';
    ta.focus();
    ta.select();
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', forceEmptyClipboardOnCopy);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (msg.type === 'offscreen/clearClipboard') sendResponse({ ok: clearClipboard() });
  return false;
});
