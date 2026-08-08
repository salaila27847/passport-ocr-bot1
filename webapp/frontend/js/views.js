import { api, ApiError } from './api.js';
import { renderSignInButton, signOut } from './auth.js';

const PHOTO_TYPES = [
  { value: 'PASSPORT', label: '🛂 พาสปอร์ต' },
  { value: 'Return Ticket', label: '✈️ ตั๋วเครื่องบิน' },
  { value: 'Accomodation', label: '🏨 ที่พัก' },
  { value: 'ETC', label: '📎 อื่นๆ' },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showError(container, err) {
  const message = err instanceof ApiError ? err.message : (err && err.message) || String(err);
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = message;
  container.prepend(box);
}

// ==========================================
// Sign-in
// ==========================================
export function renderSignIn(root) {
  root.innerHTML = `
    <div class="center-screen">
      <div class="card signin-card">
        <div class="signin-icon">🛂</div>
        <h1>ระบบเช็คอินพาสปอร์ต</h1>
        <p class="hint">เข้าสู่ระบบด้วยบัญชี Google ที่ได้รับอนุญาต</p>
        <div id="google-signin-btn"></div>
      </div>
    </div>`;
  renderSignInButton(document.getElementById('google-signin-btn'));
}

export function renderConfigError(root, message) {
  root.innerHTML = `<div class="center-screen"><div class="card"><p class="error-box">${escapeHtml(message)}</p></div></div>`;
}

// ==========================================
// เลือกแผ่นงาน
// ==========================================
export async function renderSheetSelect(root, ctx) {
  root.innerHTML = `
    <header>ระบบเช็คอิน<small>${escapeHtml(ctx.me.name)} · <a href="#" id="signout-link">ออกจากระบบ</a></small></header>
    <main class="container">
      <div class="card"><div class="section-title">📂 เลือกแผ่นงาน</div><div id="sheet-list" class="list-loading">กำลังโหลด...</div></div>
    </main>`;
  document.getElementById('signout-link').addEventListener('click', (e) => {
    e.preventDefault();
    signOut();
    location.reload();
  });

  const listEl = document.getElementById('sheet-list');
  try {
    const sheets = await api.listSheets();
    if (sheets.length === 0) {
      listEl.innerHTML = '<p class="hint">ไม่พบไฟล์ Google Sheets ในโฟลเดอร์ที่ตั้งค่าไว้</p>';
      return;
    }
    listEl.innerHTML = sheets.map((s, i) => `
      <button class="list-item ${i === 0 ? 'featured' : ''}" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}">
        ${i === 0 ? '⭐️ ' : ''}${escapeHtml(s.path ? `${s.path}/${s.name}` : s.name)}
      </button>`).join('');
    listEl.querySelectorAll('.list-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        ctx.setSheet(btn.dataset.id, btn.dataset.name);
        ctx.navigate('/seq');
      });
    });
  } catch (err) {
    listEl.innerHTML = '';
    showError(listEl.parentElement, err);
  }
}

