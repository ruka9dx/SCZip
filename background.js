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
    title: "SCZipでダウンロード",
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

  const urlResponse = await new Promise(async (resolve) => {
    try {
      let CHUNK_SIZE = 512 * 1024;
      try {
        const stored = await new Promise((r) => chrome.storage.sync.get({ chunkMode: 'normal', customSize: 512, customUnit: 'KB' }, r));
        if (stored.chunkMode === 'safe') CHUNK_SIZE = 128 * 1024;
        else if (stored.chunkMode === 'fast') CHUNK_SIZE = 2048 * 1024;
        else if (stored.chunkMode === 'custom') {
          const n = Number(stored.customSize) || 512;
          const unit = (stored.customUnit || 'KB').toUpperCase();
          CHUNK_SIZE = unit === 'MB' ? n * 1024 * 1024 : n * 1024;
        }
      } catch (e) {}
      const uint8 = new Uint8Array(buffer);
      const total = Math.ceil(uint8.length / CHUNK_SIZE);
      const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

      for (let i = 0; i < total; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, uint8.length);
        const part = Array.from(uint8.subarray(start, end));
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
        resolve({ ok: false, message: `保存に失敗しました` });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

async function convertArtworkBlob(blob, format) {
  if (!format || format === 'jpg') return blob;
  if (!self.createImageBitmap || typeof OffscreenCanvas === 'undefined') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) {
    return blob;
  }
}

async function downloadArtworkOnly(track, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ saveAs: false, artworkFormat: 'jpg', saveDirectory: '' }, r));
  const total = 2;
  reportProgress(tabId, "画像を取得中...", 1, total);
  if (!track.artworkUrl) return { ok: false, message: "ジャケット画像が見つかりませんでした" };
  const res = await fetch(track.artworkUrl);
  if (!res.ok) return { ok: false, message: `画像の取得に失敗しました` };
  let blob = await res.blob();
  if (prefs.artworkFormat === 'png') blob = await convertArtworkBlob(blob, 'png');

  reportProgress(tabId, "保存中...", 2, total);
  const safeName = safeFileName(track.title);
  const extension = prefs.artworkFormat === 'png' ? 'png' : 'jpg';
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";
  
  const result = await triggerDownload(blob, `${folderPrefix}${safeName}_artwork.${extension}`, tabId, !!prefs.saveAs);
  return result.ok ? { ok: true, message: "ジャケット画像を保存しました" } : result;
}

async function resolveStreamAudioUrl(streamUrl) {
  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`ストリーミング情報の取得に失敗しました`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data && data.url) return data.url;
    throw new Error('ストリーミングURLから音声URLが取得できませんでした');
  }
  return streamUrl;
}

async function getDownloadRedirectUri(trackId, clientId, headers) {
  const downloadUrl = `https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${encodeURIComponent(clientId)}`;
  const res = await fetch(downloadUrl, { headers });
  if (!res.ok) throw new Error(`ダウンロードリンクの取得に失敗しました`);
  const data = await res.json();
  if (!data.redirectUri) throw new Error(`redirectUriが含まれていません`);
  return data.redirectUri;
}

async function fetchHlsAudio(m3u8Url, headers, tabId) {
  let res = await fetch(m3u8Url, { headers });
  let text = await res.text();

  let lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.some(l => l.endsWith('.m3u8'))) {
    let subUrl = lines.find(l => !l.startsWith('#'));
    if (!subUrl.startsWith('http')) {
      subUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + subUrl;
    }
    res = await fetch(subUrl, { headers });
    text = await res.text();
    lines = text.split('\n').map(l => l.trim()).filter(l => l);
  }

  let initUrl = null;
  const mapLine = lines.find(l => l.startsWith('#EXT-X-MAP:'));
  if (mapLine) {
    const match = mapLine.match(/URI="([^"]+)"/);
    if (match) {
      initUrl = match[1];
      if (!initUrl.startsWith('http')) {
        initUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + initUrl;
      }
    }
  }

  const chunkUrls = lines.filter(l => !l.startsWith('#'));
  if (chunkUrls.length === 0) throw new Error('HLSプレイリストから音声URLを抽出できませんでした');

  const chunks = [];
  if (initUrl) {
    reportProgress(tabId, `ヘッダー情報を取得中...`, 0, chunkUrls.length);
    const initRes = await fetch(initUrl, { headers });
    if (!initRes.ok) throw new Error(`Initデータの取得に失敗しました`);
    chunks.push(new Uint8Array(await initRes.arrayBuffer()));
  }

  for (let i = 0; i < chunkUrls.length; i++) {
    if (i % 5 === 0 || i === chunkUrls.length - 1) {
      reportProgress(tabId, `分割データを結合中... (${i + 1}/${chunkUrls.length})`, i + 1, chunkUrls.length);
    }
    let chunkUrl = chunkUrls[i];
    if (!chunkUrl.startsWith('http')) {
      chunkUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + chunkUrl;
    }
    const chunkRes = await fetch(chunkUrl, { headers });
    if (!chunkRes.ok) throw new Error(`チャンクの取得に失敗しました`);
    chunks.push(new Uint8Array(await chunkRes.arrayBuffer()));
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const audioData = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    audioData.set(c, offset);
    offset += c.length;
  }
  return audioData;
}

