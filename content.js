async function resolveCurrentTrack(clientId) {
  const pageUrl = window.location.href.split("?")[0].split("#")[0];
  const res = await fetch(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(pageUrl)}&client_id=${clientId}`,
    { credentials: "include" }
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`トラック情報の取得に失敗しました (status: ${res.status}, body: ${bodyText.slice(0, 200)})`);
  }
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
  const appScripts = scripts
    .map((s) => s.src)
    .filter((src) => src.includes("sndcdn.com") && src.endsWith(".js"));
  for (const src of appScripts) {
    try {
      const res = await fetch(src);
      const text = await res.text();
      const m = text.match(/client_id\s*:\s*"([a-zA-Z0-9_-]+)"/);
      if (m) return m[1];
    } catch (e) {}
  }
  return null;
}

function getArtworkUrl(track) {
  let artworkUrl = track.artwork_url || (track.user && track.user.avatar_url);
  if (!artworkUrl) return null;
  // Try to normalize to highest quality available. SoundCloud uses suffixes like
  // -large.jpg, -t300x300.jpg, -t500x500.jpg, etc. Replace any size suffix with t500x500.
  // Preserve extension (jpg/png).
  const m = artworkUrl.match(/^(.*?)(-(?:large|original|t\d+x\d+|crop))?\.(jpg|png)(\?.*)?$/);
  if (m) {
    const base = m[1];
    const ext = m[3] || 'jpg';
    return `${base}-t500x500.${ext}` + (m[4] || '');
  }
  // fallback: append a high-res suffix
  return artworkUrl + (artworkUrl.includes('.') ? '' : '-t500x500.jpg');
}

function findProgressiveTranscoding(track) {
  const transcodings = track.media?.transcodings || [];
  return transcodings.find((item) => {
    const format = item.format || {};
    return format.protocol === 'progressive' && typeof format.mime_type === 'string' && format.mime_type.startsWith('audio/');
  });
}

function buildStreamRequestUrl(transcoding, clientId) {
  if (!transcoding || !transcoding.url) return null;
  const separator = transcoding.url.includes('?') ? '&' : '?';
  return `${transcoding.url}${separator}client_id=${encodeURIComponent(clientId)}`;
}

async function fetchFullPlaylist(playlist, clientId) {
  if (!playlist || !playlist.id) return playlist;
  try {
    const res = await fetch(`https://api-v2.soundcloud.com/playlists/${playlist.id}?client_id=${encodeURIComponent(clientId)}&limit=200`);
    if (!res.ok) return playlist;
    const data = await res.json();
    if (data.kind === 'playlist' && Array.isArray(data.tracks) && data.tracks.length > 0) {
      return data;
    }
  } catch (e) {
    console.warn('fetchFullPlaylist failed', e);
  }
  return playlist;
}

async function fetchFullTrack(track, clientId) {
  if (!track || !track.id) return track;
  if (track.media && Array.isArray(track.media.transcodings) && track.media.transcodings.length > 0) {
    return track;
  }
  try {
    const res = await fetch(`https://api-v2.soundcloud.com/tracks/${track.id}?client_id=${encodeURIComponent(clientId)}`);
    if (!res.ok) return track;
    const data = await res.json();
    if (data && data.kind === 'track') return data;
  } catch (e) {
    console.warn('fetchFullTrack failed', e);
  }
  return track;
}

function ensureToast() {
  let toast = document.getElementById("__sc_zip_toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "__sc_zip_toast";
    toast.style.cssText =
      "position:fixed;bottom:24px;right:24px;background:#111;color:#fff;padding:12px 16px;border-radius:6px;font-size:13px;z-index:2147483647;width:320px;box-sizing:border-box;box-shadow:0 2px 8px rgba(0,0,0,0.3);";
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
  const text = document.getElementById("__sc_zip_toast_text");
  const bar = document.getElementById("__sc_zip_toast_bar");
  text.textContent = message;
  if (typeof index === "number" && typeof total === "number" && total > 0) {
    bar.style.width = `${Math.round((index / total) * 100)}%`;
  } else {
    bar.style.width = "100%";
  }
  toast.style.display = "block";
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    toast.remove();
  }, 5000);
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: `backgroundへの送信でエラー: ${chrome.runtime.lastError.message}` });
        return;
      }
      resolve(res);
    });
  });
}