// ==========================================
// Dashboard: เลือก/จอง SEQ
// ==========================================
export function renderSeqDashboard(root, ctx) {
  if (!ctx.sheetId) { ctx.navigate('/sheets'); return; }

  root.innerHTML = `
    <header>${escapeHtml(ctx.sheetName)}<small>${escapeHtml(ctx.me.name)} · <a href="#" id="change-sheet-link">เปลี่ยนแผ่นงาน</a></small></header>
    <main class="container">
      <div class="card">
        <div class="section-title">🔢 เลือก SEQ</div>
        <div class="field">
          <input type="text" id="seq-input" placeholder="เช่น 12">
        </div>
        <button class="btn-primary" id="go-seq-btn" style="width:100%;">ไปที่ SEQ นี้</button>
      </div>
      <div class="card">
        <div class="section-title">📌 จอง SEQ ใหม่</div>
        <div class="field">
          <label>จำนวน</label>
          <input type="number" id="book-count" min="1" value="1">
        </div>
        <div class="field">
          <label>Flight No. (ไม่บังคับ)</label>
          <input type="text" id="book-flight" placeholder="เช่น TG123">
        </div>
        <button class="btn-secondary" id="book-btn" style="width:100%;">จอง SEQ</button>
        <div id="book-result"></div>
      </div>
    </main>`;

  document.getElementById('change-sheet-link').addEventListener('click', (e) => {
    e.preventDefault();
    ctx.navigate('/sheets');
  });

  document.getElementById('go-seq-btn').addEventListener('click', () => {
    const seq = document.getElementById('seq-input').value.trim();
    if (!seq) return;
    ctx.navigate(`/seq/${encodeURIComponent(seq)}`);
  });

  document.getElementById('book-btn').addEventListener('click', async () => {
    const btn = document.getElementById('book-btn');
    const count = parseInt(document.getElementById('book-count').value, 10);
    const flightNo = document.getElementById('book-flight').value.trim();
    const resultEl = document.getElementById('book-result');
    if (!count || count <= 0) return;
    btn.disabled = true;
    resultEl.innerHTML = '';
    try {
      const res = await api.bookSeqs(ctx.sheetId, count, flightNo);
      resultEl.innerHTML = `<p class="hint">จองสำเร็จ: ${res.booked_seqs.map(escapeHtml).join(', ')}</p>` +
        res.booked_seqs.map((seq) => `<button class="list-item seq-shortcut" data-seq="${escapeHtml(seq)}">ไปที่ SEQ ${escapeHtml(seq)}</button>`).join('');
      resultEl.querySelectorAll('.seq-shortcut').forEach((b) => {
        b.addEventListener('click', () => ctx.navigate(`/seq/${encodeURIComponent(b.dataset.seq)}`));
      });
    } catch (err) {
      showError(resultEl, err);
    } finally {
      btn.disabled = false;
    }
  });
}

// ==========================================
// SEQ hub
// ==========================================
export function renderSeqHub(root, ctx, seq) {
  root.innerHTML = `
    <header>SEQ ${escapeHtml(seq)}<small>${escapeHtml(ctx.sheetName)}</small></header>
    <main class="container">
      <div class="card">
        <button class="list-item" id="photos-link">🗂️ จัดการรูปภาพ</button>
        <button class="list-item" id="extra-info-link">📝 ข้อมูลเพิ่มเติม</button>
        <button class="list-item" id="back-link">🔙 กลับไปเลือก SEQ อื่น</button>
      </div>
    </main>`;
  document.getElementById('photos-link').addEventListener('click', () => ctx.navigate(`/seq/${encodeURIComponent(seq)}/photos`));
  document.getElementById('extra-info-link').addEventListener('click', () => ctx.navigate(`/seq/${encodeURIComponent(seq)}/extra-info`));
  document.getElementById('back-link').addEventListener('click', () => ctx.navigate('/seq'));
}

// ==========================================
// จัดการรูปภาพ
// ==========================================
export async function renderPhotos(root, ctx, seq) {
  root.innerHTML = `
    <header>🗂️ รูปภาพ SEQ ${escapeHtml(seq)}<small>${escapeHtml(ctx.sheetName)} · <a href="#" id="back-link">กลับ</a></small></header>
    <main class="container">
      ${PHOTO_TYPES.map((t) => `
        <div class="card photo-card" data-type="${escapeHtml(t.value)}">
          <div class="section-title">${t.label}</div>
          <div class="photo-preview" id="preview-${cssId(t.value)}"><span class="no-photo">ยังไม่มีรูป</span></div>
          <label class="btn-import upload-label">
            📷 ถ่าย/เลือกรูป
            <input type="file" accept="image/*" capture="environment" class="photo-input" data-type="${escapeHtml(t.value)}" hidden>
          </label>
          <div class="ocr-msg" id="status-${cssId(t.value)}"></div>
        </div>`).join('')}
    </main>`;

  document.getElementById('back-link').addEventListener('click', (e) => {
    e.preventDefault();
    ctx.navigate(`/seq/${encodeURIComponent(seq)}`);
  });

  root.querySelectorAll('.photo-input').forEach((input) => {
    input.addEventListener('change', () => handleUpload(ctx, seq, input));
  });

  for (const t of PHOTO_TYPES) {
    if (t.value === 'ETC') continue; // ETC ไม่มี endpoint ดูรูปเดี่ยว (มีได้หลายไฟล์ ดูใน Sheet โดยตรง)
    loadPreview(ctx, seq, t.value);
  }
}

