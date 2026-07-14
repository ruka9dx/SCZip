chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "createBlobUrl") {
    try {
      console.log("offscreen: createBlobUrl received", {
        hasBuffer: !!msg.buffer,
        hasNumbers: !!msg.numbers,
        bufferLength: msg.buffer && (msg.buffer.byteLength || (msg.buffer.buffer && msg.buffer.buffer.byteLength)) || null,
        numbersLength: msg.numbers && msg.numbers.length
      });
      let uint8;
      if (msg.buffer) {
        const raw = msg.buffer;
        const ab = raw instanceof ArrayBuffer ? raw : raw && raw.buffer instanceof ArrayBuffer ? raw.buffer : raw;
        uint8 = new Uint8Array(ab);
      } else if (msg.numbers) {
        uint8 = new Uint8Array(msg.numbers);
      } else {
        throw new Error("no buffer provided");
      }
      const blob = new Blob([uint8], { type: msg.mimeType });
      const url = URL.createObjectURL(blob);
      console.log("offscreen: created blob url", { url, size: uint8.length, mimeType: msg.mimeType });
      sendResponse({ ok: true, url });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      console.error("offscreen: createBlobUrl error", e);
      sendResponse({ ok: false, message: `Blob生成に失敗しました: ${e.message}` });
    }
    return true;
  }

  // Chunked upload support: receive chunks and assemble them under an id
  if (msg.action === "createBlobUrlChunk") {
    try {
      if (!msg.id) throw new Error("missing id");
      if (!self._sczip_chunks) self._sczip_chunks = new Map();
      const entry = self._sczip_chunks.get(msg.id) || { parts: [], totalSize: 0, mimeType: msg.mimeType };
      const part = msg.numbers ? new Uint8Array(msg.numbers) : msg.buffer ? new Uint8Array(msg.buffer) : null;
      if (!part) throw new Error("no part data");
      entry.parts[msg.index] = part;
      entry.totalSize += part.length;
      entry.mimeType = msg.mimeType || entry.mimeType;
      self._sczip_chunks.set(msg.id, entry);
      console.log("offscreen: received chunk", { id: msg.id, index: msg.index, length: part.length });
      if (msg.last) {
        // assemble
        const result = new Uint8Array(entry.totalSize);
        let offset = 0;
        for (let i = 0; i < entry.parts.length; i++) {
          const p = entry.parts[i];
          if (!p) continue;
          result.set(p, offset);
          offset += p.length;
        }
        const blob = new Blob([result], { type: entry.mimeType || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        console.log("offscreen: assembled blob url", { id: msg.id, size: result.length });
        // cleanup
        self._sczip_chunks.delete(msg.id);
        sendResponse({ ok: true, url });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        sendResponse({ ok: true, received: true });
      }
    } catch (e) {
      console.error("offscreen: createBlobUrlChunk error", e);
      sendResponse({ ok: false, message: e.message });
    }
    return true;
  }
});