async function downloadPlaylistZip(playlist, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ includeArtwork: true, saveAs: false, chunkMode: 'normal', artworkFormat: 'jpg', saveDirectory: '' }, r));
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (tracks.length === 0) return { ok: false, message: "プレイリストにダウンロード可能な曲がありませんでした" };

  const totalTracks = tracks.length;
  const zip = new JSZip();
  const playlistName = safeFileName(playlist.title || 'playlist');
  const folder = zip.folder(playlistName);
  const failed = [];

  reportProgress(tabId, `プレイリストを処理しています...`, 1, totalTracks);
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    reportProgress(tabId, `トラック ${i + 1}/${totalTracks} を処理中...`, i + 1, totalTracks);
    try {
      let audioFetchUrl;
      if (track.streamUrl) audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl);
      else audioFetchUrl = await getDownloadRedirectUri(track.id, track.clientId, headers);

      let audioData, audioExt;
      if (audioFetchUrl.includes('.m3u8')) {
        audioData = await fetchHlsAudio(audioFetchUrl, headers, tabId);
        audioExt = 'm4a';
      } else {
        const audioRes = await fetch(audioFetchUrl, { headers });
        if (!audioRes.ok) throw new Error(`音声ファイルの取得に失敗しました`);
        const audioBlob = await audioRes.blob();
        const audioContentType = audioRes.headers.get('content-type') || '';
        audioData = new Uint8Array(await audioBlob.arrayBuffer());
        if (audioFetchUrl.includes('.wav') || audioContentType.includes('wav')) audioExt = 'wav';
        else if (audioFetchUrl.includes('.m4a') || audioContentType.includes('m4a') || audioContentType.includes('mp4')) audioExt = 'm4a';
        else if (audioFetchUrl.includes('.ogg') || audioContentType.includes('ogg')) audioExt = 'ogg';
        else if (audioContentType.includes('flac')) audioExt = 'flac';
        else audioExt = 'mp3';
      }

      let artworkBlob = null;
      if (prefs.includeArtwork && track.artworkUrl) {
        const artworkRes = await fetch(track.artworkUrl);
        if (artworkRes.ok) {
          artworkBlob = await artworkRes.blob();
          if (prefs.artworkFormat === 'png') artworkBlob = await convertArtworkBlob(artworkBlob, 'png');
        }
      }

      const trackSafe = safeFileName(track.title || `track-${i + 1}`);
      const trackFolderName = `${String(i + 1).padStart(2, '0')}. ${trackSafe}`;
      const trackFolder = folder.folder(trackFolderName);
      trackFolder.file(`${trackSafe}.${audioExt}`, audioData);

      if (artworkBlob) {
        const artData = new Uint8Array(await artworkBlob.arrayBuffer());
        const artworkExt = (artworkBlob.type || '').includes('png') ? 'png' : 'jpg';
        trackFolder.file(`${trackSafe}_artwork.${artworkExt}`, artData);
      }
    } catch (e) {
      failed.push({ title: track.title || `track-${i + 1}`, reason: e.message });
    }
  }

  if (failed.length === totalTracks) return { ok: false, message: '全トラックの取得に失敗しました' };
  
  reportProgress(tabId, 'ZIPを生成中...', totalTracks, totalTracks);
  const arrayBuf = await zip.generateAsync({ type: 'arraybuffer' });
  const content = new Blob([new Uint8Array(arrayBuf)], { type: 'application/zip' });
  
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";
  const finalFileName = `${folderPrefix}${playlistName}.zip`;

  reportProgress(tabId, '保存中...', totalTracks, totalTracks);
  const result = await triggerDownload(content, finalFileName, tabId, !!prefs.saveAs);
  return result.ok ? { ok: true, message: `完了${failed.length > 0 ? '（一部失敗）' : ''}` } : result;
}

