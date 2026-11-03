// Offscreen document (reason CLIPBOARD). navigator.clipboard needs focus, which an
// offscreen document never has, so overwrite the clipboard via execCommand('copy').

function clearClipboard() {
  const ta = document.getElementById('clip');
  // The copy handler forces an empty string even when the selection is empty.
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    ta.value = '';
    ta.focus();
    ta.select();
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (msg.type === 'offscreen/clearClipboard') sendResponse({ ok: clearClipboard() });
  return false;
});
