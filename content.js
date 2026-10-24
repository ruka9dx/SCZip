async function resolveCurrentTrack(clientId) {
  const pageUrl = window.location.href.split("?")[0].split("#")[0];
  const res = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(pageUrl)}&client_id=${clientId}`, { credentials: "include" });
  if (!res.ok) throw new Error(`トラック情報の取得に失敗しました`);
  const data = await res.json();
  if (data.kind !== "track" && data.kind !== "playlist") throw new Error("このページは楽曲ページではありません");
  return data;
}

async function fetchClientId() {
  const scripts = Array.from(document.querySelectorAll("script[src]"));
  for (const s of scripts) {
    const m = s.src.match(/[?&]client_id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
  }
  const appScripts = scripts.map((s) => s.src).filter((src) => src.includes("sndcdn.com") && src.endsWith(".js"));
  for (const src of appScripts) {
    try {
      const text = await (await fetch(src)).text();
      const m = text.match(/client_id\s*:\s*"([a-zA-Z0-9_-]+)"/);
      if (m) return m[1];
    } catch (e) {}
  }
  return null;
}

function getArtworkUrl(track) {
  let artworkUrl = track.artwork_url || (track.user && track.user.avatar_url);
  if (!artworkUrl) return null;
  const m = artworkUrl.match(/^(.*?)(-(?:large|original|t\d+x\d+|crop))?\.(jpg|png)(\?.*)?$/);
  if (m) return `${m[1]}-t500x500.${m[3] || 'jpg'}${m[4] || ''}`;
  return artworkUrl + (artworkUrl.includes('.') ? '' : '-t500x500.jpg');
}

function findDownloadableTranscoding(track) {
  const transcodings = track.media?.transcodings || [];
  return transcodings.find((i) => i.format?.protocol === 'progressive' && i.format?.mime_type?.startsWith('audio/')) 
      || transcodings.find((i) => i.format?.protocol === 'hls' && i.format?.mime_type?.startsWith('audio/'));
}

function buildStreamRequestUrl(transcoding, clientId) {
  if (!transcoding || !transcoding.url) return null;
  return `${transcoding.url}${transcoding.url.includes('?') ? '&' : '?'}client_id=${encodeURIComponent(clientId)}`;
}

async function fetchFullPlaylist(playlist, clientId) {
  if (!playlist || !playlist.id) return playlist;
  try {
    const res = await fetch(`https://api-v2.soundcloud.com/playlists/${playlist.id}?client_id=${encodeURIComponent(clientId)}&limit=200`);
    const data = res.ok ? await res.json() : null;
    if (data?.kind === 'playlist' && data.tracks?.length > 0) return data;
  } catch (e) {}
  return playlist;
}

async function fetchFullTrack(track, clientId) {
  if (!track || !track.id) return track;
  if (track.media?.transcodings?.length > 0) return track;
  try {
    const res = await fetch(`https://api-v2.soundcloud.com/tracks/${track.id}?client_id=${encodeURIComponent(clientId)}`);
    const data = res.ok ? await res.json() : null;
    if (data?.kind === 'track') return data;
  } catch (e) {}
  return track;
}

function ensureToast() {
  let toast = document.getElementById("__sc_zip_toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "__sc_zip_toast";
    toast.style.cssText = "position:fixed;bottom:24px;right:24px;background:#111;color:#fff;padding:12px 16px;border-radius:6px;font-size:13px;z-index:2147483647;width:320px;box-sizing:border-box;box-shadow:0 2px 8px rgba(0,0,0,0.3);";
    const text = document.createElement("div");
    text.id = "__sc_zip_toast_text";
    text.style.cssText = "white-space:normal;word-break:break-word;max-height:64px;overflow:auto;";
    const barOuter = document.createElement("div");
    barOuter.style.cssText = "margin-top:8px;height:4px;background:#444;border-radius:2px;overflow:hidden;";
    const barInner = document.createElement("div");
    barInner.id = "__sc_zip_toast_bar";
    barInner.style.cssText = "height:100%;width:0%;background:#ff5500;transition:width 0.2s;";
    barOuter.appendChild(barInner);
    toast.appendChild(text);
    toast.appendChild(barOuter);
    document.body.appendChild(toast);
  }
  return toast;
}

