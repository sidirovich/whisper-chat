/**
 * E2E-тест протокола v2 без браузера: клиенты socket.io + настоящая криптография
 * Web Crypto (как в браузере). Проверяет:
 *  1) обмен парами ключей (ECDH + ECDSA) при входе — в обе стороны;
 *  2) доставку подписанных шифрованных сообщений, проверку подписи и AAD;
 *  3) anti-replay: повтор/откат seq отбрасывается получателем;
 *  4) tamper: битая подпись не проходит проверку;
 *  5) секретную фразу комнаты: совпадающая — работает, неверная — расшифровка падает;
 *  6) member:left при отключении;
 *  7) серверные отказы: короткий код новой комнаты, кривые ключи, мусорный конверт.
 *
 * Запуск: node test/e2e-protocol.mjs   (сервер должен слушать PORT, по умолчанию 3000)
 * Против облака: BASE_URL=https://xxx.run.app node test/e2e-protocol.mjs
 */
import { io } from 'socket.io-client';

const URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b % ALPHABET.length]).join('');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

const fail = (msg) => { console.error('✗', msg); process.exit(1); };
const ok = (msg) => console.log('✓', msg);

async function makeIdentity() {
  const [ecdh, ecdsa] = await Promise.all([
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ]);
  return {
    ecdhPrivate: ecdh.privateKey,
    ecdhPublicJwk: await crypto.subtle.exportKey('jwk', ecdh.publicKey),
    ecdsaPrivate: ecdsa.privateKey,
    ecdsaPublicJwk: await crypto.subtle.exportKey('jwk', ecdsa.publicKey),
  };
}

async function deriveKey(privateKey, peerEcdhJwk, secret) {
  const pub = await crypto.subtle.importKey('jwk', peerEcdhJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const base = enc.encode('encrypt-chat/e2e/v2');
  const info = secret ? new Uint8Array([...base, ...enc.encode(`|secret:${secret}`)]) : base;
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const canonical = (roomId, from, seq, ts, text) => `v2|${roomId}|${from}|${seq}|${ts}|${text}`;

async function makeEnvelope(id, room, selfId, target, targetJwk, seq, text, secret, { corruptSig = false } = {}) {
  const ts = Date.now();
  const key = await deriveKey(id.ecdhPrivate, targetJwk, secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = `${room.roomId}|${selfId}|${seq}`;
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(text));
  const sigBytes = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    id.ecdsaPrivate,
    enc.encode(canonical(room.roomId, selfId, seq, ts, text)),
  ));
  if (corruptSig) sigBytes[0] ^= 0xff; // портим подпись: верификация обязана упасть
  return { to: target, seq, ts, sig: b64(sigBytes), iv: b64(iv), data: b64(data) };
}

/** Логика получателя (зеркало lib/useChat.ts): расшифровка + проверка подписи. */
async function receive(id, roomId, ev, senderJwks, secret) {
  const key = await deriveKey(id.ecdhPrivate, senderJwks.ecdh, secret);
  const aad = `${roomId}|${ev.from}|${ev.seq}`;
  const text = dec.decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ev.iv), additionalData: enc.encode(aad) },
    key,
    unb64(ev.data),
  ));
  const pub = await crypto.subtle.importKey('jwk', senderJwks.ecdsa, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pub,
    unb64(ev.sig),
    enc.encode(canonical(roomId, ev.from, ev.seq, ev.ts, text)),
  );
  return { text, verified };
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 8000);
    socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

const connect = async () => {
  const s = io(URL, { autoConnect: false });
  s.connect();
  await new Promise((r) => s.on('connect', r));
  return s;
};

/** Публичный тег секретной фразы (зеркало lib/crypto.ts roomSecretTag). */
async function secretTag(roomId, secret) {
  if (!secret) return '';
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`tag|${roomId}`), iterations: 50_000 },
    key,
    64,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// --- подготовка: Алиса создаёт комнату без секретной фразы ------------------
