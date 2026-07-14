# SCZip

SCZip は SoundCloud の楽曲ページやプレイリストから、ジャケット画像と音声を ZIP にまとめて保存する Chrome 拡張機能です。

## インストール

1. このリポジトリを ZIP でダウンロードするか、フォルダをクローンします。
2. Chrome を開き、アドレスバーに `chrome://extensions/` を入力して移動します。
3. 画面右上の「デベロッパーモード」を ON にします。
4. 「パッケージ化されていない拡張機能を読み込む」ボタンをクリックします。
5. このリポジトリのルートフォルダ（`manifest.json` があるフォルダ）を選択します。

> この拡張機能は Chrome ウェブストアに公開していないため、上記の手順でローカルから読み込んでください。

## 使い方

1. SoundCloud の楽曲ページまたはプレイリストページを開く
2. 拡張機能のポップアップを開く
3. 「ジャケット+音声をZIPで保存」ボタンを押す

## 機能

- 単曲・プレイリストの音声とジャケットをまとめて ZIP に保存
- プレイリストは曲ごとに番号付きフォルダで整理
- ジャケット画像の形式を JPG / PNG から選択可能
- 保存前に「名前を付けて保存」を表示するオプション
- テーマ設定（ライト / ダーク / システム）対応

## 注意

- SoundCloud の利用規約に従ってください
- このツールを使ってダウンロードできるのはSoundCloud上でダウンロードが許可されている楽曲のみです
- 一部の楽曲やプレイリスト(プライベートなど)は取得できない場合があります
- プレイリストの処理には時間がかかることがあります

## クレジット

このリポジトリでは GitHub Copilot を補助ツールとして使用しています。

## 依存ライブラリとドキュメント

本プロジェクトで利用している主要なライブラリやブラウザ機能、参考ドキュメントは以下の通りです。

- JSZip — JavaScript で ZIP ファイルを生成するためのライブラリ（各トラックをフォルダにして ZIP にまとめる用途）。
	- ドキュメント: https://stuk.github.io/jszip/
	- リポジトリ・ライセンス: https://github.com/Stuk/jszip （MIT ライセンス）
- Chrome Extensions (Manifest V3) — 拡張 API、バックグラウンドサービスワーカー、コンテンツスクリプト、ストレージ、ダウンロード、オフスクリーンドキュメントなど。
	- ドキュメント: https://developer.chrome.com/docs/extensions/mv3/
	- オフスクリーンドキュメント: https://developer.chrome.com/docs/extensions/mv3/offscreen/
- Fetch / Streams / Blob — ブラウザの Web API で、音声や画像のバイナリ取得と処理に使用。
	- Fetch API (MDN): https://developer.mozilla.org/ja/docs/Web/API/Fetch_API
	- Blob (MDN): https://developer.mozilla.org/ja/docs/Web/API/Blob
- OffscreenCanvas / createImageBitmap — ジャケット画像を PNG に変換する際に利用（実行環境が対応している場合）。
	- OffscreenCanvas (MDN): https://developer.mozilla.org/ja/docs/Web/API/OffscreenCanvas
- その他参考
	- SoundCloud API（非公式の v2 エンドポイントを参照している箇所があります）: https://developers.soundcloud.com/

ソースの中で依存が明示されている主なファイル: `background.js`, `content.js`, `offscreen.js`。


---

# SCZip

SCZip is a Chrome extension that saves SoundCloud tracks and playlists as ZIP files with cover art and audio.

## Installation

1. Download this repository as a ZIP archive or clone the folder.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on "Developer mode" in the top-right corner.
4. Click "Load unpacked".
5. Select the repository root folder where `manifest.json` is located.

> This extension is not published in the Chrome Web Store, so install it locally using Developer mode.

## How to Use

1. Open a SoundCloud track or playlist page
2. Open the extension popup
3. Click the "Save cover art + audio as ZIP" button

## Features

- Save audio and cover art from individual tracks and playlists into a ZIP file
- Playlists are organized into numbered folders per track
- Choose cover art format: JPG or PNG
- Optionally show a save dialog before downloading
- Supports light / dark / system theme settings

## Notes

- Please follow SoundCloud's terms of service
- This tool only downloads tracks that are permitted for download on SoundCloud
- Some tracks or playlists (such as private content) may not be retrievable
- Playlist processing may take longer than single-track downloads

## Credits

This repository uses GitHub Copilot as an assistive tool.

## Dependencies & Documentation

This project uses the following libraries, web platform features, and documentation during development:

- JSZip — Create and generate ZIP files in JavaScript (used to assemble track folders and files).
	- Docs: https://stuk.github.io/jszip/
	- Repository & License: https://github.com/Stuk/jszip (MIT License)
- Chrome Extensions (Manifest V3) — Extension APIs, background service workers, content scripts, storage, downloads, offscreen documents.
	- Docs: https://developer.chrome.com/docs/extensions/mv3/
	- Offscreen documents: https://developer.chrome.com/docs/extensions/mv3/offscreen/
- Fetch / Streams / Blobs — Browser Web APIs for requesting and handling binary audio and image data.
	- Fetch API docs (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
	- Blob docs (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Blob
- OffscreenCanvas / createImageBitmap — Used to convert artwork to PNG when requested (if available in the runtime).
	- OffscreenCanvas (MDN): https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- Other references used while developing:
	- SoundCloud API (unofficial v2 endpoints used by the extension): https://developers.soundcloud.com/

If you want to inspect or update dependencies, see the source files in this repository (notably `background.js`, `content.js`, and `offscreen.js`).
