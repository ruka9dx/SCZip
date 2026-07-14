const defaults = {
  includeArtwork: true,
  artworkFormat: 'jpg',
  saveAs: false,
  chunkMode: 'normal',
  customSize: 512,
  customUnit: 'KB',
  theme: 'light'
};

let systemThemeQuery = null;
function $(id) { return document.getElementById(id); }

function applyTheme(theme) {
  if (theme === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', isDark);
    $('themeSystem').classList.add('active');
    $('themeLight').classList.remove('active');
    $('themeDark').classList.remove('active');
    if (!systemThemeQuery) {
      systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      systemThemeQuery.addEventListener('change', onSystemThemeChange);
    }
  } else {
    document.body.classList.toggle('dark', theme === 'dark');
    $('themeLight').classList.toggle('active', theme === 'light');
    $('themeDark').classList.toggle('active', theme === 'dark');
    $('themeSystem').classList.remove('active');
    if (systemThemeQuery) {
      systemThemeQuery.removeEventListener('change', onSystemThemeChange);
      systemThemeQuery = null;
    }
  }
}

function onSystemThemeChange() {
  applyTheme('system');
}

async function load() {
  const data = await new Promise((r) => chrome.storage.sync.get(defaults, r));
  $('includeArtwork').checked = !!data.includeArtwork;
  $('artworkFormat').value = data.artworkFormat || defaults.artworkFormat;
  $('saveAs').checked = !!data.saveAs;
  $('chunkMode').value = data.chunkMode || defaults.chunkMode;
  $('customSize').value = data.customSize || defaults.customSize;
  $('customUnit').value = data.customUnit || defaults.customUnit;
  applyTheme(data.theme || defaults.theme);
  document.getElementById('customRow').style.display = (data.chunkMode === 'custom') ? 'block' : 'none';
  try {
    const manifest = chrome.runtime.getManifest();
    const verEl = document.getElementById('optionsVersion');
    if (verEl) verEl.textContent = `Version: ${manifest.version}`;
  } catch (e) {}
}

function showStatus(msg) {
  $('status').textContent = msg;
  setTimeout(() => {$('status').textContent = ''}, 3000);
}

async function save() {
  const selectedTheme = $('themeDark').classList.contains('active') ? 'dark' : $('themeSystem').classList.contains('active') ? 'system' : 'light';
  const obj = {
    includeArtwork: $('includeArtwork').checked,
    artworkFormat: $('artworkFormat').value || defaults.artworkFormat,
    saveAs: $('saveAs').checked,
    chunkMode: $('chunkMode').value || defaults.chunkMode,
    customSize: Number($('customSize').value) || defaults.customSize,
    customUnit: $('customUnit').value || defaults.customUnit,
    theme: selectedTheme
  };
  await new Promise((r) => chrome.storage.sync.set(obj, r));
  showStatus('設定を保存しました');
}

document.getElementById('themeLight').addEventListener('click', () => {
  applyTheme('light');
});

document.getElementById('themeDark').addEventListener('click', () => {
  applyTheme('dark');
});

document.getElementById('themeSystem').addEventListener('click', () => {
  applyTheme('system');
});

async function resetDefaults() {
  await new Promise((r) => chrome.storage.sync.set(defaults, r));
  await load();
  showStatus('デフォルトに戻しました');
}

document.getElementById('saveBtn').addEventListener('click', save);
document.getElementById('resetBtn').addEventListener('click', resetDefaults);
window.addEventListener('DOMContentLoaded', load);
document.getElementById('chunkMode').addEventListener('change', (e) => {
  document.getElementById('customRow').style.display = (e.target.value === 'custom') ? 'block' : 'none';
});