let toastHideTimer = null;
function showToast(message, index, total) {
  const toast = ensureToast();
  document.getElementById("__sc_zip_toast_text").textContent = message;
  document.getElementById("__sc_zip_toast_bar").style.width = (index && total) ? `${Math.round((index / total) * 100)}%` : "100%";
  toast.style.display = "block";
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => toast.remove(), 5000);
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, message: `エラー: ${chrome.runtime.lastError.message}` } : res));
  });
}

async function extractAndZip() {
  showToast("トラック情報を確認中...");
  const clientId = await fetchClientId();
  if (!clientId) throw new Error("client_idが取得できませんでした");

  const prefs = await new Promise((r) => chrome.storage.sync.get({ downloadMode: 'audioOnly', showConfirmDialog: true }, r));
  const actionText = prefs.downloadMode === 'audioOnly' ? '保存' : 'ZIPに';

  let data = await resolveCurrentTrack(clientId);
  if (data.kind === 'playlist') {
    data = await fetchFullPlaylist(data, clientId);
    const playlistTitle = data.title || 'playlist';
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (tracks.length === 0) throw new Error("プレイリストにトラックがありません");

    const entries = [];
    for (let index = 0; index < tracks.length; index++) {
      const track = await fetchFullTrack(tracks[index], clientId);
      const progressive = findDownloadableTranscoding(track);
      entries.push({
        id: track.id,
        title: track.title || `track-${index + 1}`,
        artist: track.user?.username || "", 
        artworkUrl: getArtworkUrl(track),
        clientId,
        streamUrl: progressive ? buildStreamRequestUrl(progressive, clientId) : null,
        downloadable: track.downloadable // ★重要：上限に達していてもここにはtrueが入る
      });
    }
    const available = entries.filter((item) => item.downloadable || item.streamUrl);
    if (available.length === 0) throw new Error("取得可能なトラックがありませんでした");

    if (prefs.showConfirmDialog) {
      const skipped = entries.length - available.length;
      const msg = skipped > 0 ? `プレイリスト「${playlistTitle}」の ${available.length} 曲を${actionText}しますか? (不可の${skipped}曲は除外)` : `プレイリスト「${playlistTitle}」の ${available.length} 曲を${actionText}しますか?`;
      if (!window.confirm(msg)) return { ok: true, message: "キャンセルしました" };
    }

    const result = await sendToBackground({ action: "downloadPlaylistZip", playlist: { title: playlistTitle, tracks: available } });
    return result || { ok: false, message: "応答がありませんでした" };
  }

  const track = data;
  const artworkUrl = getArtworkUrl(track);
  const trackArtist = track.user?.username || "";
  const progressive = findDownloadableTranscoding(track);
  const streamUrl = progressive ? buildStreamRequestUrl(progressive, clientId) : null; // ★常にストリームURLを生成しておく

  if (!track.downloadable) {
    if (progressive) {
      if (prefs.showConfirmDialog && !window.confirm(`ダウンロードが許可されていません。ストリーミング音声を取得して${actionText}しますか?`)) return { ok: true, message: "キャンセルしました" };
      return await sendToBackground({
        action: "downloadZip",
        track: { id: track.id, title: track.title, artist: trackArtist, clientId, artworkUrl, streamUrl, downloadable: false }
      }) || { ok: false, message: "応答なし" };
    }
    if (prefs.showConfirmDialog && !window.confirm("ジャケット画像だけダウンロードしますか?")) return { ok: true, message: "キャンセルしました" };
    return await sendToBackground({ action: "downloadArtworkOnly", track: { title: track.title, artworkUrl } }) || { ok: false, message: "応答なし" };
  }

  // ★ダウンロード可能な場合も、フォールバック用にstreamUrlとdownloadable状態を渡す
  return await sendToBackground({ 
    action: "downloadZip", 
    track: { id: track.id, title: track.title, artist: trackArtist, clientId, artworkUrl, streamUrl, downloadable: true } 
  }) || { ok: false, message: "応答なし" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractZip") {
    extractAndZip().then((res) => { showToast(res.message); sendResponse(res); }).catch((err) => { showToast(`エラー: ${err.message}`); sendResponse({ ok: false }); });
    return true;
  }
  if (msg.action === "progress") showToast(msg.step, msg.index, msg.total);
});