async function extractAndZip() {
  showToast("トラック情報を確認中...");
  const clientId = await fetchClientId();
  if (!clientId) throw new Error("client_idが取得できませんでした");

  let data = await resolveCurrentTrack(clientId);
  if (data.kind === 'playlist') {
    data = await fetchFullPlaylist(data, clientId);
    const playlistTitle = data.title || 'playlist';
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (tracks.length === 0) throw new Error("プレイリストにトラックがありません");

    const entries = [];
    for (let index = 0; index < tracks.length; index++) {
      const track = await fetchFullTrack(tracks[index], clientId);
      const artworkUrl = getArtworkUrl(track);
      const progressive = findProgressiveTranscoding(track);
      entries.push({
        id: track.id,
        title: track.title || `track-${index + 1}`,
        artworkUrl,
        clientId,
        streamUrl: progressive ? buildStreamRequestUrl(progressive, clientId) : null,
        downloadable: track.downloadable
      });
    }
    const available = entries.filter((item) => item.downloadable || item.streamUrl);
    if (available.length === 0) throw new Error("取得可能なトラックがありませんでした");

    const skipped = entries.length - available.length;
    const promptMessage = skipped > 0
      ? `プレイリスト「${playlistTitle}」の ${available.length} 曲をまとめて ZIP にします。取得不可の曲 ${skipped} 曲は除外されます。時間がかかる場合があります。実行しますか?`
      : `プレイリスト「${playlistTitle}」の ${available.length} 曲をまとめて ZIP にします。時間がかかる場合があります。実行しますか?`;
    const proceed = window.confirm(promptMessage);
    if (!proceed) return { ok: true, message: "キャンセルしました" };

    const result = await sendToBackground({
      action: "downloadPlaylistZip",
      playlist: { title: playlistTitle, tracks: available }
    });
    return result || { ok: false, message: "応答がありませんでした" };
  }

  const track = data;
  const artworkUrl = getArtworkUrl(track);

  if (!track.downloadable) {
    const progressive = findProgressiveTranscoding(track);
    if (progressive) {
      const proceed = window.confirm(
        "この曲はダウンロードが許可されていません。ストリーミング音声を取得してZIPにしますか?"
      );
      if (!proceed) return { ok: true, message: "キャンセルしました" };
      const result = await sendToBackground({
        action: "downloadZip",
        track: {
          title: track.title,
          artworkUrl,
          streamUrl: buildStreamRequestUrl(progressive, clientId)
        }
      });
      return result || { ok: false, message: "応答がありませんでした" };
    }

    const proceed = window.confirm(
      "この曲はダウンロードが許可されていません。ジャケット画像だけダウンロードしますか?"
    );
    if (!proceed) return { ok: true, message: "キャンセルしました" };
    const result = await sendToBackground({
      action: "downloadArtworkOnly",
      track: { title: track.title, artworkUrl }
    });
    return result || { ok: false, message: "応答がありませんでした" };
  }

  const result = await sendToBackground({
    action: "downloadZip",
    track: { id: track.id, title: track.title, clientId, artworkUrl }
  });
  return result || { ok: false, message: "応答がありませんでした" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "extractZip") {
    extractAndZip()
      .then((result) => {
        showToast(result.message);
        sendResponse(result);
      })
      .catch((err) => {
        const result = { ok: false, message: `エラー: ${err.message}` };
        showToast(result.message);
        sendResponse(result);
      });
    return true;
  }
  if (msg.action === "progress") {
    showToast(msg.step, msg.index, msg.total);
  }
});