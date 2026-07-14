const statusEl = document.getElementById("status");
const barOuter = document.getElementById("barOuter");
const barInner = document.getElementById("barInner");
const extractBtn = document.getElementById("extractBtn");
const spinner = extractBtn && extractBtn.querySelector('.spinner');

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

chrome.storage.sync.get({ theme: 'light' }, (data) => {
  applyPopupTheme(data.theme);
});

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

document.getElementById("extractBtn").addEventListener("click", () => {
  // start
  if (extractBtn) { extractBtn.disabled = true; extractBtn.classList.add('loading'); }
  barInner.style.width = "0%";
  barOuter.style.display = "none";
  setProgress("処理中...");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => {
        if (chrome.runtime.lastError) {
          setProgress(`エラー: ${chrome.runtime.lastError.message}`);
          if (extractBtn) { extractBtn.disabled = false; extractBtn.classList.remove('loading'); }
          return;
        }
        if (response) {
          if (response.ok) {
            // complete the bar and show complete state briefly
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