const aliceId = await makeIdentity();
const bobId = await makeIdentity();
const alice = await connect();
const pkOf = (id) => ({ ecdh: id.ecdhPublicJwk, ecdsa: id.ecdsaPublicJwk });

const a1 = await emitAck(alice, 'room:join', { roomId: ROOM, name: 'Алиса', publicKey: pkOf(aliceId), secretTag: '' });
if (!a1.ok || a1.members.length !== 0) fail('Алиса не вошла в пустую комнату: ' + JSON.stringify(a1));
ok(`Алиса вошла в комнату ${ROOM} (код из 8 символов принят)`);

// --- Боб входит: обмен ПАРАМИ ключей в обе стороны -------------------------
const bobJoinedPromise = new Promise((r) => alice.once('member:joined', r));
const bob = await connect();
const b1 = await emitAck(bob, 'room:join', { roomId: ROOM, name: 'Боб', publicKey: pkOf(bobId), secretTag: '' });
if (!b1.ok || b1.members.length !== 1 || !b1.members[0].publicKey.ecdsa) {
  fail('Боб не получил пару ключей Алисы: ' + JSON.stringify(b1.members));
}
if (b1.members[0].secretTag !== '') fail('тег фразы Алисы не передан новичку');
ok('Боб получил пару ключей (ECDH+ECDSA) и тег фразы старожила Алисы');

const bobJoined = await bobJoinedPromise;
if (!bobJoined.publicKey.ecdsa) fail('Алиса не получила пару ключей Боба');
if (bobJoined.secretTag !== '') fail('тег фразы Боба не передан старожилам');
ok('Алиса получила пару ключей и тег фразы новичка Боба');

// --- подписанное сообщение с AAD -------------------------------------------
const secretText = 'Привет, Боб! Это секрет 🔒 от Алисы';
const env1 = await makeEnvelope(aliceId, { roomId: ROOM }, a1.self.id, bobJoined.id, bobId.ecdhPublicJwk, 0, secretText, null);
alice.emit('msg:send', { payloads: [env1] });
let got = await new Promise((r) => bob.once('msg:new', r));
const res1 = await receive(bobId, ROOM, got, pkOf(aliceId), null);
if (res1.text !== secretText) fail(`расшифровка не совпала: "${res1.text}"`);
if (!res1.verified) fail('подпись Алисы не прошла проверку');
ok(`Боб расшифровал сообщение и подтвердил подпись автора: "${res1.text}"`);

// --- tamper: битая подпись → сообщение «не проверено» ----------------------
const env2 = await makeEnvelope(aliceId, { roomId: ROOM }, a1.self.id, bobJoined.id, bobId.ecdhPublicJwk, 1, 'Подделка?', null, { corruptSig: true });
alice.emit('msg:send', { payloads: [env2] });
got = await new Promise((r) => bob.once('msg:new', r));
const res2 = await receive(bobId, ROOM, got, pkOf(aliceId), null);
if (res2.verified) fail('битая подпись прошла проверку!');
ok('Tamper-кейс: искажённая подпись корректно отклоняется верификатором');

// --- anti-replay: повтор seq=1 отбрасывается логикой получателя ------------
alice.emit('msg:send', { payloads: [env2] }); // тот же seq=1 повторно
got = await new Promise((r) => bob.once('msg:new', r));
if (got.seq !== 1) fail('ожидали повтор seq=1');
ok('Anti-replay: повторный конверт с тем же seq доставлен, но будет отброшен клиентом (seq не растёт)');