async function loadPreview(ctx, seq, photoType) {
  const previewEl = document.getElementById(`preview-${cssId(photoType)}`);
  const photo = await api.getPhoto(ctx.sheetId, seq, ctx.sheetName, photoType);
  if (photo && photo.url) {
    previewEl.innerHTML = `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photoType)}">`;
  }
}

async function handleUpload(ctx, seq, input) {
  const file = input.files[0];
  if (!file) return;
  const photoType = input.dataset.type;
  const statusEl = document.getElementById(`status-${cssId(photoType)}`);
  statusEl.textContent = 'กำลังอัปโหลด...';
  statusEl.style.display = 'block';
  try {
    const res = await api.uploadPhoto(ctx.sheetId, seq, ctx.sheetName, photoType, file);
    statusEl.textContent = 'อัปโหลดสำเร็จ';
    const previewEl = document.getElementById(`preview-${cssId(photoType)}`);
    if (previewEl) previewEl.innerHTML = `<img src="${escapeHtml(res.url)}" alt="${escapeHtml(photoType)}">`;
    if (res.ocr_queued) {
      statusEl.textContent = 'อัปโหลดสำเร็จ กำลังอ่าน OCR... (ดูผลได้ที่หน้าข้อมูลเพิ่มเติม)';
    }
  } catch (err) {
    statusEl.textContent = err instanceof ApiError ? err.message : String(err);
  } finally {
    input.value = '';
  }
}

function cssId(photoType) {
  return photoType.replace(/[^a-zA-Z0-9]/g, '');
}

