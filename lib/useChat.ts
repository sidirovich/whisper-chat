'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from './socket';
import {
  canonicalMessage,
  decryptText,
  deriveAesKey,
  encryptText,
  generateIdentity,
  jwkFingerprint,
  roomSecretTag,
  signCanonical,
  verifyCanonical,
  type Identity,
  type PublicKeys,
} from './crypto';
import type { ChatItem, IncomingMsgEvent, JoinAck, MemberState, TypingEvent } from './types';

export type ConnStatus = 'idle' | 'joining' | 'online' | 'reconnecting';

export interface RoomInfo {
  roomId: string;
  name: string;
  selfId: string;
}

export interface ChatApi {
  /** Ключи ECDH+ECDSA сгенерированы, можно входить в чат. */
  keysReady: boolean;
  /** Браузер без Web Crypto (нужен HTTPS или localhost). */
  insecure: boolean;
  status: ConnStatus;
  error: string | null;
  room: RoomInfo | null;
  members: MemberState[];
  items: ChatItem[];
  typing: { id: string; name: string }[];
  selfFingerprint: string | null;
  /** Секретная фраза комнаты задана (участвует в KDF, серверу не передаётся). */
  hasRoomSecret: boolean;
  /** Публичный тег секретной фразы (для сверки с другими участниками). */
  ownSecretTag: string;
  join(roomId: string, name: string, secret?: string | null): Promise<boolean>;
  leave(): void;
  sendText(text: string): void;
  notifyTyping(isTyping: boolean): void;
  dismissError(): void;
}

const MAX_ITEMS = 1000;
const TYPING_TTL = 4000;
const GHOST_TTL = 30_000; // сколько помним ключи вышедшего (для сообщений «на лету»)

