/**
 * Кастомный сервер: Next.js (страницы) + Socket.IO (транспорт чата). Протокол v2.
 *
 * Сервер НЕ умеет расшифровывать сообщения: клиенты обмениваются парами открытых
 * ключей (ECDH P-256 + ECDSA P-256) и шифруют текст друг для друга (AES-256-GCM
 * с AAD) в браузере. Задача сервера — проксировать шифрованные пакеты и раздавать
 * открытые ключи. Сообщения подписаны ключом ECDSA отправителя: сервер не может
 * подделать автора, а AAD (roomId|sender|seq) исключает replay между комнатами.
 *
 * Вся информация о действующих чатах хранится исключительно в оперативной
 * памяти (Map rooms). Перезапуск процесса = все комнаты исчезли, истории нет.
 *
 * Анти-абьюз: лимит соединений на IP и всего, потолок комнат, rate-limit на
 * join/typing/сообщения/файлы, проверка Origin входящих подключений (чужие сайты
 * не могут пользоваться сокет-сервером), дефолт-привязка на 127.0.0.1.
 *
 * Файлы передаются как шифрованные чанки (file:offer / file:chunk): сервер
 * релеит непрозрачные куски шифротекта и не хранит ни байта из них.
 */
const { createServer } = require('http');
const express = require('express');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
// По умолчанию слушаем только loopback: наружу — осознанно через HOST=0.0.0.0
// и reverse-proxy с TLS (см. README).
const host = process.env.HOST || '127.0.0.1';

// --- ограничения протокола -------------------------------------------------
const ROOM_ID_RE = /^[A-Z2-9]{6,10}$/; // алфавит без похожих символов (0/O, 1/I)
const MIN_NEW_ROOM_LEN = 8; // новые комнаты — от 8 символов (перебор дороже)
const MAX_MEMBERS = 32;
const MAX_ROOMS = 1000;
const MAX_NAME_LEN = 24;
const MAX_CIPHER_B64 = 16 * 1024; // один шифротекст в base64
const MAX_PAYLOADS = 64;
const MAX_SIG_B64 = 512;
const MAX_FILE_CHUNK_B64 = 768 * 1024; // чанк файла (шифротекст+тег) в base64, запас до maxHttpBufferSize
const MAX_FILE_ID_LEN = 64; // fileId: [A-Za-z0-9_-]
const MAX_FILE_INDEX = 4096; // потолок номера чанка (100 МБ / 512 КБ ≈ 200)
const RATE_WINDOW_MS = 10_000;
const MSG_MAX = 40;
const JOIN_MAX = 5;
const TYPING_MAX = 10;
const FILE_OFFER_MAX = 20;
const FILE_CHUNK_MAX = 120; // ~61 МБ шифротекста на окно 10 с, суммарно по всем получателям
const MAX_SOCKETS = 2000;
const MAX_SOCKETS_PER_IP = 10;

const nextApp = next({ dev, hostname: host, port });
const handle = nextApp.getRequestHandler();

