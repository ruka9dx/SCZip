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
    chrome.tabs.sendMessage(tab.id, { action: "extractZip" }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("context menu sendMessage failed:", chrome.runtime.lastError.message);
      }
    });
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

async function triggerDownload(blob, filename, tabId, saveAs = false) {
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    return { ok: false, message: `オフスクリーンドキュメントの作成に失敗しました: ${e.message}` };
  }
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || "application/octet-stream";

  // send as chunks because runtime message size may be limited
  const urlResponse = await new Promise(async (resolve) => {
    try {
      // Determine chunk size from prefs (safe/normal/fast)
      let CHUNK_SIZE = 512 * 1024; // default 512KB
      try {
        const stored = await new Promise((r) => chrome.storage.sync.get({ chunkMode: 'normal', customSize: 512, customUnit: 'KB' }, r));
        if (stored.chunkMode === 'safe') CHUNK_SIZE = 128 * 1024;
        else if (stored.chunkMode === 'fast') CHUNK_SIZE = 2048 * 1024;
        else if (stored.chunkMode === 'custom') {
          const n = Number(stored.customSize) || 512;
          const unit = (stored.customUnit || 'KB').toUpperCase();
          CHUNK_SIZE = unit === 'MB' ? n * 1024 * 1024 : n * 1024;
        } else CHUNK_SIZE = 512 * 1024;
      } catch (e) {}
      const uint8 = new Uint8Array(buffer);
      const total = Math.ceil(uint8.length / CHUNK_SIZE);
      const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      console.log("background: sending buffer to offscreen in chunks", { length: uint8.length, mimeType, id, total });

      for (let i = 0; i < total; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, uint8.length);
        const part = Array.from(uint8.subarray(start, end));
        // send chunk; await ack
        const res = await new Promise((r) => {
          chrome.runtime.sendMessage(
            { action: "createBlobUrlChunk", id, index: i, numbers: part, last: i === total - 1, mimeType },
            (response) => {
              if (chrome.runtime.lastError) {
                r({ ok: false, message: chrome.runtime.lastError.message });
                return;
              }
              r(response || { ok: false, message: "no response" });
            }
          );
        });
        if (!res.ok) {
          resolve({ ok: false, message: `オフスクリーン送信エラー: ${res.message}` });
          return;
        }
        if (i % 10 === 0) reportProgress(tabId, `チャンク送信中...(${i+1}/${total})`, i + 1, total);
        if (i === total - 1) {
          // final response should contain url
          resolve(res);
          return;
        }
      }
    } catch (e) {
      resolve({ ok: false, message: `チャンク送信中の例外: ${e.message}` });
    }
  });
  if (!urlResponse.ok) return urlResponse;

  return new Promise((resolve) => {
    chrome.downloads.download({ url: urlResponse.url, filename, saveAs: !!saveAs }, (downloadId) => {
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

async function convertArtworkBlob(blob, format) {
  if (!format || format === 'jpg') {
    return blob;
  }
  if (!self.createImageBitmap || typeof OffscreenCanvas === 'undefined') {
    return blob;
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const converted = await canvas.convertToBlob({ type: 'image/png' });
    return converted;
  } catch (e) {
    return blob;
  }
}

async function downloadArtworkOnly(track, tabId) {
  // respect user prefs for saveAs
  const prefs = await new Promise((r) => chrome.storage.sync.get({ saveAs: false, artworkFormat: 'jpg' }, r));
  const total = 2;
  reportProgress(tabId, "画像を取得中...", 1, total);
  const artworkUrl = track.artworkUrl;
  if (!artworkUrl) return { ok: false, message: "ジャケット画像が見つかりませんでした" };
  const res = await fetch(artworkUrl);
  if (!res.ok) return { ok: false, message: `画像の取得に失敗しました (status: ${res.status})` };
  let blob = await res.blob();
  if (prefs.artworkFormat === 'png') {
    blob = await convertArtworkBlob(blob, 'png');
  }

  reportProgress(tabId, "保存中...", 2, total);
  const safeName = safeFileName(track.title);
  const extension = prefs.artworkFormat === 'png' ? 'png' : 'jpg';
  const result = await triggerDownload(blob, `${safeName}_artwork.${extension}`, tabId, !!prefs.saveAs);
  return result.ok ? { ok: true, message: "ジャケット画像を保存しました" } : result;
}

async function resolveStreamAudioUrl(streamUrl) {
  const res = await fetch(streamUrl);
  if (!res.ok) {
    throw new Error(`ストリーミング情報の取得に失敗しました (status: ${res.status})`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data && data.url) return data.url;
    throw new Error('ストリーミングURLから音声URLが取得できませんでした');
  }
  return streamUrl;
}

async function downloadZip(track, tabId) {
  // load settings
  const prefs = await new Promise((r) => chrome.storage.sync.get({ includeArtwork: true, saveAs: false, chunkMode: 'normal', artworkFormat: 'jpg' }, r));

  const total = 6;
  reportProgress(tabId, "認証情報を確認中...", 1, total);
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  let audioFetchUrl;
  let downloadInfo = null;
  if (track.streamUrl) {
    reportProgress(tabId, "ストリーミング情報を取得中...", 2, total);
    try {
      audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl);
    } catch (e) {
      return { ok: false, message: e.message };
    }
  } else {
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
    downloadInfo = await downloadInfoRes.json();
    if (!downloadInfo.redirectUri) {
      return { ok: false, message: `redirectUriが応答に含まれていません: ${JSON.stringify(downloadInfo).slice(0, 200)}` };
    }
    audioFetchUrl = downloadInfo.redirectUri;
  }

  reportProgress(tabId, "音声ファイルを取得中...", 3, total);
  const audioRes = await fetch(audioFetchUrl, { headers });
  if (!audioRes.ok) return { ok: false, message: `音声ファイルの取得に失敗しました (status: ${audioRes.status})` };
  const audioBlob = await audioRes.blob();
  const audioContentType = audioRes.headers.get('content-type') || '';

  reportProgress(tabId, "ジャケット画像を取得中...", 4, total);
  let artworkBlob = null;
  if (prefs.includeArtwork && track.artworkUrl) {
    const artworkRes = await fetch(track.artworkUrl);
    if (artworkRes.ok) {
      artworkBlob = await artworkRes.blob();
      if (prefs.artworkFormat === 'png') {
        artworkBlob = await convertArtworkBlob(artworkBlob, 'png');
      }
    }
  }

  reportProgress(tabId, "ZIPを作成中...", 5, total);
  const safeName = safeFileName(track.title);
  let audioExt = 'mp3';
  if (audioFetchUrl.includes('.wav') || audioContentType.includes('wav')) {
    audioExt = 'wav';
  } else if (audioFetchUrl.includes('.m4a') || audioContentType.includes('m4a') || audioContentType.includes('mp4')) {
    audioExt = 'm4a';
  } else if (audioFetchUrl.includes('.ogg') || audioContentType.includes('ogg')) {
    audioExt = 'ogg';
  } else if (audioContentType.includes('flac')) {
    audioExt = 'flac';
  }

  const zip = new JSZip();
  // Create a folder inside the zip named after the track, and put files inside it
  const folder = zip.folder(safeName);
  // JSZip in service worker may not handle Blob reliably; convert to Uint8Array
  const audioData = new Uint8Array(await audioBlob.arrayBuffer());
  folder.file(`${safeName}.${audioExt}`, audioData);
  let artworkExt = 'jpg';
  if (artworkBlob) {
    const artData = new Uint8Array(await artworkBlob.arrayBuffer());
    const mime = artworkBlob.type || '';
    if (mime.includes('png')) artworkExt = 'png';
    folder.file(`${safeName}_artwork.${artworkExt}`, artData);
  }

  // 生成をArrayBufferで行い、明示的にZIPのMIMEを付与してからダウンロードへ渡す
  const arrayBuf = await zip.generateAsync({ type: "arraybuffer" });
  const content = new Blob([new Uint8Array(arrayBuf)], { type: "application/zip" });

  // determine final file name (use safeName)
  const finalFileName = `${safeFileName(safeName)}.zip`;

  reportProgress(tabId, "保存中...", 6, total);
  const result = await triggerDownload(content, finalFileName, tabId, !!prefs.saveAs);
  return result.ok ? { ok: true, message: "ZIP保存が完了しました" } : result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractZipFromPopup") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, message: `タブへの送信に失敗しました: ${chrome.runtime.lastError.message}` });
            return;
          }
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