let itemSeq = 0;
const nextId = () => `${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

interface MemberWire {
  id: string;
  name: string;
  publicKey: PublicKeys;
  secretTag?: string;
}

export function useChat(): ChatApi {
  const [keysReady, setKeysReady] = useState(false);
  const [insecure, setInsecure] = useState(false);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [members, setMembers] = useState<MemberState[]>([]);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [typing, setTyping] = useState<{ id: string; name: string; until: number }[]>([]);
  const [selfFingerprint, setSelfFingerprint] = useState<string | null>(null);
  const [hasRoomSecret, setHasRoomSecret] = useState(false);

  const roomRef = useRef<RoomInfo | null>(null);
  const membersRef = useRef<MemberState[]>([]);
  const identityRef = useRef<Identity | null>(null);
  /** Ключи участников по id (+ короткий «призрак» вышедших). */
  const keyStoreRef = useRef(new Map<string, { keys: PublicKeys; until?: number }>());
  const derivedKeysRef = useRef(new Map<string, Promise<CryptoKey>>());
  /** Секретная фраза комнаты — только локально, в KDF. */
  const roomSecretRef = useRef<string | null>(null);
  /** Публичный тег фразы ('' — фразы нет; null — ещё не вычислен/сброшен). */
  const ownSecretTagRef = useRef<string | null>(null);
  /** Исходящий счётчик сообщений и анти-replay окно по отправителям. */
  const outSeqRef = useRef(0);
  const lastSeqRef = useRef(new Map<string, number>());
  /** имя -> отпечаток: детекция подмены ключей под видом того же человека. */
  const nameFpRef = useRef(new Map<string, string>());
  const lastTypingSentRef = useRef(0);

  const applyRoom = useCallback((next: RoomInfo | null) => {
    roomRef.current = next;
    setRoom(next);
  }, []);

  const applyMembers = useCallback((fn: (prev: MemberState[]) => MemberState[]) => {
    membersRef.current = fn(membersRef.current);
    setMembers(membersRef.current);
  }, []);

  const pushItem = useCallback((item: ChatItem) => {
    setItems((prev) => {
      const base = prev.length >= MAX_ITEMS ? prev.slice(prev.length - MAX_ITEMS + 1) : prev;
      return [...base, item];
    });
  }, []);

  // --- генерация ключей один раз на вкладку --------------------------------
  useEffect(() => {
    let cancelled = false;
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setInsecure(true);
      return;
    }
    generateIdentity()
      .then(async (id) => {
        if (cancelled) return;
        identityRef.current = id;
        setKeysReady(true);
        setSelfFingerprint(await jwkFingerprint({ ecdh: id.ecdhPublicJwk, ecdsa: id.ecdsaPublicJwk }));
      })
      .catch(() => !cancelled && setInsecure(true));
    return () => {
      cancelled = true;
    };
  }, []);

  /** AES-ключ для переписки с участником (с кэшем, секретом комнаты и «призраками»). */
  const keyFor = useCallback((id: string): Promise<CryptoKey> => {
    const cached = derivedKeysRef.current.get(id);
    if (cached) return cached;
    const info = keyStoreRef.current.get(id);
    if (!info) return Promise.reject(new Error('no-public-key'));
    const p = (async () => {
      const key = await deriveAesKey(identityRef.current!.ecdhPrivate, info.keys.ecdh, roomSecretRef.current);
      if (roomSecretRef.current === null) return key;
      // С секретной фразой проверяем расшифровываемость сразу: неверная фраза
      // проявится на первом же сообщении, а не молча.
      const probe = await encryptText(key, 'probe', 'probe');
      await decryptText(key, probe.iv, probe.data, 'probe');
      return key;
    })();
    derivedKeysRef.current.set(id, p);
    p.catch(() => derivedKeysRef.current.delete(id));
    return p;
  }, []);

  const addMembers = useCallback(
    (list: MemberWire[]) => {
      // СИНХРОННО сохраняем ключи — сообщение может прийти раньше, чем
      // посчитается отпечаток (async ниже); иначе гонка «no-public-key».
      for (const m of list) {
        keyStoreRef.current.set(m.id, { keys: m.publicKey });
        const tag = m.secretTag ?? '';
        const ownTag = ownSecretTagRef.current;
        // Рассинхрон секретной фразы: сообщения будут нечитаемы — предупреждаем сразу.
        if (ownTag !== null && tag !== ownTag) {
          pushItem({
            id: nextId(),
            kind: 'system',
            ts: Date.now(),
            text: `⚠ У «${m.name}» ${tag ? 'другая' : 'нет'} секретной фразы комнаты${ownTag ? '' : ' (у вас она задана)'} — сообщения между вами не расшифруются. Выйдите из чата и войдите с одинаковой фразой.`,
            tone: 'warn',
          });
        }
      }
      (async () => {
        for (const m of list) {
          const fingerprint = await jwkFingerprint(m.publicKey);
          // Детекция подмены: тот же человек не может получить другой отпечаток.
          const knownFp = nameFpRef.current.get(m.name);
          if (knownFp && knownFp !== fingerprint) {
            pushItem({
              id: nextId(),
              kind: 'system',
              ts: Date.now(),
              text: `⚠ Ключ участника «${m.name}» изменился — возможно, это другой человек. Сверьте отпечаток ${fingerprint} по другому каналу.`,
              tone: 'warn',
            });
          }
          nameFpRef.current.set(m.name, fingerprint);
          applyMembers((prev) => [
            ...prev.filter((x) => x.id !== m.id),
            { id: m.id, name: m.name, keys: m.publicKey, fingerprint, secretTag: m.secretTag ?? '' },
          ]);
          keyFor(m.id).catch(() => {}); // прогреваем ключ
        }
      })();
    },
    [applyMembers, keyFor, pushItem],
  );

  const removeMember = useCallback(
    (id: string) => {
      const info = keyStoreRef.current.get(id);
      if (info) keyStoreRef.current.set(id, { keys: info.keys, until: Date.now() + GHOST_TTL });
      derivedKeysRef.current.delete(id);
      applyMembers((prev) => prev.filter((m) => m.id !== id));
      setTyping((prev) => prev.filter((t) => t.id !== id));
    },
    [applyMembers],
  );

  // --- чистка «призраков» и протухших индикаторов набора -------------------
  useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      for (const [id, info] of keyStoreRef.current) {
        if (info.until && info.until < now) keyStoreRef.current.delete(id);
      }
      setTyping((prev) => {
        const next = prev.filter((t) => t.until > now);
        return next.length === prev.length ? prev : next;
      });
    };
    const iv = window.setInterval(sweep, 1500);
    return () => window.clearInterval(iv);
  }, []);

  const resetRoomState = useCallback(() => {
    keyStoreRef.current.clear();
    derivedKeysRef.current.clear();
    nameFpRef.current.clear();
    lastSeqRef.current.clear();
    outSeqRef.current = 0;
    roomSecretRef.current = null;
    ownSecretTagRef.current = null;
    setHasRoomSecret(false);
    applyMembers(() => []);
    setItems([]);
    setTyping([]);
    applyRoom(null);
  }, [applyMembers, applyRoom]);

  // --- подписки на события сокета (один раз) -------------------------------
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      const r = roomRef.current;
      if (!r || !identityRef.current) return;
      // Переподключение: перезаходим в комнату теми же ключами и тегом фразы
      socket.emit(
        'room:join',
        {
          roomId: r.roomId,
          name: r.name,
          publicKey: { ecdh: identityRef.current.ecdhPublicJwk, ecdsa: identityRef.current.ecdsaPublicJwk },
          secretTag: ownSecretTagRef.current ?? '',
        },
        (ack: JoinAck) => {
          if (!ack.ok) {
            setError(ack.error ?? 'Не удалось восстановить подключение к чату');
            return;
          }
          applyRoom({ ...r, selfId: ack.self!.id });
          const alive = new Set((ack.members ?? []).map((m) => m.id));
          applyMembers((prev) => prev.filter((m) => alive.has(m.id)));
          addMembers(ack.members ?? []);
          setStatus('online');
        },
      );
    };

    const onDisconnect = () => {
      if (roomRef.current) setStatus('reconnecting');
    };

    const onMemberJoined = (m: MemberWire) => {
      addMembers([m]);
      pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: `${m.name} присоединился к чату`, tone: 'join' });
    };

    const onMemberLeft = ({ id, name }: { id: string; name: string }) => {
      removeMember(id);
      pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: `${name} покинул чат`, tone: 'left' });
    };

    const onMessage = async (ev: IncomingMsgEvent) => {
      const r = roomRef.current;
      if (!r) return;

      // Анти-replay: seq отправителя монотонный; повтор или откат отбрасываем.
      const lastSeq = lastSeqRef.current.get(ev.from) ?? -1;
      if (ev.seq <= lastSeq) {
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: `Отброшено повторное или устаревшее сообщение от «${ev.fromName}»`,
          tone: 'warn',
        });
        return;
      }

      try {
        const key = await keyFor(ev.from);
        const aad = `${r.roomId}|${ev.from}|${ev.seq}`;
        const text = await decryptText(key, ev.iv, ev.data, aad);
        lastSeqRef.current.set(ev.from, ev.seq);

        const info = keyStoreRef.current.get(ev.from);
        const canonical = canonicalMessage(r.roomId, ev.from, ev.seq, ev.ts, text);
        const verified = info ? await verifyCanonical(info.keys.ecdsa, canonical, ev.sig) : false;

        pushItem({
          id: nextId(),
          kind: 'text',
          mine: false,
          senderId: ev.from,
          senderName: ev.fromName,
          text,
          ts: ev.ts,
          unverified: !verified,
        });
      } catch {
        lastSeqRef.current.set(ev.from, ev.seq);
        pushItem({
          id: nextId(),
          kind: 'text',
          mine: false,
          senderId: ev.from,
          senderName: ev.fromName,
          text: '',
          ts: ev.ts,
          failed: true,
        });
        // Точная причина по тегу фразы, если отправитель уже известен.
        const senderTag = membersRef.current.find((m) => m.id === ev.from)?.secretTag;
        const ownTag = ownSecretTagRef.current;
        if (ownTag !== null && senderTag !== undefined && senderTag !== ownTag) {
          pushItem({
            id: nextId(),
            kind: 'system',
            ts: Date.now(),
            text: `Сообщение от «${ev.fromName}» не расшифровано: у вас${ownTag ? ' другая' : ' не задана'} секретная фраза комнаты. Выйдите из чата и войдите с фразой, которую задал создатель.`,
            tone: 'warn',
          });
        } else if (roomSecretRef.current) {
          pushItem({
            id: nextId(),
            kind: 'system',
            ts: Date.now(),
            text: 'Не удалось расшифровать. Если это повторяется — проверьте секретную фразу комнаты.',
            tone: 'warn',
          });
        }
      }
    };

    const onTyping = (ev: TypingEvent) => {
      setTyping((prev) => {
        if (ev.typing) {
          return [...prev.filter((t) => t.id !== ev.id), { id: ev.id, name: ev.name, until: Date.now() + TYPING_TTL }];
        }
        return prev.filter((t) => t.id !== ev.id);
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('member:joined', onMemberJoined);
    socket.on('member:left', onMemberLeft);
    socket.on('msg:new', onMessage);
    socket.on('typing', onTyping);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('member:joined', onMemberJoined);
      socket.off('member:left', onMemberLeft);
      socket.off('msg:new', onMessage);
      socket.off('typing', onTyping);
    };
  }, [addMembers, applyMembers, keyFor, pushItem, removeMember]);

  const join = useCallback(
    async (roomId: string, name: string, secret: string | null = null) => {
      setError(null);
      if (!identityRef.current) {
        setError('Ключи ещё не готовы, попробуйте ещё раз');
        return false;
      }
      const socket = getSocket();
      resetRoomState();
      roomSecretRef.current = secret && secret.length > 0 ? secret : null;
      setHasRoomSecret(roomSecretRef.current !== null);
      setStatus('joining');

      // Публичный тег фразы для сверки с другими участниками (не раскрывает фразу).
      ownSecretTagRef.current = await roomSecretTag(roomId, roomSecretRef.current);

      socket.connect();
      const ack = await new Promise<JoinAck>((resolve) => {
        const timer = window.setTimeout(
          () => resolve({ ok: false, error: 'Сервер не отвечает. Убедитесь, что сервер запущен.' }),
          10_000,
        );
        socket.emit(
          'room:join',
          {
            roomId,
            name,
            publicKey: {
              ecdh: identityRef.current!.ecdhPublicJwk,
              ecdsa: identityRef.current!.ecdsaPublicJwk,
            },
            secretTag: ownSecretTagRef.current,
          },
          (res: JoinAck) => {
            window.clearTimeout(timer);
            resolve(res);
          },
        );
      });

      if (!ack.ok || !ack.self) {
        setStatus('idle');
        setError(ack.error ?? 'Не удалось войти в чат');
        return false;
      }

      applyRoom({ roomId, name, selfId: ack.self.id });
      keyStoreRef.current.set(ack.self.id, {
        keys: { ecdh: identityRef.current.ecdhPublicJwk, ecdsa: identityRef.current.ecdsaPublicJwk },
      });
      nameFpRef.current.set(name, (await jwkFingerprint({
        ecdh: identityRef.current.ecdhPublicJwk,
        ecdsa: identityRef.current.ecdsaPublicJwk,
      })));
      setStatus('online');
      pushItem({
        id: nextId(),
        kind: 'system',
        ts: Date.now(),
        text: `Вы в чате ${roomId} · сквозное шифрование и подписи активны${roomSecretRef.current ? ' · секретная фраза применена' : ''}`,
      });
      if (ack.members && ack.members.length > 0) {
        addMembers(ack.members);
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: `Открытые ключи получены: ${ack.members.length} ${plural(ack.members.length, [
            'участник',
            'участника',
            'участников',
          ])}`,
        });
      }
      return true;
    },
    [addMembers, applyRoom, pushItem, resetRoomState],
  );

  const leave = useCallback(() => {
    const socket = getSocket();
    socket.emit('room:leave');
    socket.disconnect();
    resetRoomState();
    setStatus('idle');
    setError(null);
  }, [resetRoomState]);

  const sendText = useCallback(
    (text: string) => {
      const clean = text.trim();
      const r = roomRef.current;
      const idt = identityRef.current;
      if (!r || !clean || !idt) return;

      const seq = outSeqRef.current++;
      const ts = Date.now();
      pushItem({ id: nextId(), kind: 'text', mine: true, senderId: r.selfId, senderName: r.name, text: clean, ts });

      const targets = membersRef.current.map((m) => m.id);
      if (targets.length === 0) return; // писать некому — сообщение остаётся только у себя

      const aad = `${r.roomId}|${r.selfId}|${seq}`;
      const canonical = canonicalMessage(r.roomId, r.selfId, seq, ts, clean);

      void (async () => {
        try {
          const sig = await signCanonical(idt.ecdsaPrivate, canonical);
          const payloads = await Promise.all(
            targets.map(async (id) => {
              const key = await keyFor(id);
              const { iv, data } = await encryptText(key, clean, aad);
              return { to: id, seq, ts, sig, iv, data };
            }),
          );
          getSocket().emit('msg:send', { payloads });
        } catch {
          pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: 'Не удалось зашифровать сообщение', tone: 'warn' });
        }
      })();
    },
    [keyFor, pushItem],
  );

  const notifyTyping = useCallback((isTyping: boolean) => {
    const socket = getSocket();
    if (!roomRef.current || !socket.connected) return;
    const now = Date.now();
    if (isTyping) {
      if (now - lastTypingSentRef.current < 1500) return;
      lastTypingSentRef.current = now;
    }
    socket.emit('typing', { typing: isTyping });
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    keysReady,
    insecure,
    status,
    error,
    room,
    members,
    items,
    typing: typing.map(({ id, name }) => ({ id, name })),
    selfFingerprint,
    hasRoomSecret,
    ownSecretTag: ownSecretTagRef.current ?? '',
    join,
    leave,
    sendText,
    notifyTyping,
    dismissError,
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Код комнаты: 8 символов из алфавита без похожих глифов (0/O, 1/I). */
export function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Словарь для генерации секретных фраз (запоминаемые, без спецсимволов). */
const PASS_WORDS = [
  'альфа','банка','весна','гром','дельта','жемчуг','заря','игла','кабан','лошадь',
  'мёд','нить','облако','парус','река','соль','тень','узел','флаг','холст',
  'царь','чашка','шар','щит','экран','юг','якорь','атом','берег','винт',
  'гнездо','дуб','ежевика','жираф','зубр','ирис','камень','лев','магнит','нора',
  'остров','пик','руль','сталь','тропа','удар','фонарь','хвост','циркуль','чердак',
  'шахта','щека','эхо','яблоня','азарт','бархат','вихрь','грань','дюна','ёлка',
];

/** Запоминаемая секретная фраза из 6 слов (~36 бит энтропии + энтропия кода комнаты). */
export function makePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => PASS_WORDS[b % PASS_WORDS.length]).join('-');
}

/** Вытаскиваем код комнаты из invite-ссылки (#ABCDEF12). */
export function parseRoomCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = `${window.location.hash} ${window.location.search}`.toUpperCase();
  const m = raw.match(/[A-HJ-NP-Z2-9]{6,10}/);
  return m ? m[0] : null;
}

/** Русская плюрализация: plural(3, ['участник','участника','участников']). */
export function plural(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}