nextApp.prepare().then(() => {
  const expressApp = express();
  const httpServer = createServer(expressApp);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e6,
    pingInterval: 20_000,
    pingTimeout: 25_000,
  });

  /**
   * Живые комнаты: roomId -> Map<socketId, { name, publicKey }>.
   * Единственное хранилище состояния — оперативная память процесса.
   */
  const rooms = new Map();

  /** Счётчик соединений по IP для лимита MAX_SOCKETS_PER_IP. */
  const ipCounts = new Map();

  const isLoopback = (ip) =>
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  function isValidEcJwk(key) {
    return (
      key && typeof key === 'object' &&
      key.kty === 'EC' &&
      key.crv === 'P-256' &&
      typeof key.x === 'string' && key.x.length > 0 && key.x.length <= 256 &&
      typeof key.y === 'string' && key.y.length > 0 && key.y.length <= 256
    );
  }

  /** Публичный пакет v2: ключи шифрования и подписи. */
  function isValidPublicKey(pkg) {
    return !!pkg && isValidEcJwk(pkg.ecdh) && isValidEcJwk(pkg.ecdsa);
  }

  /**
   * Отпечаток секретной фразы комнаты (16 hex-символов или ''). Сама фраза
   * серверу не передаётся; тег нужен только участникам для сверки совпадения.
   */
  function normalizeSecretTag(raw) {
    const s = String(raw ?? '');
    return /^[0-9a-f]{0,32}$/.test(s) ? s : '';
  }

  /** NFKC + вырезание невидимых/bidi-символов: защита от спуфинга имён. */
  function normalizeName(raw) {
    return String(raw || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LEN);
  }

  /** Скользящее окно для rate-limit; возвращает false, если лимит исчерпан. */
  function allow(times, max, now) {
    const fresh = times.filter((t) => now - t < RATE_WINDOW_MS);
    times.length = 0;
    times.push(...fresh);
    if (fresh.length >= max) return false;
    fresh.push(now);
    return true;
  }

  /** Мягко выводим сокет из комнаты (если был) и оповещаем остальных. */
  function leaveRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.data.roomId = null;

    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.get(socket.id);
    room.delete(socket.id);
    if (room.size === 0) rooms.delete(roomId); // RAM-гигиена: пустые комнаты удаляем
    socket.leave(roomId);
    if (member) {
      socket.to(roomId).emit('member:left', { id: socket.id, name: member.name });
    }
  }

  // --- фильтр подключений: Origin и лимиты --------------------------------
  io.use((socket, next) => {
    const headers = socket.handshake.headers;
    const origin = headers.origin;
    if (origin && headers.host) {
      // Чужая веб-страница не должна уметь пользоваться нашим сокет-сервером.
      try {
        if (new URL(origin).host !== headers.host) {
          return next(new Error('origin mismatch'));
        }
      } catch {
        return next(new Error('origin mismatch'));
      }
    }
    const total = io.of('/').sockets.size + 1;
    if (total > MAX_SOCKETS) return next(new Error('server busy'));
    const ip = socket.handshake.address || 'unknown';
    const ipCount = (ipCounts.get(ip) || 0) + 1;
    if (ipCount > MAX_SOCKETS_PER_IP) return next(new Error('too many connections'));
    ipCounts.set(ip, ipCount);
    socket.data.ip = ip;
    next();
  });

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.msgTimes = [];
    socket.data.joinTimes = [];
    socket.data.typingTimes = [];
    socket.data.fileOfferTimes = [];
    socket.data.fileChunkTimes = [];

    socket.on('disconnect', () => {
      leaveRoom(socket);
      const ip = socket.data.ip;
      if (ip) {
        const left = (ipCounts.get(ip) || 1) - 1;
        if (left <= 0) ipCounts.delete(ip);
        else ipCounts.set(ip, left);
      }
    });

    // --- вход в комнату: раздача ключей в обе стороны ----------------------
    socket.on('room:join', (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (!allow(socket.data.joinTimes, JOIN_MAX, Date.now())) {
          return ack({ ok: false, error: 'Too many attempts. Wait a moment.' });
        }
        const roomId = String(payload?.roomId || '').toUpperCase().trim();
        const name = normalizeName(payload?.name);
        const publicKey = payload?.publicKey;
        const secretTag = normalizeSecretTag(payload?.secretTag);

        if (!ROOM_ID_RE.test(roomId)) return ack({ ok: false, error: 'Invalid room code' });
        if (!name) return ack({ ok: false, error: 'Name is required' });
        if (!isValidPublicKey(publicKey)) return ack({ ok: false, error: 'Invalid public keys' });

        let room = rooms.get(roomId);
        if (!room) {
          if (roomId.length < MIN_NEW_ROOM_LEN) {
            return ack({ ok: false, error: 'A new room code must be at least 8 characters' });
          }
          if (rooms.size >= MAX_ROOMS) {
            return ack({ ok: false, error: 'Server is overloaded, try again later' });
          }
          room = new Map();
          rooms.set(roomId, room);
        }
        const isSwitching = socket.data.roomId && socket.data.roomId !== roomId;
        if (!room.has(socket.id) && room.size >= MAX_MEMBERS && !isSwitching) {
          return ack({ ok: false, error: `The chat is already at its maximum of ${MAX_MEMBERS} participants` });
        }

        if (isSwitching) leaveRoom(socket); // сокет переходит в другую комнату

        room.set(socket.id, { name, publicKey, secretTag });
        socket.data.roomId = roomId;
        socket.join(roomId);

        // Новичку — открытые ключи всех, кто уже в чате…
        const members = [...room.entries()]
          .filter(([id]) => id !== socket.id)
          .map(([id, m]) => ({ id, name: m.name, publicKey: m.publicKey, secretTag: m.secretTag }));

        // …а всем старожилам — открытые ключи и тег фразы новичка.
        socket.to(roomId).emit('member:joined', { id: socket.id, name, publicKey, secretTag });

        ack({ ok: true, self: { id: socket.id }, members, count: room.size });
      } catch {
        try { ack({ ok: false, error: 'Internal server error' }); } catch { /* noop */ }
      }
    });

    // --- прокси подписанных шифрованных сообщений ---------------------------
    socket.on('msg:send', (payload) => {
      const room = rooms.get(socket.data.roomId);
      if (!room) return;
      const sender = room.get(socket.id);
      if (!sender) return;

      if (!allow(socket.data.msgTimes, MSG_MAX, Date.now())) return;

      const payloads = Array.isArray(payload?.payloads) ? payload.payloads.slice(0, MAX_PAYLOADS) : [];
      for (const p of payloads) {
        if (!p || typeof p !== 'object') continue;
        if (!room.has(p.to) || p.to === socket.id) continue;
        if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq > 2 ** 31) continue;
        if (!Number.isInteger(p.ts) || Math.abs(Date.now() - p.ts) > 10 * 60_000) continue;
        if (typeof p.sig !== 'string' || p.sig.length === 0 || p.sig.length > MAX_SIG_B64) continue;
        if (typeof p.iv !== 'string' || p.iv.length > 64) continue;
        if (typeof p.data !== 'string' || p.data.length > MAX_CIPHER_B64) continue;
        io.to(p.to).emit('msg:new', {
          from: socket.id,
          fromName: sender.name,
          seq: p.seq,
          ts: p.ts,
          sig: p.sig,
          iv: p.iv,
          data: p.data,
        });
      }
    });

    // --- передача файлов: манифест + чанки (всё шифротекст, relay без хранения)
    // Имя/размер/mime лежат ТОЛЬКО внутри шифроманного манифеста; по сети в
    // открытом виде ходят непрозрачные fileId/index и шифротекст.
    socket.on('file:offer', (payload) => {
      const room = rooms.get(socket.data.roomId);
      if (!room) return;
      const sender = room.get(socket.id);
      if (!sender) return;
      if (!allow(socket.data.fileOfferTimes, FILE_OFFER_MAX, Date.now())) return;

      const payloads = Array.isArray(payload?.payloads) ? payload.payloads.slice(0, MAX_PAYLOADS) : [];
      for (const p of payloads) {
        if (!p || typeof p !== 'object') continue;
        if (!room.has(p.to) || p.to === socket.id) continue;
        if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq > 2 ** 31) continue;
        if (!Number.isInteger(p.ts) || Math.abs(Date.now() - p.ts) > 10 * 60_000) continue;
        if (typeof p.sig !== 'string' || p.sig.length === 0 || p.sig.length > MAX_SIG_B64) continue;
        if (typeof p.iv !== 'string' || p.iv.length > 64) continue;
        if (typeof p.data !== 'string' || p.data.length > MAX_CIPHER_B64) continue;
        io.to(p.to).emit('file:offer', {
          from: socket.id,
          fromName: sender.name,
          seq: p.seq,
          ts: p.ts,
          sig: p.sig,
          iv: p.iv,
          data: p.data,
        });
      }
    });

    // Один чанк = один emit ( payloads ≤ ~1 МБ, лимит Engine.IO ); ack подтверждает
    // релей сервером — отправитель использует его для flow-control (окно чанков).
    socket.on('file:chunk', (payload, ack) => {
      const room = rooms.get(socket.data.roomId);
      if (!room) return;
      const sender = room.get(socket.id);
      if (!sender) return;
      if (typeof ack !== 'function') return;
      const fail = (reason) => { try { ack({ ok: false, reason }); } catch { /* noop */ } };

      if (!allow(socket.data.fileChunkTimes, FILE_CHUNK_MAX, Date.now())) return fail('rate');

      const to = typeof payload?.to === 'string' ? payload.to : '';
      const fileId = typeof payload?.fileId === 'string' ? payload.fileId : '';
      const index = payload?.index;
      const iv = payload?.iv;
      const data = payload?.data;
      if (!room.has(to) || to === socket.id) return fail('recipient');
      if (!new RegExp(`^[A-Za-z0-9_-]{1,${MAX_FILE_ID_LEN}}$`).test(fileId)) return fail('file-id');
      if (!Number.isInteger(index) || index < 0 || index > MAX_FILE_INDEX) return fail('index');
      if (typeof iv !== 'string' || iv.length === 0 || iv.length > 64) return fail('iv');
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_FILE_CHUNK_B64) return fail('size');

      io.to(to).emit('file:chunk', { from: socket.id, fromName: sender.name, fileId, index, iv, data });
      try { ack({ ok: true }); } catch { /* noop */ }
    });

    // --- индикатор набора текста (метаданные, без содержимого) -------------
    socket.on('typing', (payload) => {
      const room = rooms.get(socket.data.roomId);
      const sender = room && room.get(socket.id);
      if (!sender) return;
      if (!allow(socket.data.typingTimes, TYPING_MAX, Date.now())) return;
      socket.to(socket.data.roomId).emit('typing', {
        id: socket.id,
        name: sender.name,
        typing: !!payload?.typing,
      });
    });

    socket.on('room:leave', () => leaveRoom(socket));
  });

  expressApp.get('/healthz', (req, res) => {
    // Агрегированные метрики — только с loopback; наружу отдаём лишь живость.
    if (isLoopback(req.socket.remoteAddress || '')) {
      res.json({
        ok: true,
        rooms: rooms.size,
        members: [...rooms.values()].reduce((acc, r) => acc + r.size, 0),
        sockets: io.of('/').sockets.size,
        uptime: Math.floor(process.uptime()),
      });
    } else {
      res.json({ ok: true });
    }
  });
  expressApp.all('*', (req, res) => handle(req, res));

  httpServer.listen(port, host, () => {
    console.log(`> Encrypted chat ready on http://${host}:${port} (${dev ? 'dev' : 'production'})`);
    console.log('> All room state is RAM-only: no database, no history.');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      httpServer.close(() => process.exit(0));
      io.close();
    });
  }
});
