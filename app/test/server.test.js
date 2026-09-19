const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const storeFiles = ['pins.json', 'reports.json', 'posts.json', 'spot-suggestions.json', 'reservations.json'];
const backup = Object.fromEntries(storeFiles.map(name => [name, fs.readFileSync(path.join(root, 'store', name), 'utf8')]));
const port = 3011;
let server;

function request(pathname, body, method = body ? 'POST' : 'GET') {
  return fetch(`http://127.0.0.1:${port}${pathname}`, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method })
    .then(async response => { const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; } return { status: response.status, body: parsed }; });
}

test.before(async () => {
  for (const name of storeFiles) fs.writeFileSync(path.join(root, 'store', name), '[]\n');
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    server.once('error', reject);
  });
});

test.after(() => {
  server?.kill();
  for (const name of storeFiles) fs.writeFileSync(path.join(root, 'store', name), backup[name]);
});

test('private files are not public and vendor files are public', async () => {
  assert.equal((await request('/server.js')).status, 404);
  assert.equal((await request('/store/pins.json')).status, 404);
  assert.equal((await request('/vendor/leaflet.js')).status, 200);
});

test('pin validation blocks contacts, outside locations, duplicates, and bursts', async () => {
  const base = { deviceId: 'node-test-device', type: 'facility', title: '테스트 핀', description: '캠퍼스 안 테스트', lat: 35.9005, lon: 128.8505 };
  assert.equal((await request('/api/pins', base)).status, 201);
  const duplicate = await request('/api/pins', base);
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.body.error, 'duplicate_recent');
  assert.equal((await request('/api/pins', { ...base, deviceId: 'contact-device', title: '010-1234-5678' })).status, 400);
  assert.equal((await request('/api/pins', { ...base, deviceId: 'outside-device', lat: 35.95, lon: 128.95 })).status, 400);
  const publicPins = await request('/api/pins');
  assert.equal(publicPins.body.some(item => item.deviceId), false);
  const ownPins = await request('/api/pins?deviceId=node-test-device');
  assert.equal(ownPins.body.some(item => item.mine === true && !item.deviceId), true);
  assert.equal((await request('/api/pins', { ...base, deviceId: 'type-device', type: 'news', title: '가짜 소식 핀' })).status, 400);
  const personal = await request('/api/pins', { ...base, deviceId: 'student-id-device', title: '12345678', description: '학번 12345678' });
  assert.equal(personal.status, 400);
  assert.equal(personal.body.reason, '개인정보는 적을 수 없어요.');
  for (let index = 0; index < 5; index += 1) assert.equal((await request('/api/pins', { ...base, deviceId: 'burst-device', title: `빠른 핀 ${index}` })).status, 201);
  assert.equal((await request('/api/pins', { ...base, deviceId: 'burst-device', title: '빠른 핀 6' })).status, 429);
});

test('one device reports once and three devices hide a pin', async () => {
  const pin = await request('/api/pins', { deviceId: 'report-owner', type: 'lost', title: '신고 테스트', description: '테스트 분실물', lat: 35.9005, lon: 128.8505 });
  assert.equal(pin.status, 201);
  assert.equal((await request('/api/reports', { pinId: pin.body.id, deviceId: 'report-a' })).status, 201);
  assert.equal((await request('/api/reports', { pinId: pin.body.id, deviceId: 'report-a' })).status, 409);
  assert.equal((await request('/api/reports', { pinId: pin.body.id, deviceId: 'report-b' })).body.hidden, false);
  assert.equal((await request('/api/reports', { pinId: pin.body.id, deviceId: 'report-c' })).body.hidden, true);
  const visiblePins = await request('/api/pins');
  assert.equal(visiblePins.body.some(item => item.id === pin.body.id), false);
});

test('reservations lock a slot, hide nicknames, and restrict cancellation', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const tomorrowDate = new Date(`${today}T12:00:00+09:00`);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(tomorrowDate);
  const slot = { facilityId: '1185977450', date: tomorrow, startHour: 10, nickname: '예약테스트', deviceId: 'reservation-device-a' };
  const [first, second] = await Promise.all([request('/api/reservations', slot), request('/api/reservations', { ...slot, deviceId: 'reservation-device-b', nickname: '다른테스트' })]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const publicReservations = await request('/api/reservations');
  assert.equal(publicReservations.body.some(item => item.nickname || item.deviceId), false);
  const ownerId = first.status === 201 ? first.body.id : second.body.id;
  const ownerDevice = first.status === 201 ? slot.deviceId : 'reservation-device-b';
  assert.equal((await request(`/api/reservations?id=${ownerId}&deviceId=wrong-device`, undefined, 'DELETE')).status, 403);
  assert.equal((await request(`/api/reservations?id=${ownerId}&deviceId=${ownerDevice}`, undefined, 'DELETE')).status, 200);
  const dailyBase = { facilityId: '1185977450', date: tomorrow, nickname: '하루제한', deviceId: 'daily-limit-device' };
  assert.equal((await request('/api/reservations', { ...dailyBase, startHour: 11 })).status, 201);
  assert.equal((await request('/api/reservations', { ...dailyBase, startHour: 12 })).status, 201);
  const dailyThird = await request('/api/reservations', { ...dailyBase, startHour: 13 });
  assert.equal(dailyThird.status, 429);
  assert.equal(dailyThird.body.reason, '하루 두 개까지만 예약할 수 있어요.');
});

test('reporting a missing pin is rejected', async () => {
  const missing = await request('/api/reports', { pinId: 'not-a-real-pin', deviceId: 'report-test-device' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'pin_not_found');
});
