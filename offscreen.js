let chunksMap = {};
let convertChunksMap = {};
let ffmpeg = null;

async function initFFmpeg() {
  if (!ffmpeg) {
    const { createFFmpeg } = FFmpeg;
    ffmpeg = createFFmpeg({
      corePath: chrome.runtime.getURL("lib/ffmpeg-core.js"),
      log: false, // ログを出したい場合は true に
    });
    await ffmpeg.load();
  }
  return ffmpeg;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // MP3への変換リクエスト
  if (msg.action === "convertChunk") {
    (async () => {
      try {
        if (!convertChunksMap[msg.id]) convertChunksMap[msg.id] = [];
        convertChunksMap[msg.id][msg.index] = new Uint8Array(msg.numbers);

        if (msg.last) {
          const chunks = convertChunksMap[msg.id];
          const totalLength = chunks.reduce((acc, val) => acc + val.length, 0);
          const fullArray = new Uint8Array(totalLength);
          let offset = 0;
          for (let chunk of chunks) {
            fullArray.set(chunk, offset);
            offset += chunk.length;
          }
          delete convertChunksMap[msg.id];

          const f = await initFFmpeg();
          const inputName = `input.${msg.originalExt}`;
          const outputName = `output.mp3`;
          
          f.FS("writeFile", inputName, fullArray);
          // mp3 (192kbps) に変換
          await f.run("-i", inputName, "-c:a", "libmp3lame", "-b:a", "192k", outputName);
          const outputData = f.FS("readFile", outputName);
          
          f.FS("unlink", inputName);
          f.FS("unlink", outputName);

          const blob = new Blob([outputData], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          sendResponse({ ok: true, url: url });
        } else {
          sendResponse({ ok: true });
        }
      } catch (e) {
        sendResponse({ ok: false, message: e.message });
      }
    })();
    return true;
  }

  // 既存のダウンロード用URL作成リクエスト
  if (msg.action === "createBlobUrlChunk") {
    if (!chunksMap[msg.id]) chunksMap[msg.id] = [];
    chunksMap[msg.id][msg.index] = new Uint8Array(msg.numbers);

    if (msg.last) {
      const chunks = chunksMap[msg.id];
      const totalLength = chunks.reduce((acc, val) => acc + val.length, 0);
      const fullArray = new Uint8Array(totalLength);
      let offset = 0;
      for (let chunk of chunks) {
        fullArray.set(chunk, offset);
        offset += chunk.length;
      }
      delete chunksMap[msg.id];

      const blob = new Blob([fullArray], { type: msg.mimeType });
      const url = URL.createObjectURL(blob);
      sendResponse({ ok: true, url: url });
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }
});