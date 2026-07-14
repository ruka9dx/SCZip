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
  if (data.kind !== "track") throw new Error("このページは楽曲ページではありません");
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
  return artworkUrl.replace("-large.jpg", "-t500x500.jpg");
}

function ensureToast() {
  let toast = document.getElementById("__sc_zip_toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "__sc_zip_toast";
    toast.style.cssText =
      "position:fixed;bottom:24px;right:24px;background:#111;color:#fff;padding:12px 16px;border-radius:6px;font-size:13px;z-index:2147483647;max-width:320px;box-shadow:0 2px 8px rgba(0,0,0,0.3);";
    const text = document.createElement("div");
    text.id = "__sc_zip_toast_text";
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
    chrome.runtime.sendMessage(msg, (res) => resolve(res));
  });
}

async function extractAndZip() {
  showToast("トラック情報を確認中...");
  const clientId = await fetchClientId();
  if (!clientId) throw new Error("client_idが取得できませんでした");

  const track = await resolveCurrentTrack(clientId);
  const artworkUrl = getArtworkUrl(track);

  if (!track.downloadable) {
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
