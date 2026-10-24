const statusEl = document.getElementById("status");
const barOuter = document.getElementById("barOuter");
const barInner = document.getElementById("barInner");
const extractBtn = document.getElementById("extractBtn");
const btnLabel = document.getElementById("btnLabel");
const popupMode = document.getElementById("popupMode");

let isZipEnabled = false;

function applyPopupTheme(theme) {
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', dark);
  } else {
    document.body.classList.toggle('dark', theme === 'dark');
  }
}

chrome.storage.sync.get({ theme: 'light', downloadMode: 'audioOnly', zipEnabled: false }, (data) => {
  applyPopupTheme(data.theme);
  isZipEnabled = data.zipEnabled;
  if (popupMode) {
    popupMode.value = data.downloadMode;
    updateButtonLabel(data.downloadMode);
  }
});

if (popupMode) {
  popupMode.addEventListener("change", (e) => {
    const newMode = e.target.value;
    chrome.storage.sync.set({ downloadMode: newMode });
    updateButtonLabel(newMode);
  });
}

function updateButtonLabel(mode) {
  if (mode === 'audioOnly') {
    btnLabel.textContent = isZipEnabled ? "音声をZIPで保存" : "音声のみ (mp3) を保存";
  } else {
    btnLabel.textContent = isZipEnabled ? "音声と画像をZIPで保存" : "音声と画像を個別に保存";
  }
}

try {
  const manifest = chrome.runtime.getManifest();
  const popupVersionEl = document.getElementById('popupVersion');
  if (popupVersionEl) popupVersionEl.textContent = `v${manifest.version}`;
} catch (e) {}

function setProgress(message, index, total) {
  statusEl.textContent = message;
  if (typeof index === "number" && typeof total === "number" && total > 0) {
    barOuter.style.display = "block";
    barInner.style.width = `${Math.round((index / total) * 100)}%`;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "progress") setProgress(msg.step, msg.index, msg.total);
});

document.getElementById("extractBtn").addEventListener("click", () => {
  if (extractBtn) { extractBtn.disabled = true; extractBtn.classList.add('loading'); }
  barInner.style.width = "0%";
  barOuter.style.display = "none";
  setProgress("処理中...");
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      if (!tabs[0].url.includes("soundcloud.com")) {
        setProgress("SoundCloudの楽曲ページで実行してください");
        extractBtn.disabled = false; extractBtn.classList.remove('loading');
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => {
        if (chrome.runtime.lastError) {
          setProgress(`エラー: ${chrome.runtime.lastError.message}`);
        } else if (response) {
          setProgress(response.message || (response.ok ? "完了" : "失敗しました"), response.ok?1:0, response.ok?1:0);
        } else {
          setProgress("応答がありませんでした");
        }
        extractBtn.disabled = false; extractBtn.classList.remove('loading');
      });
    }
  });
});

document.getElementById('openOptions').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: 'options.html' });
});