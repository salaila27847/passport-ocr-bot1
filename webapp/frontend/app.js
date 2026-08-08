import { api, state as apiState } from './js/api.js';
import { initGoogleSignIn } from './js/auth.js';
import {
  renderSignIn,
  renderConfigError,
  renderSheetSelect,
  renderSeqDashboard,
  renderSeqHub,
  renderPhotos,
  renderExtraInfo,
} from './js/views.js';

const appEl = document.getElementById('app');

const ctx = {
  me: null,
  sheetId: sessionStorage.getItem('sheetId') || '',
  sheetName: sessionStorage.getItem('sheetName') || '',
  setSheet(id, name) {
    ctx.sheetId = id;
    ctx.sheetName = name;
    sessionStorage.setItem('sheetId', id);
    sessionStorage.setItem('sheetName', name);
  },
  navigate(path) {
    window.location.hash = path;
  },
};

function renderRoute() {
  if (!ctx.me) {
    renderSignIn(appEl);
    return;
  }
  const hash = window.location.hash.replace(/^#/, '') || '/sheets';
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] === 'sheets') {
    renderSheetSelect(appEl, ctx);
  } else if (parts[0] === 'seq' && parts[1] && parts[2] === 'photos') {
    renderPhotos(appEl, ctx, parts[1]);
  } else if (parts[0] === 'seq' && parts[1] && parts[2] === 'extra-info') {
    renderExtraInfo(appEl, ctx, parts[1]);
  } else if (parts[0] === 'seq' && parts[1]) {
    renderSeqHub(appEl, ctx, parts[1]);
  } else if (parts[0] === 'seq') {
    renderSeqDashboard(appEl, ctx);
  } else {
    renderSheetSelect(appEl, ctx);
  }
}

async function onSignedIn() {
  try {
    ctx.me = await api.getMe();
  } catch (err) {
    ctx.me = null;
    renderSignIn(appEl);
    return;
  }
  if (!ctx.sheetId) window.location.hash = '/sheets';
  else if (!window.location.hash) window.location.hash = '/seq';
  renderRoute();
}

window.addEventListener('hashchange', renderRoute);

async function boot() {
  let config;
  try {
    config = await api.getConfig();
  } catch (err) {
    renderConfigError(appEl, 'เชื่อมต่อ backend ไม่ได้: ' + err.message);
    return;
  }

  const ok = initGoogleSignIn(config.google_client_id, onSignedIn);
  if (!ok) {
    renderConfigError(appEl, 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า Google Sign-In (GOOGLE_OAUTH_CLIENT_ID)');
    return;
  }

  if (apiState.token) {
    await onSignedIn();
  } else {
    renderSignIn(appEl);
  }
}

boot();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
