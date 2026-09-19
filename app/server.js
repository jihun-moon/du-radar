const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORE_DIR = path.join(ROOT, 'store');
const PORT = Number(process.env.PORT || 3000);
const allowedPinTypes = new Set(['facility', 'lost', 'report']);
const contactPattern = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d{2,3}[- .]?\d{3,4}[- .]?\d{4}))/i;
const studentIdPattern = /학번|\b\d{8}\b/i;
const reservationFacilities = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'data', 'facilities.json'), 'utf8')).facilities;
const reservationFacilityIds = new Set(reservationFacilities.map(facility => String(facility.id)));
let reservationQueue = Promise.resolve();
let weatherCache = null;
let campusBox = null;
try {
  const mapData = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'data', 'campus-map.json'), 'utf8'));
  const boundary = mapData.campusBoundary.geometry;
  const lats = boundary.map(point => point[0]);
  const lons = boundary.map(point => point[1]);
  const latMargin = 300 / 111320;
  const lonMargin = 300 / (111320 * Math.cos((lats.reduce((a, b) => a + b, 0) / lats.length) * Math.PI / 180));
  campusBox = { south: Math.min(...lats) - latMargin, north: Math.max(...lats) + latMargin, west: Math.min(...lons) - lonMargin, east: Math.max(...lons) + lonMargin };
} catch (error) {
  console.error('Campus boundary could not be loaded', error);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function safePublicPath(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes('\0') || decoded.includes('..') || decoded.includes('\\')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  return target === PUBLIC_DIR || target.startsWith(`${PUBLIC_DIR}${path.sep}`) ? target : null;
}

async function readStore(name) {
  const file = path.join(STORE_DIR, `${name}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeStore(name, value) {
  const file = path.join(STORE_DIR, `${name}.json`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, file);
}

async function collectJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('payload_too_large');
  }
  return JSON.parse(body || '{}');
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname.endsWith('/api/weather')) {
    try {
      if (weatherCache && weatherCache.expiresAt > Date.now()) {
        sendJson(res, 200, weatherCache.value);
        return true;
      }
      const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=35.90&longitude=128.85&current=temperature_2m,weather_code&timezone=Asia%2FSeoul');
      if (!response.ok) throw new Error(`weather_upstream_${response.status}`);
      const upstream = await response.json();
      if (!upstream.current) throw new Error('weather_missing_current');
      const value = { current: upstream.current, fetchedAt: new Date().toISOString(), cacheSeconds: 600 };
      weatherCache = { value, expiresAt: Date.now() + 600000 };
      sendJson(res, 200, value);
    } catch (error) {
      sendJson(res, 503, { error: 'weather_unavailable', reason: '날씨 정보를 불러오지 못했어요.' });
    }
    return true;
  }
  const resource = url.pathname === '/api/pins' ? 'pins' : url.pathname === '/api/posts' ? 'posts' : url.pathname === '/api/reports' ? 'reports' : url.pathname === '/api/spot-suggestions' ? 'spot-suggestions' : url.pathname === '/api/reactions' ? 'reactions' : null;
  const reservationResource = url.pathname === '/api/reservations';
  if (reservationResource && req.method === 'GET') {
    const reservations = await readStore('reservations');
    const deviceId = url.searchParams.get('deviceId');
    const result = reservations.filter(item => !deviceId || item.deviceId === deviceId).map(item => deviceId ? item : { id: item.id, facilityId: item.facilityId, date: item.date, startHour: item.startHour, endHour: item.endHour, createdAt: item.createdAt });
    sendJson(res, 200, result);
    return true;
  }
  if (reservationResource && req.method === 'POST') return createReservation(res, await collectJson(req));
  if (reservationResource && req.method === 'DELETE') return cancelReservation(req, res, url);
  if (reservationResource) { send(res, 405, 'Method Not Allowed'); return true; }
  if (!resource) return false;
  if (req.method === 'GET') {
    const values = await readStore(resource);
    if (resource === 'reactions') {
      sendJson(res, 200, values.reduce((counts, reaction) => { counts[reaction.pinId] = (counts[reaction.pinId] || 0) + 1; return counts; }, {}));
      return true;
    }
    if (resource === 'pins') {
      const deviceId = url.searchParams.get('deviceId');
      sendJson(res, 200, values.filter(pin => !pin.hidden).map(pin => { const { deviceId: storedDeviceId, ...safePin } = pin; return deviceId ? { ...safePin, mine: Boolean(storedDeviceId && storedDeviceId === deviceId) } : safePin; }));
    } else sendJson(res, 200, values);
    return true;
  }
  if (req.method === 'POST') {
    const incoming = await collectJson(req);
    const current = await readStore(resource);
    if (resource === 'reports') return handleReport(res, incoming, current);
    if (resource === 'spot-suggestions') {
      const spotId = String(incoming.spotId || '');
      const deviceId = String(incoming.deviceId || '');
      const lat = Number(incoming.lat);
      const lon = Number(incoming.lon);
      if (!spotId || !deviceId || !Number.isFinite(lat) || !Number.isFinite(lon) || !campusBox || lat < campusBox.south || lat > campusBox.north || lon < campusBox.west || lon > campusBox.east) { sendJson(res, 400, { error: 'invalid_suggestion', reason: '캠퍼스 안의 위치만 제안할 수 있어요.' }); return true; }
      if (current.some(suggestion => suggestion.spotId === spotId && suggestion.deviceId === deviceId && Date.now() - Date.parse(suggestion.createdAt) < 60000)) { sendJson(res, 409, { error: 'duplicate_suggestion', reason: '같은 기기의 위치 제안은 잠시 후 다시 할 수 있어요.' }); return true; }
      const suggestion = { id: randomUUID(), spotId, deviceId, lat, lon, createdAt: new Date().toISOString() };
      current.push(suggestion);
      await writeStore(resource, current);
      const count = current.filter(item => item.spotId === spotId).length;
      sendJson(res, 201, { ...suggestion, needsVerification: count >= 3, suggestionCount: count });
      return true;
    }
    if (resource === 'reactions') {
      const pinId = String(incoming.pinId || '');
      const deviceId = String(incoming.deviceId || '');
      if (!pinId || !deviceId) { sendJson(res, 400, { error: 'invalid_reaction', reason: '공감 정보를 확인해주세요.' }); return true; }
      if (current.some(reaction => reaction.pinId === pinId && reaction.deviceId === deviceId)) { sendJson(res, 409, { error: 'already_reacted', reason: '기기당 한 번만 공감할 수 있어요.' }); return true; }
      const reaction = { id: randomUUID(), pinId, deviceId, createdAt: new Date().toISOString() };
      current.push(reaction);
      await writeStore(resource, current);
      sendJson(res, 201, { reacted: true, pinId, count: current.filter(item => item.pinId === pinId).length });
      return true;
    }
    if (resource === 'pins') {
      const title = String(incoming.title || '').trim();
      const description = String(incoming.description || '').trim();
      const lat = Number(incoming.lat);
      const lon = Number(incoming.lon);
      const deviceId = String(incoming.deviceId || '');
      if (!allowedPinTypes.has(incoming.type)) { sendJson(res, 400, { error: 'invalid_type', reason: '핀 종류를 다시 선택해주세요.' }); return true; }
      if (!deviceId) { sendJson(res, 400, { error: 'missing_device', reason: '기기 확인값이 없어요. 페이지를 다시 열어주세요.' }); return true; }
      if (!title || title.length > 80 || !description || description.length > 100) { sendJson(res, 400, { error: 'invalid_text', reason: '제목과 설명을 확인해주세요. 설명은 100자까지 입력할 수 있어요.' }); return true; }
      if (studentIdPattern.test(`${title} ${description}`)) { sendJson(res, 400, { error: 'personal_data_not_allowed', reason: '개인정보는 적을 수 없어요.' }); return true; }
      if (contactPattern.test(`${title} ${description}`)) { sendJson(res, 400, { error: 'contact_not_allowed', reason: '전화번호, 이메일, 링크는 입력할 수 없어요.' }); return true; }
      if (!campusBox || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < campusBox.south || lat > campusBox.north || lon < campusBox.west || lon > campusBox.east) { sendJson(res, 400, { error: 'outside_area', reason: '캠퍼스 경계에서 300m 안쪽에서만 핀을 등록할 수 있어요.' }); return true; }
      const now = Date.now();
      const recent = current.filter(pin => pin.deviceId === deviceId && now - Date.parse(pin.createdAt) < 60000);
      if (recent.some(pin => pin.title === title && pin.description === description)) { sendJson(res, 429, { error: 'duplicate_recent', reason: '같은 내용은 1분 안에 다시 올릴 수 없어요.' }); return true; }
      if (recent.length >= 5) { sendJson(res, 429, { error: 'rate_limited', reason: '1분에 5개까지만 핀을 등록할 수 있어요.' }); return true; }
    }
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...incoming };
    current.push(record);
    await writeStore(resource, current);
    sendJson(res, 201, record);
    return true;
  }
  send(res, 405, 'Method Not Allowed');
  return true;
}

function kstNowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function addDays(iso, amount) { const date = new Date(`${iso}T12:00:00+09:00`); date.setDate(date.getDate() + amount); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date); }
function reservationError(res, status, error, reason) { sendJson(res, status, { error, reason }); return true; }
async function createReservation(res, incoming) {
  const run = reservationQueue.then(async () => {
    const facilityId = String(incoming.facilityId || '');
    const nickname = String(incoming.nickname || '').trim();
    const date = String(incoming.date || '');
    const startHour = Number(incoming.startHour);
    const now = kstNowParts();
    const today = `${now.year}-${now.month}-${now.day}`;
    const allowedDates = new Set(Array.from({ length: 7 }, (_, index) => addDays(today, index)));
    if (!reservationFacilityIds.has(facilityId)) return reservationError(res, 400, 'invalid_facility', '예약할 운동시설을 다시 선택해주세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !allowedDates.has(date)) return reservationError(res, 400, 'invalid_date', '오늘부터 일주일 안의 날짜만 예약할 수 있어요.');
    if (!Number.isInteger(startHour) || startHour < 9 || startHour > 20) return reservationError(res, 400, 'invalid_time', '09:00부터 20:00 시작 시간까지 한 시간 단위로 예약할 수 있어요.');
    if (date === today && startHour <= Number(now.hour)) return reservationError(res, 400, 'past_time', '이미 지난 시간은 예약할 수 없어요.');
    if (!nickname || nickname.length > 20 || /[\r\n]/.test(nickname) || contactPattern.test(nickname)) return reservationError(res, 400, 'invalid_nickname', '연락처가 아닌 닉네임만 20자 이내로 입력해주세요.');
    const current = await readStore('reservations');
    if (current.filter(item => item.deviceId === String(incoming.deviceId || '') && item.date === date).length >= 2) return reservationError(res, 429, 'daily_limit', '하루 두 개까지만 예약할 수 있어요.');
    if (current.some(item => item.facilityId === facilityId && item.date === date && item.startHour === startHour)) return reservationError(res, 409, 'slot_taken', '방금 다른 사람이 먼저 예약했어요. 다른 시간을 골라주세요.');
    const record = { id: randomUUID(), facilityId, date, startHour, endHour: startHour + 1, nickname, deviceId: String(incoming.deviceId || ''), createdAt: new Date().toISOString(), seed: false };
    if (!record.deviceId) return reservationError(res, 400, 'missing_device', '기기 확인값이 없어요. 페이지를 다시 열어주세요.');
    current.push(record);
    await writeStore('reservations', current);
    sendJson(res, 201, { id: record.id, facilityId, date, startHour, endHour: startHour + 1 });
    return true;
  });
  reservationQueue = run.catch(() => {});
  return run;
}
async function cancelReservation(req, res, url) {
  const deviceId = url.searchParams.get('deviceId');
  const id = url.searchParams.get('id');
  if (!deviceId || !id) return reservationError(res, 400, 'missing_cancel_fields', '예약을 취소할 기기 정보가 없어요.');
  const current = await readStore('reservations');
  const target = current.find(item => item.id === id);
  if (!target) return reservationError(res, 404, 'reservation_not_found', '예약을 찾을 수 없어요.');
  if (target.deviceId !== deviceId) return reservationError(res, 403, 'not_owner', '예약한 기기에서만 취소할 수 있어요.');
  await writeStore('reservations', current.filter(item => item.id !== id));
  sendJson(res, 200, { canceled: true, id });
  return true;
}

async function handleReport(res, incoming, reports) {
  const pinId = String(incoming.pinId || '');
  const deviceId = String(incoming.deviceId || '');
  if (!pinId || !deviceId) { sendJson(res, 400, { error: 'missing_report_fields', reason: '신고 정보를 확인해주세요.' }); return true; }
  const pins = await readStore('pins');
  if (!pins.some(pin => pin.id === pinId && !pin.hidden)) { sendJson(res, 404, { error: 'pin_not_found', reason: '신고할 핀을 찾을 수 없어요.' }); return true; }
  if (reports.some(report => report.pinId === pinId && report.deviceId === deviceId)) { sendJson(res, 409, { error: 'already_reported', reason: '이 핀은 기기당 한 번만 신고할 수 있어요.' }); return true; }
  reports.push({ id: randomUUID(), pinId, deviceId, createdAt: new Date().toISOString() });
  await writeStore('reports', reports);
  const uniqueReports = new Set(reports.filter(report => report.pinId === pinId).map(report => report.deviceId));
  if (uniqueReports.size >= 3) {
    const pins = await readStore('pins');
    const pin = pins.find(item => item.id === pinId);
    if (pin) { pin.hidden = true; pin.hiddenAt = new Date().toISOString(); pin.hiddenReason = '서로 다른 기기 3곳에서 신고됨'; await writeStore('pins', pins); }
  }
  sendJson(res, 201, { reported: true, hidden: uniqueReports.size >= 3, reason: uniqueReports.size >= 3 ? '신고가 3건 접수되어 핀을 숨겼어요.' : '신고가 접수되었어요.' });
  return true;
}

async function ensureReservationSeeds() {
  const now = kstNowParts();
  const today = `${now.year}-${now.month}-${now.day}`;
  const current = await readStore('reservations');
  const seeds = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(today, offset);
    const weekday = new Date(`${date}T12:00:00+09:00`).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const hours = weekend ? [17, 18, 19] : [18, 19];
    hours.forEach((startHour, index) => {
      const facility = reservationFacilities[(offset + index) % reservationFacilities.length];
      const id = `seed-reservation-${facility.id}-${date}-${startHour}`;
      if (!current.some(item => item.id === id)) seeds.push({ id, facilityId: String(facility.id), date, startHour, endHour: startHour + 1, nickname: '발표용', deviceId: 'seed-device', createdAt: new Date().toISOString(), seed: true });
    });
  }
  if (seeds.length) await writeStore('reservations', current.concat(seeds));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await handleApi(req, res, url)) return;
    if (url.pathname === '/server.js' || url.pathname.startsWith('/store') || url.pathname.startsWith('/.')) {
      send(res, 404, 'Not Found');
      return;
    }
    if (url.pathname === '/__preview-bridge.js') {
      const bridge = await fsp.readFile(path.join(PUBLIC_DIR, '__preview-bridge.js'));
      send(res, 200, bridge, 'text/javascript; charset=utf-8');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      const favicon = await fsp.readFile(path.join(PUBLIC_DIR, 'icons', 'favicon.svg'));
      send(res, 200, favicon, 'image/svg+xml');
      return;
    }
    const file = safePublicPath(url.pathname);
    if (!file) {
      send(res, 403, 'Forbidden');
      return;
    }
    const stat = await fsp.stat(file);
    if (!stat.isFile()) {
      send(res, 404, 'Not Found');
      return;
    }
    send(res, 200, await fsp.readFile(file), mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not Found');
    if (error.message === 'payload_too_large') return send(res, 413, 'Payload Too Large');
    if (error instanceof SyntaxError) return send(res, 400, 'Invalid JSON');
    console.error(error);
    send(res, 500, 'Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  await ensureReservationSeeds();
  console.log(`DU Radar server listening on http://localhost:${PORT}`);
});