const BACKEND_URL = window.BACKEND_URL || 'http://localhost:8080';

fetch(`${BACKEND_URL}/healthz`)
  .then((r) => r.json())
  .then((res) => {
    document.getElementById('backend-status').textContent = res.status === 'ok' ? 'เชื่อมต่อสำเร็จ' : 'มีปัญหา';
  })
  .catch(() => {
    document.getElementById('backend-status').textContent = 'เชื่อมต่อ backend ไม่ได้';
  });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
