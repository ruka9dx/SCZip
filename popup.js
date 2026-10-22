const statusEl = document.getElementById("status");
const barOuter = document.getElementById("barOuter");
const barInner = document.getElementById("barInner");
const extractBtn = document.getElementById("extractBtn");
const btnLabel = document.getElementById("btnLabel");
const spinner = extractBtn && extractBtn.querySelector('.spinner');
const popupMode = document.getElementById("popupMode"); // 追加

function applyPopupTheme(theme) {
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', dark);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      document.body.classList.toggle('dark', e.matches);
    });
  } else {
    document.body.classList.toggle('dark', theme === 'dark');
  }
}

// 起動時に保存されている設定を読み込む
chrome.storage.sync.get({ theme: 'light', downloadMode: 'zip' }, (data) => {
  applyPopupTheme(data.theme);
  
  if (popupMode) {
    popupMode.value = data.downloadMode;
    updateButtonLabel(data.downloadMode);
  }
});

// ポップアップ上でモードが変更されたら保存してボタン名を更新
if (popupMode) {
  popupMode.addEventListener("change", (e) => {
    const newMode = e.target.value;
    chrome.storage.sync.set({ downloadMode: newMode });
    updateButtonLabel(newMode);
  });
}

function updateButtonLabel(mode) {
  if (mode === 'audioOnly') {
    btnLabel.textContent = "音声のみ保存";
  } else {
    btnLabel.textContent = "ジャケット+音声をZIPで保存";
  }
}

// show extension version in popup
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
  if (msg.action === "progress") {
    setProgress(msg.step, msg.index, msg.total);
  }
});

function openSoundCloudTab(tabId) {
  const shouldOpen = window.confirm("このページは SoundCloud の曲ページではありません。新しいタブで SoundCloud を開いて実行しますか?");
  if (shouldOpen) {
    chrome.tabs.create({ url: "https://soundcloud.com" });
  }
}

document.getElementById("extractBtn").addEventListener("click", () => {
  // start
  if (extractBtn) { extractBtn.disabled = true; extractBtn.classList.add('loading'); }
  barInner.style.width = "0%";
  barOuter.style.display = "none";
  setProgress("処理中...");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      const tab = tabs[0];
      const url = tab.url || "";
      if (!url.includes("soundcloud.com")) {
        setProgress("SoundCloud の楽曲ページを開いてから実行してください");
        openSoundCloudTab(tab.id);
        if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: "extractZip" }, (response) => {
        if (chrome.runtime.lastError) {
          setProgress(`エラー: ${chrome.runtime.lastError.message}`);
          if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
          return;
        }
        if (response) {
          if (response.ok) {
            setProgress(response.message || "完了", 1, 1);
            setTimeout(() => {
              if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
            }, 600);
          } else {
            setProgress(response.message || "失敗しました");
            if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
          }
        } else {
          setProgress("応答がありませんでした");
          if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
        }
      });
    } else {
      setProgress("対象タブが見つかりませんでした");
      if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
    }
  });
});

const openOptionsBtn = document.getElementById('openOptions');
if (openOptionsBtn) {
  openOptionsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: 'options.html' });
  });
}