importScripts('jszip.min.js');

let capturedAuthHeader = null;

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders && details.requestHeaders.find((h) => h.name.toLowerCase() === "authorization");
    if (authHeader && authHeader.value) {
      capturedAuthHeader = authHeader.value;
      chrome.storage.session.set({ authHeader: authHeader.value });
    }
  },
  { urls: ["https://api-v2.soundcloud.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "extractSoundcloudZip", title: "SCZipでダウンロード", contexts: ["page", "audio"], documentUrlPatterns: ["https://soundcloud.com/*"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "extractSoundcloudZip" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: "extractZip" }, () => {});
  }
});

function reportProgress(tabId, step, index, total) {
  const payload = { action: "progress", step, index, total };
  if (tabId) chrome.tabs.sendMessage(tabId, payload).catch(() => {});
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function getAuthHeader() {
  if (capturedAuthHeader) return capturedAuthHeader;
  const data = await chrome.storage.session.get("authHeader");
  return (data && data.authHeader) || null;
}

function safeFileName(name) { return name.replace(/[\\/:*?"<>|]/g, "_"); }

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts && contexts.length > 0) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Blob作成とffmpegでの音声変換のため" });
}

async function convertToMp3ViaOffscreen(audioData, originalExt, tabId, title, artist) {
  await ensureOffscreenDocument();
  const CHUNK_SIZE = 512 * 1024;
  const totalChunks = Math.ceil(audioData.length / CHUNK_SIZE);
  const id = `convert-${Date.now()}`;

  reportProgress(tabId, "メタデータ(ID3)の付与・MP3処理中...", 0, totalChunks);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, audioData.length);
    const part = Array.from(audioData.subarray(start, end));
    const res = await new Promise((r) => {
      chrome.runtime.sendMessage(
        { action: "convertChunk", id, index: i, numbers: part, last: i === totalChunks - 1, originalExt, title, artist },
        r
      );
    });
    if (!res || !res.ok) throw new Error(res?.message || "変換処理に失敗しました");
    
    if (i % 3 === 0 || i === totalChunks - 1) reportProgress(tabId, `MP3処理中... (${i + 1}/${totalChunks})`, i + 1, totalChunks);
    if (i === totalChunks - 1) {
      const convertedRes = await fetch(res.url);
      return new Uint8Array(await (await convertedRes.blob()).arrayBuffer());
    }
  }
}

async function triggerDownload(blob, filename, tabId, saveAs = false) {
  try { await ensureOffscreenDocument(); } catch (e) { return { ok: false, message: `オフスクリーンの作成に失敗` }; }
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || "application/octet-stream";

  const urlResponse = await new Promise(async (resolve) => {
    try {
      let CHUNK_SIZE = 512 * 1024;
      try {
        const stored = await new Promise((r) => chrome.storage.sync.get({ chunkMode: 'normal', customSize: 512, customUnit: 'KB' }, r));
        if (stored.chunkMode === 'safe') CHUNK_SIZE = 128 * 1024;
        else if (stored.chunkMode === 'fast') CHUNK_SIZE = 2048 * 1024;
        else if (stored.chunkMode === 'custom') CHUNK_SIZE = (stored.customUnit === 'MB' ? (Number(stored.customSize)||512) * 1024 * 1024 : (Number(stored.customSize)||512) * 1024);
      } catch (e) {}
      const uint8 = new Uint8Array(buffer);
      const total = Math.ceil(uint8.length / CHUNK_SIZE);
      const id = `dl-${Date.now()}`;

      for (let i = 0; i < total; i++) {
        const part = Array.from(uint8.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, uint8.length)));
        const res = await new Promise((r) => {
          chrome.runtime.sendMessage({ action: "createBlobUrlChunk", id, index: i, numbers: part, last: i === total - 1, mimeType }, (response) => r(chrome.runtime.lastError ? { ok: false, message: chrome.runtime.lastError.message } : (response || { ok: false })));
        });
        if (!res.ok) return resolve({ ok: false, message: `送信エラー: ${res.message}` });
        if (i % 10 === 0) reportProgress(tabId, `保存処理中...(${i+1}/${total})`, i + 1, total);
        if (i === total - 1) return resolve(res);
      }
    } catch (e) { resolve({ ok: false, message: e.message }); }
  });
  if (!urlResponse.ok) return urlResponse;

  return new Promise((resolve) => chrome.downloads.download({ url: urlResponse.url, filename, saveAs: !!saveAs }, (downloadId) => resolve({ ok: !!downloadId, message: (chrome.runtime.lastError || !downloadId) ? `保存に失敗しました` : `保存が完了しました` })));
}

