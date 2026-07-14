chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "createBlobUrl") {
    try {
      const blob = new Blob([msg.buffer], { type: msg.mimeType });
      const url = URL.createObjectURL(blob);
      sendResponse({ ok: true, url });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      sendResponse({ ok: false, message: `Blob生成に失敗しました: ${e.message}` });
    }
    return true;
  }
});
