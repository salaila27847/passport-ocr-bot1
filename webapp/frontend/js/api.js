export const BACKEND_URL = window.BACKEND_URL || 'http://localhost:8080';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const state = {
  token: sessionStorage.getItem('id_token') || '',
};

export function setToken(token) {
  state.token = token || '';
  if (token) sessionStorage.setItem('id_token', token);
  else sessionStorage.removeItem('id_token');
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers, {
    Authorization: state.token ? `Bearer ${state.token}` : '',
  });
  const res = await fetch(`${BACKEND_URL}${path}`, Object.assign({}, options, { headers }));

  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = null; }
  }

  if (res.status === 401) {
    setToken('');
    throw new ApiError((body && body.detail) || 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  }
  if (!res.ok) {
    throw new ApiError((body && body.detail) || `เกิดข้อผิดพลาด (${res.status})`, res.status);
  }
  return body;
}

export const api = {
  getConfig: () => fetch(`${BACKEND_URL}/config`).then((r) => r.json()),
  getMe: () => apiFetch('/me'),
  listSheets: () => apiFetch('/sheets'),
  getDropdowns: (sheetId) => apiFetch(`/sheets/${encodeURIComponent(sheetId)}/dropdowns`),
  bookSeqs: (sheetId, count, flightNo) => apiFetch(`/sheets/${encodeURIComponent(sheetId)}/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, flight_no: flightNo || '' }),
  }),
  getExtraInfo: (sheetId, seq, sheetName) => apiFetch(
    `/sheets/${encodeURIComponent(sheetId)}/seq/${encodeURIComponent(seq)}/extra-info?sheet_name=${encodeURIComponent(sheetName)}`
  ),
  saveExtraInfo: (sheetId, seq, fields) => apiFetch(
    `/sheets/${encodeURIComponent(sheetId)}/seq/${encodeURIComponent(seq)}/extra-info`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }
  ),
  getOcrPreview: (sheetId, seq) => apiFetch(
    `/sheets/${encodeURIComponent(sheetId)}/seq/${encodeURIComponent(seq)}/ocr-preview`
  ),
  uploadPhoto: (sheetId, seq, sheetName, photoType, file) => {
    const form = new FormData();
    form.append('sheet_name', sheetName);
    form.append('photo_type', photoType);
    form.append('file', file);
    return apiFetch(`/sheets/${encodeURIComponent(sheetId)}/seq/${encodeURIComponent(seq)}/photos`, {
      method: 'POST',
      body: form,
    });
  },
  getPhoto: (sheetId, seq, sheetName, photoType) => apiFetch(
    `/sheets/${encodeURIComponent(sheetId)}/seq/${encodeURIComponent(seq)}/photo?sheet_name=${encodeURIComponent(sheetName)}&photo_type=${encodeURIComponent(photoType)}`
  ).catch(() => null),
};