async function convertArtworkBlob(blob, format) {
  if (!format || format === 'jpg' || !self.createImageBitmap || typeof OffscreenCanvas === 'undefined') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) { return blob; }
}

async function downloadArtworkOnly(track, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ saveAs: false, artworkFormat: 'jpg', saveDirectory: '' }, r));
  reportProgress(tabId, "画像を取得中...", 1, 2);
  if (!track.artworkUrl) return { ok: false, message: "ジャケット画像が見つかりませんでした" };
  let blob = await (await fetch(track.artworkUrl)).blob();
  if (prefs.artworkFormat === 'png') blob = await convertArtworkBlob(blob, 'png');

  reportProgress(tabId, "保存中...", 2, 2);
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";
  const result = await triggerDownload(blob, `${folderPrefix}${safeFileName(track.title)}_artwork.${prefs.artworkFormat === 'png' ? 'png' : 'jpg'}`, tabId, !!prefs.saveAs);
  return result.ok ? { ok: true, message: "ジャケット画像を保存しました" } : result;
}

async function resolveStreamAudioUrl(streamUrl) {
  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`ストリーミング情報の取得に失敗しました`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data?.url) return data.url;
    throw new Error('ストリーミングURLから音声URLが取得できませんでした');
  }
  return streamUrl;
}