// ==========================================
// ข้อมูลเพิ่มเติม
// ==========================================
export async function renderExtraInfo(root, ctx, seq) {
  root.innerHTML = `
    <header>📝 ข้อมูลเพิ่มเติม SEQ ${escapeHtml(seq)}<small>${escapeHtml(ctx.sheetName)} · <a href="#" id="back-link">กลับ</a></small></header>
    <main class="container"><div class="card"><p class="hint">กำลังโหลด...</p></div></main>`;
  document.getElementById('back-link').addEventListener('click', (e) => {
    e.preventDefault();
    ctx.navigate(`/seq/${encodeURIComponent(seq)}`);
  });

  let info;
  try {
    info = await api.getExtraInfo(ctx.sheetId, seq, ctx.sheetName);
  } catch (err) {
    const main = root.querySelector('main');
    main.innerHTML = '<div class="card"></div>';
    showError(main.querySelector('.card'), err);
    return;
  }

  const d = info.dropdowns;
  const main = root.querySelector('main');
  main.innerHTML = `
    <div class="card">
      <div class="section-title">🛂 ข้อมูลจาก OCR (Passport)</div>
      <button type="button" class="btn-import" id="btn-import-ocr">📥 นำเข้าข้อมูล OCR</button>
      <div class="ocr-msg" id="ocr-msg"></div>
      <div class="passport-photo-wrap">
        ${info.passport_photo_url
          ? `<img src="${escapeHtml(info.passport_photo_url)}" alt="รูป Passport">`
          : '<div class="no-photo">ยังไม่มีรูป Passport</div>'}
      </div>
      <div class="field"><label>สัญชาติ (Nationality)</label><input type="text" id="f-nationality" value="${escapeHtml(info.nationality)}"></div>
      <div class="field"><label>เลขที่หนังสือเดินทาง</label><input type="text" id="f-passport-no" value="${escapeHtml(info.passport_no)}"></div>
      <div class="field"><label>ชื่อ-นามสกุล</label><input type="text" id="f-name" value="${escapeHtml(info.name)}"></div>
      <div class="name-hint" id="name-hint"></div>
      <div class="field">
        <label>เพศ</label>
        <div class="sex-row">
          <label class="checkbox-field"><input type="checkbox" id="f-sex-m" ${info.sex_m ? 'checked' : ''}><span>ชาย (M)</span></label>
          <label class="checkbox-field"><input type="checkbox" id="f-sex-f" ${info.sex_f ? 'checked' : ''}><span>หญิง (F)</span></label>
        </div>
      </div>
    </div>
    <div class="card">
      ${buildSelect('f-group-old', 'กลุ่มเดิม (6 กลุ่ม)', d.group_old, info.group_old)}
      ${buildSelect('f-group-new', 'กลุ่มใหม่ (10 กลุ่ม)', d.group_new, info.group_new)}
      ${buildSelect('f-visa-now', 'VISA (NOW)', d.visa, info.visa_now)}
      ${buildSelect('f-visa-ex', 'VISA (EX)', d.visa, info.visa_ex)}
      <div class="field checkbox-field"><input type="checkbox" id="f-deport" ${info.deport ? 'checked' : ''}><label for="f-deport" style="margin:0;">DEPORT</label></div>
      ${buildSelect('f-clauses', 'CLAUSES', d.clause, info.clauses)}
      <div class="field"><label>NOTE</label><textarea id="f-note">${escapeHtml(info.note)}</textarea></div>
    </div>
    <div class="footer-bar"><button class="btn-primary" id="btn-save" style="width:100%;">💾 บันทึก</button></div>`;

  const sexM = document.getElementById('f-sex-m');
  const sexF = document.getElementById('f-sex-f');
  sexM.addEventListener('change', () => { if (sexM.checked) sexF.checked = false; });
  sexF.addEventListener('change', () => { if (sexF.checked) sexM.checked = false; });

  document.getElementById('btn-import-ocr').addEventListener('click', async () => {
    const btn = document.getElementById('btn-import-ocr');
    const msgBox = document.getElementById('ocr-msg');
    msgBox.style.display = 'none';
    btn.disabled = true;
    try {
      const res = await api.getOcrPreview(ctx.sheetId, seq);
      if (res.status !== 'done') {
        msgBox.textContent = res.message || 'ยังไม่มีผลลัพธ์ OCR';
        msgBox.style.display = 'block';
        return;
      }
      if (res.nationality) document.getElementById('f-nationality').value = res.nationality;
      if (res.passport_no) document.getElementById('f-passport-no').value = res.passport_no;
      if (res.sex === 'M') { sexM.checked = true; sexF.checked = false; }
      else if (res.sex === 'F') { sexF.checked = true; sexM.checked = false; }
      if (res.pe_name || res.typhoon_name) {
        document.getElementById('f-name').value = res.pe_name || res.typhoon_name;
        const hint = document.getElementById('name-hint');
        hint.textContent = `OCR อ่านได้ — PassportEye: ${res.pe_name || '-'} | Typhoon: ${res.typhoon_name || '-'}`;
        hint.style.display = 'block';
      }
      if (res.remark) alert('⚠️ ' + res.remark);
    } catch (err) {
      msgBox.textContent = err instanceof ApiError ? err.message : String(err);
      msgBox.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    const fields = {
      nationality: document.getElementById('f-nationality').value,
      passport_no: document.getElementById('f-passport-no').value,
      name: document.getElementById('f-name').value,
      sex_m: sexM.checked,
      sex_f: sexF.checked,
      group_old: document.getElementById('f-group-old').value,
      group_new: document.getElementById('f-group-new').value,
      visa_now: document.getElementById('f-visa-now').value,
      visa_ex: document.getElementById('f-visa-ex').value,
      deport: document.getElementById('f-deport').checked,
      clauses: document.getElementById('f-clauses').value,
      note: document.getElementById('f-note').value,
    };
    try {
      await api.saveExtraInfo(ctx.sheetId, seq, fields);
      main.innerHTML = '<div class="done-screen"><div class="icon">✅</div><p>บันทึกข้อมูลเรียบร้อยแล้ว</p></div>';
    } catch (err) {
      btn.disabled = false;
      alert(err instanceof ApiError ? err.message : String(err));
    }
  });
}

function buildSelect(id, label, options, selected) {
  const optionsHtml = (options || []).map((opt) =>
    `<option value="${escapeHtml(opt)}" ${opt === selected ? 'selected' : ''}>${escapeHtml(opt)}</option>`
  ).join('');
  return `<div class="field"><label>${label}</label><select id="${id}"><option value="">— ไม่ระบุ —</option>${optionsHtml}</select></div>`;
}