async function downloadZip(track, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ 
    includeArtwork: true, 
    saveAs: false, 
    chunkMode: 'normal', 
    artworkFormat: 'jpg',
    downloadMode: 'zip',
    saveDirectory: ''
  }, r));

  const total = prefs.downloadMode === 'audioOnly' ? 4 : 6;
  reportProgress(tabId, "認証情報を確認中...", 1, total);
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  let audioFetchUrl;
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
    if (!downloadInfoRes.ok) return { ok: false, message: `ダウンロードリンクの取得に失敗しました` };
    const downloadInfo = await downloadInfoRes.json();
    if (!downloadInfo.redirectUri) return { ok: false, message: `redirectUriが応答に含まれていません` };
    audioFetchUrl = downloadInfo.redirectUri;
  }

  reportProgress(tabId, "音声ファイルを取得中...", 3, total);
  let audioData;
  let audioExt = 'mp3';

  if (audioFetchUrl.includes('.m3u8')) {
    audioData = await fetchHlsAudio(audioFetchUrl, headers, tabId);
    audioExt = audioFetchUrl.includes('aac') ? 'm4a' : 'm4a'; 
  } else {
    const audioRes = await fetch(audioFetchUrl, { headers });
    if (!audioRes.ok) return { ok: false, message: `音声ファイルの取得に失敗しました` };
    const audioBlob = await audioRes.blob();
    const audioContentType = audioRes.headers.get('content-type') || '';
    audioData = new Uint8Array(await audioBlob.arrayBuffer());

    if (audioFetchUrl.includes('.wav') || audioContentType.includes('wav')) audioExt = 'wav';
    else if (audioFetchUrl.includes('.m4a') || audioContentType.includes('m4a') || audioContentType.includes('mp4')) audioExt = 'm4a';
    else if (audioFetchUrl.includes('.ogg') || audioContentType.includes('ogg')) audioExt = 'ogg';
    else if (audioContentType.includes('flac')) audioExt = 'flac';
  }

  const safeName = safeFileName(track.title);
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";

  // ★ 音声のみモードの分岐
  if (prefs.downloadMode === 'audioOnly') {
    reportProgress(tabId, "保存中...", 4, total);
    let mimeType = 'audio/mpeg';
    if (audioExt === 'm4a') mimeType = 'audio/mp4';
    else if (audioExt === 'wav') mimeType = 'audio/wav';
    else if (audioExt === 'ogg') mimeType = 'audio/ogg';
    else if (audioExt === 'flac') mimeType = 'audio/flac';
    
    const content = new Blob([audioData], { type: mimeType });
    const finalFileName = `${folderPrefix}${safeName}.${audioExt}`;
    
    const result = await triggerDownload(content, finalFileName, tabId, !!prefs.saveAs);
    return result.ok ? { ok: true, message: "音声ファイルの保存が完了しました" } : result;
  }

  // ★ 今まで通り（ZIP化）モードの分岐
  reportProgress(tabId, "ジャケット画像を取得中...", 4, total);
  let artworkBlob = null;
  if (prefs.includeArtwork && track.artworkUrl) {
    const artworkRes = await fetch(track.artworkUrl);
    if (artworkRes.ok) {
      artworkBlob = await artworkRes.blob();
      if (prefs.artworkFormat === 'png') artworkBlob = await convertArtworkBlob(artworkBlob, 'png');
    }
  }

  reportProgress(tabId, "ZIPを作成中...", 5, total);
  const zip = new JSZip();
  const folder = zip.folder(safeName);
  
  folder.file(`${safeName}.${audioExt}`, audioData);
  let artworkExt = 'jpg';
  if (artworkBlob) {
    const artData = new Uint8Array(await artworkBlob.arrayBuffer());
    if ((artworkBlob.type || '').includes('png')) artworkExt = 'png';
    folder.file(`${safeName}_artwork.${artworkExt}`, artData);
  }

  const arrayBuf = await zip.generateAsync({ type: "arraybuffer" });
  const content = new Blob([new Uint8Array(arrayBuf)], { type: "application/zip" });
  const finalFileName = `${folderPrefix}${safeName}.zip`;

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
            sendResponse({ ok: false, message: `タブへの送信に失敗しました` });
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
  if (msg.action === "downloadPlaylistZip") {
    const tabId = sender.tab && sender.tab.id;
    downloadPlaylistZip(msg.playlist, tabId)
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