// ★エラーをスローしてフォールバックに渡せるように修正
async function getDownloadRedirectUri(trackId, clientId, headers) {
  const res = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}/download?client_id=${encodeURIComponent(clientId)}`, { headers });
  if (!res.ok) throw new Error(`ダウンロードリンクの取得に失敗しました (status: ${res.status})`);
  const data = await res.json();
  if (!data.redirectUri) throw new Error(`redirectUriが含まれていません`);
  return data.redirectUri;
}

async function fetchHlsAudio(m3u8Url, headers, tabId) {
  let text = await (await fetch(m3u8Url, { headers })).text();
  let lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.some(l => l.endsWith('.m3u8'))) {
    let subUrl = lines.find(l => !l.startsWith('#'));
    if (!subUrl.startsWith('http')) subUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + subUrl;
    text = await (await fetch(subUrl, { headers })).text();
    lines = text.split('\n').map(l => l.trim()).filter(l => l);
  }

  let initUrl = null;
  const mapLine = lines.find(l => l.startsWith('#EXT-X-MAP:'));
  if (mapLine) {
    const match = mapLine.match(/URI="([^"]+)"/);
    if (match) initUrl = match[1].startsWith('http') ? match[1] : m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + match[1];
  }

  const chunkUrls = lines.filter(l => !l.startsWith('#'));
  if (chunkUrls.length === 0) throw new Error('音声URLを抽出できませんでした');

  const chunks = [];
  if (initUrl) {
    reportProgress(tabId, `ヘッダー情報を取得中...`, 0, chunkUrls.length);
    const initRes = await fetch(initUrl, { headers });
    if (initRes.ok) chunks.push(new Uint8Array(await initRes.arrayBuffer()));
  }

  for (let i = 0; i < chunkUrls.length; i++) {
    if (i % 5 === 0 || i === chunkUrls.length - 1) reportProgress(tabId, `分割データを結合中... (${i + 1}/${chunkUrls.length})`, i + 1, chunkUrls.length);
    let chunkUrl = chunkUrls[i];
    if (!chunkUrl.startsWith('http')) chunkUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + chunkUrl;
    const chunkRes = await fetch(chunkUrl, { headers });
    if (chunkRes.ok) chunks.push(new Uint8Array(await chunkRes.arrayBuffer()));
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const audioData = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { audioData.set(c, offset); offset += c.length; }
  return audioData;
}

async function downloadPlaylistZip(playlist, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ includeArtwork: true, saveAs: false, artworkFormat: 'jpg', saveDirectory: '', zipEnabled: false }, r));
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (tracks.length === 0) return { ok: false, message: "プレイリストに曲がありません" };

  const totalTracks = tracks.length;
  const zip = new JSZip();
  const playlistName = safeFileName(playlist.title || 'playlist');
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";
  const folder = zip.folder(playlistName);
  const failed = [];
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    reportProgress(tabId, `トラック ${i + 1}/${totalTracks} を処理中...`, i + 1, totalTracks);
    try {
      let audioFetchUrl = null;
      // ★上限エラー回避：ダウンロード可能な場合はまず取得を試み、失敗したらストリームへ移行
      if (track.downloadable) {
        try {
          audioFetchUrl = await getDownloadRedirectUri(track.id, track.clientId, headers);
        } catch (e) {
          console.warn("Direct download limit reached or failed, falling back to stream.", e.message);
          if (track.streamUrl) audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl);
          else throw new Error("上限到達＆代替ストリームなし");
        }
      } else {
        if (track.streamUrl) audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl);
        else throw new Error("ストリームURLなし");
      }

      let audioData, audioExt;
      if (audioFetchUrl.includes('.m3u8')) {
        audioData = await fetchHlsAudio(audioFetchUrl, headers, tabId);
        audioExt = 'm4a';
      } else {
        const audioRes = await fetch(audioFetchUrl, { headers });
        const audioContentType = audioRes.headers.get('content-type') || '';
        audioData = new Uint8Array(await (await audioRes.blob()).arrayBuffer());
        if (audioFetchUrl.includes('.wav') || audioContentType.includes('wav')) audioExt = 'wav';
        else if (audioFetchUrl.includes('.m4a') || audioContentType.includes('m4a') || audioContentType.includes('mp4')) audioExt = 'm4a';
        else if (audioFetchUrl.includes('.ogg') || audioContentType.includes('ogg')) audioExt = 'ogg';
        else if (audioContentType.includes('flac')) audioExt = 'flac';
        else audioExt = 'mp3';
      }

      try {
        audioData = await convertToMp3ViaOffscreen(audioData, audioExt, tabId, track.title, track.artist);
        audioExt = 'mp3';
      } catch (e) { console.warn("MP3変換/メタデータ付与失敗:", e); }

      let artworkBlob = null;
      if (prefs.includeArtwork && track.artworkUrl) {
        const artworkRes = await fetch(track.artworkUrl);
        if (artworkRes.ok) {
          artworkBlob = await artworkRes.blob();
          if (prefs.artworkFormat === 'png') artworkBlob = await convertArtworkBlob(artworkBlob, 'png');
        }
      }

      const trackSafe = safeFileName(track.title || `track-${i + 1}`);
      if (prefs.zipEnabled) {
        const trackFolder = folder.folder(`${String(i + 1).padStart(2, '0')}. ${trackSafe}`);
        trackFolder.file(`${trackSafe}.${audioExt}`, audioData);
        if (artworkBlob) {
          trackFolder.file(`${trackSafe}_artwork.${(artworkBlob.type || '').includes('png') ? 'png' : 'jpg'}`, new Uint8Array(await artworkBlob.arrayBuffer()));
        }
      } else {
        await triggerDownload(new Blob([audioData], { type: 'audio/mpeg' }), `${folderPrefix}${playlistName}/${trackSafe}.${audioExt}`, tabId, !!prefs.saveAs);
        if (artworkBlob) await triggerDownload(artworkBlob, `${folderPrefix}${playlistName}/${trackSafe}_artwork.${(artworkBlob.type || '').includes('png') ? 'png' : 'jpg'}`, tabId, !!prefs.saveAs);
      }
    } catch (e) {
      failed.push({ title: track.title || `track-${i + 1}`, reason: e.message });
    }
  }

  if (prefs.zipEnabled) {
    reportProgress(tabId, 'ZIPを生成中...', totalTracks, totalTracks);
    const content = new Blob([new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }))], { type: 'application/zip' });
    const result = await triggerDownload(content, `${folderPrefix}${playlistName}.zip`, tabId, !!prefs.saveAs);
    return result.ok ? { ok: true, message: `完了${failed.length > 0 ? '（一部失敗）' : ''}` } : result;
  }
  return { ok: true, message: `完了${failed.length > 0 ? '（一部失敗）' : ''}` };
}

async function downloadZip(track, tabId) {
  const prefs = await new Promise((r) => chrome.storage.sync.get({ 
    includeArtwork: true, 
    saveAs: false, 
    artworkFormat: 'jpg',
    downloadMode: 'audioOnly',
    saveDirectory: '',
    zipEnabled: false
  }, r));

  const total = 5;
  reportProgress(tabId, "情報の取得中...", 1, total);
  const authHeader = await getAuthHeader();
  const headers = authHeader ? { Authorization: authHeader } : {};

  let audioFetchUrl = null;
  // ★上限エラー回避：ダウンロード可能な場合はまず取得を試み、失敗したらストリームへ移行
  if (track.downloadable) {
    reportProgress(tabId, "ダウンロードリンクを取得中...", 2, total);
    try {
      audioFetchUrl = await getDownloadRedirectUri(track.id, track.clientId, headers);
    } catch (e) {
      reportProgress(tabId, "上限到達のためストリームへ切替中...", 2, total);
      if (track.streamUrl) {
        audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl);
      } else {
        return { ok: false, message: "ダウンロード上限到達＆代替ストリームなし" };
      }
    }
  } else {
    reportProgress(tabId, "ストリーミング情報を取得中...", 2, total);
    if (track.streamUrl) {
      try { audioFetchUrl = await resolveStreamAudioUrl(track.streamUrl); } 
      catch (e) { return { ok: false, message: e.message }; }
    } else {
      return { ok: false, message: "ストリームURLが見つかりません" };
    }
  }

  reportProgress(tabId, "音声ファイルを取得中...", 2, total);
  let audioData;
  let audioExt = 'mp3';

  if (audioFetchUrl.includes('.m3u8')) {
    audioData = await fetchHlsAudio(audioFetchUrl, headers, tabId);
    audioExt = 'm4a'; 
  } else {
    const audioRes = await fetch(audioFetchUrl, { headers });
    if (!audioRes.ok) return { ok: false, message: `音声ファイルの取得に失敗しました` };
    const audioContentType = audioRes.headers.get('content-type') || '';
    audioData = new Uint8Array(await (await audioRes.blob()).arrayBuffer());

    if (audioFetchUrl.includes('.wav') || audioContentType.includes('wav')) audioExt = 'wav';
    else if (audioFetchUrl.includes('.m4a') || audioContentType.includes('m4a') || audioContentType.includes('mp4')) audioExt = 'm4a';
    else if (audioFetchUrl.includes('.ogg') || audioContentType.includes('ogg')) audioExt = 'ogg';
    else if (audioContentType.includes('flac')) audioExt = 'flac';
  }

  try {
    audioData = await convertToMp3ViaOffscreen(audioData, audioExt, tabId, track.title, track.artist);
    audioExt = 'mp3';
  } catch (e) { console.warn("MP3変換/メタデータ付与失敗:", e); }

  const safeName = safeFileName(track.title);
  const folderPrefix = prefs.saveDirectory ? `${prefs.saveDirectory}/` : "";

  let artworkBlob = null;
  let artworkExt = 'jpg';
  if (prefs.downloadMode === 'audioAndArtwork' && track.artworkUrl) {
    reportProgress(tabId, "ジャケット画像を取得中...", 3, total);
    const artworkRes = await fetch(track.artworkUrl);
    if (artworkRes.ok) {
      artworkBlob = await artworkRes.blob();
      if (prefs.artworkFormat === 'png') {
        artworkBlob = await convertArtworkBlob(artworkBlob, 'png');
        artworkExt = 'png';
      }
    }
  }

  if (prefs.zipEnabled) {
    reportProgress(tabId, "ZIPを作成中...", 4, total);
    const zip = new JSZip();
    const folder = zip.folder(safeName);
    
    folder.file(`${safeName}.${audioExt}`, audioData);
    if (artworkBlob) folder.file(`${safeName}_artwork.${artworkExt}`, new Uint8Array(await artworkBlob.arrayBuffer()));

    const content = new Blob([new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))], { type: "application/zip" });
    reportProgress(tabId, "保存中...", 5, total);
    const result = await triggerDownload(content, `${folderPrefix}${safeName}.zip`, tabId, !!prefs.saveAs);
    return result.ok ? { ok: true, message: "ZIP保存が完了しました" } : result;
  }

  reportProgress(tabId, "保存中...", 4, total);
  const audioBlob = new Blob([audioData], { type: 'audio/mpeg' });
  const audioRes = await triggerDownload(audioBlob, `${folderPrefix}${safeName}.${audioExt}`, tabId, !!prefs.saveAs);
  if (!audioRes.ok) return audioRes;

  if (artworkBlob) await triggerDownload(artworkBlob, `${folderPrefix}${safeName}_artwork.${artworkExt}`, tabId, !!prefs.saveAs);

  return { ok: true, message: "保存が完了しました" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractZipFromPopup") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => sendResponse(chrome.runtime.lastError ? { ok: false, message: `タブへの送信に失敗` } : response));
      } else { sendResponse({ ok: false, message: "対象タブが見つかりません" }); }
    });
    return true;
  }
  if (msg.action === "downloadZip") {
    downloadZip(msg.track, sender.tab && sender.tab.id).then(sendResponse).catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }
  if (msg.action === "downloadPlaylistZip") {
    downloadPlaylistZip(msg.playlist, sender.tab && sender.tab.id).then(sendResponse).catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }
  if (msg.action === "downloadArtworkOnly") {
    downloadArtworkOnly(msg.track, sender.tab && sender.tab.id).then(sendResponse).catch((err) => sendResponse({ ok: false, message: err.message }));
    return true;
  }
});