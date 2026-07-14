importScripts('jszip.min.js');

let capturedAuthHeader = null;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders &&
      details.requestHeaders.find((h) => h.name.toLowerCase() === "authorization");
    if (authHeader && authHeader.value) {
      capturedAuthHeader = authHeader.value;
      chrome.storage.session.set({ authHeader: authHeader.value });
    }
  },
  { urls: ["https://api-v2.soundcloud.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "extractSoundcloudZip",
    title: "ジャケット+音声をZIPで保存",
    contexts: ["page", "audio"],
    documentUrlPatterns: ["https://soundcloud.com/*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "extractSoundcloudZip" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: "extractZip" }).catch(() => {});
  }
});

function reportProgress(tabId, step, index, total) {
  const payload = { action: "progress", step, index, total };
  if (tabId) {
    chrome.tabs.sendMessage(tabId, payload).catch(() => {});
  }
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function getAuthHeader() {
  if (capturedAuthHeader) return capturedAuthHeader;
  const data = await chrome.storage.session.get("authHeader");
  return (data && data.authHeader) || null;
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts && contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Blobをobject URLに変換してダウンロードするため"
  });
}

async function triggerDownload(blob, filename) {
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    return { ok: false, message: `オフスクリーンドキュメントの作成に失敗しました: ${e.message}` };
  }
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || "application/octet-stream";

  const urlResponse = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "createBlobUrl", buffer, mimeType }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: `オフスクリーンへの送信に失敗しました: ${chrome.runtime.lastError.message}` });
        return;
      }
      resolve(response || { ok: false, message: "オフスクリーンドキュメントから応答がありませんでした" });
    });
  });
  if (!urlResponse.ok) return urlResponse;

  return new Promise((resolve) => {
    chrome.downloads.download({ url: urlResponse.url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        resolve({
          ok: false,
          message: `保存に失敗しました: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : "unknown"}`
        });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

async function downloadArtworkOnly(track, tabId) {
  const total = 2;
  reportProgress(tabId, "画像を取得中...", 1, total);
  const artworkUrl = track.artworkUrl;
  if (!artworkUrl) return { ok: false, message: "ジャケット画像が見つかりませんでした" };
  const res = await fetch(artworkUrl);
  if (!res.ok) return { ok: false, message: `画像の取得に失敗しました (status: ${res.status})` };
  const blob = await res.blob();

  reportProgress(tabId, "保存中...", 2, total);
  const safeName = safeFileName(track.title);
  const result = await triggerDownload(blob, `${safeName}_artwork.jpg`);
  return result.ok ? { ok: true, message: "ジャケット画像を保存しました" } : result;
}

async function downloadZip(track, tabId) {
  const total = 6;
  reportProgress(tabId, "認証情報を確認中...", 1, total);
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  reportProgress(tabId, "ダウンロードリンクを取得中...", 2, total);
  const downloadUrl = `https://api-v2.soundcloud.com/tracks/${track.id}/download?client_id=${track.clientId}`;
  const downloadInfoRes = await fetch(downloadUrl, { headers });
  if (!downloadInfoRes.ok) {
    const bodyText = await downloadInfoRes.text().catch(() => "");
    return {
      ok: false,
      message: `ダウンロードリンクの取得に失敗しました (status: ${downloadInfoRes.status}, auth: ${authHeader ? "あり" : "なし"}, body: ${bodyText.slice(0, 200)})`
    };
  }
  const downloadInfo = await downloadInfoRes.json();
  if (!downloadInfo.redirectUri) {
    return { ok: false, message: `redirectUriが応答に含まれていません: ${JSON.stringify(downloadInfo).slice(0, 200)}` };
  }

  reportProgress(tabId, "音声ファイルを取得中...", 3, total);
  const audioRes = await fetch(downloadInfo.redirectUri);
  if (!audioRes.ok) return { ok: false, message: `音声ファイルの取得に失敗しました (status: ${audioRes.status})` };
  const audioBlob = await audioRes.blob();

  reportProgress(tabId, "ジャケット画像を取得中...", 4, total);
  let artworkBlob = null;
  if (track.artworkUrl) {
    const artworkRes = await fetch(track.artworkUrl);
    if (artworkRes.ok) artworkBlob = await artworkRes.blob();
  }

  reportProgress(tabId, "ZIPを作成中...", 5, total);
  const safeName = safeFileName(track.title);
  const audioExt = downloadInfo.redirectUri.includes(".wav")
    ? "wav"
    : downloadInfo.redirectUri.includes(".m4a")
    ? "m4a"
    : "mp3";

  const zip = new JSZip();
  zip.file(`${safeName}.${audioExt}`, audioBlob);
  if (artworkBlob) zip.file(`${safeName}_artwork.jpg`, artworkBlob);

  const content = await zip.generateAsync({ type: "blob" });

  reportProgress(tabId, "保存中...", 6, total);
  const result = await triggerDownload(content, `${safeName}.zip`);
  return result.ok ? { ok: true, message: "ZIP保存が完了しました" } : result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractZipFromPopup") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ ok: false, message: "対象タブが見つかりませんでした" });
      }
    });
    return true;
  }
  if (msg.action === "downloadZip") {
    const tabId = sender.tab && sender.tab.id;
    downloadZip(msg.track, tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: `エラー: ${err.message}` }));
    return true;
  }
  if (msg.action === "downloadArtworkOnly") {
    const tabId = sender.tab && sender.tab.id;
    downloadArtworkOnly(msg.track, tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: `エラー: ${err.message}` }));
    return true;
  }
});