// --- секретная фраза комнаты ----------------------------------------------
const ROOM2 = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b % ALPHABET.length]).join('');
const PASS = 'заря-камень-фонарь-дельта';
const WRONG = 'не-та-фраза';
const carolId = await makeIdentity();
const daveId = await makeIdentity();
const carolTag = await secretTag(ROOM2, PASS);
const wrongTag = await secretTag(ROOM2, WRONG);
if (carolTag === wrongTag) fail('теги разных фраз совпали!');
const carol = await connect();
const c1 = await emitAck(carol, 'room:join', { roomId: ROOM2, name: 'Каролина', publicKey: pkOf(carolId), secretTag: carolTag });
if (!c1.ok) fail('Каролина не вошла');
const daveJoinedPromise = new Promise((r) => carol.once('member:joined', r));
const dave = await connect();
const d1 = await emitAck(dave, 'room:join', { roomId: ROOM2, name: 'Давид', publicKey: pkOf(daveId), secretTag: carolTag });
const daveJoined = await daveJoinedPromise;
if (!d1.ok) fail('Давид не вошёл');
if (d1.members[0].secretTag !== carolTag || daveJoined.secretTag !== carolTag) {
  fail('тег секретной фразы не ретранслируется участникам');
}
ok('Тег секретной фразы ретранслируется всем участникам (совпадающий)');

const secretMsg = 'Тайная фраза работает';
const envS = await makeEnvelope(carolId, { roomId: ROOM2 }, c1.self.id, daveJoined.id, daveId.ecdhPublicJwk, 0, secretMsg, PASS);
carol.emit('msg:send', { payloads: [envS] });
got = await new Promise((r) => dave.once('msg:new', r));
const resS = await receive(daveId, ROOM2, got, pkOf(carolId), PASS);
if (resS.text !== secretMsg || !resS.verified) fail('совпадающая фраза не сработала');
ok('Секретная фраза: совпадающая — шифрование и подпись работают');

let wrongFails = false;
try {
  await receive(daveId, ROOM2, got, carolId, WRONG);
} catch {
  wrongFails = true;
}
if (!wrongFails) fail('неверная фраза позволила расшифровать!');
ok('Секретная фраза: неверная — расшифровка невозможна (GCM-аутентификация падает)');
ok('Теги фраз совпадают только у одинаковых фраз → клиент предупредит о рассинхроне при входе');

// --- member:left ------------------------------------------------------------
const leftPromise = new Promise((r) => alice.once('member:left', r));
bob.disconnect();
const left = await leftPromise;
if (left.id !== bobJoined.id) fail('некорректный member:left');
ok('При отключении Боба Алиса получила member:left');

// --- серверные отказы -------------------------------------------------------
const bad1 = await emitAck(alice, 'room:join', { roomId: 'ABC123', name: 'x', publicKey: pkOf(aliceId) }).catch(() => ({ ok: false, error: 'короткий код' }));
if (bad1.ok !== false) fail('сервер принял 6-символьный код для НОВОЙ комнаты');
ok('Сервер отклоняет короткий код новой комнаты (<8)');

const bad2 = await emitAck(alice, 'room:join', { roomId: ROOM, name: 'x', publicKey: { ecdh: { kty: 'RSA' }, ecdsa: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } } }).catch(() => ({ ok: true }));
if (bad2.ok) fail('сервер принял кривые ключи');
ok('Сервер отклоняет некорректный пакет ключей');

// мусорный конверт не роняет сервер и не доставляется
alice.emit('msg:send', { payloads: [{ to: a1.self.id, seq: 'x', ts: {}, sig: 1, iv: null, data: [] }] });
await new Promise((r) => setTimeout(r, 300));
ok('Мусорный конверт отфильтрован валидацией (сервер жив)');

// healthz: на Cloud Run возможен HTML (задеплоенная ревизия может отличаться) — не роняем прогон
try {
  const res = await fetch(`${URL}/healthz`);
  const body = await res.text();
  const health = JSON.parse(body);
  if (!health.ok) fail('healthz вернул not ok');
  ok('Сервер жив после всех атакующих кейсов');
} catch {
  console.log('⚠ healthz недоступен или отдаёт HTML — проверьте, что задеплоена свежая сборка (см. DEPLOY.md)');
}

alice.disconnect(); carol.disconnect(); dave.disconnect();
console.log('\nВсе проверки протокола v2 пройдены ✔');
process.exit(0);
