const statusEl = document.getElementById("status");
const barOuter = document.getElementById("barOuter");
const barInner = document.getElementById("barInner");

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
  barInner.style.width = "0%";
  barOuter.style.display = "none";
  setProgress("処理中...");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "extractZip" }, (response) => {
        setProgress(response ? response.message : "応答がありませんでした");
      });
    } else {
      setProgress("対象タブが見つかりませんでした");
    }
  });
});
