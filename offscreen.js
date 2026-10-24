let chunksMap = {};
let convertChunksMap = {};
let ffmpeg = null;

async function initFFmpeg() {
  if (!ffmpeg) {
    const { createFFmpeg } = FFmpeg;
    ffmpeg = createFFmpeg({
      corePath: chrome.runtime.getURL("lib/ffmpeg-core.js"),
      log: true, // 開発用にログをオンにしています
    });
    await ffmpeg.load();
  }
  return ffmpeg;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
          
          const args = ["-i", inputName];
          
          // ★音声ストリームのみを抽出し、不要なデータ（壊れた画像タグなど）を排除
          args.push("-map", "0:a");
          // ★元のメタデータを完全に消去
          args.push("-map_metadata", "-1");
          
          if (msg.originalExt === 'mp3') {
            args.push("-c:a", "copy");
          } else {
            args.push("-c:a", "libmp3lame", "-b:a", "192k");
          }

          // ★Windowsエクスプローラー対策の最強設定
          args.push("-id3v2_version", "3"); // 互換性重視のID3v2.3
          args.push("-write_id3v2", "1");   // コピー時にもID3を強制書き込み

          // メタデータの追加（アルバム名等も埋めると認識されやすいです）
          if (msg.title) {
            args.push("-metadata", `title=${msg.title}`);
            args.push("-metadata", `album=${msg.title}`);
          }
          if (msg.artist) {
            args.push("-metadata", `artist=${msg.artist}`);
            args.push("-metadata", `album_artist=${msg.artist}`);
          }
          
          // ★強制的にmp3フォーマットで出力
          args.push("-f", "mp3");
          args.push(outputName);
          
          // 変換実行
          await f.run(...args);
          const outputData = f.FS("readFile", outputName);
          
          // メモリ解放
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