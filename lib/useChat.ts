'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from './socket';
import {
  canonicalFileOffer,
  canonicalMessage,
  decryptBytes,
  decryptText,
  deriveAesKey,
  encryptBytes,
  encryptText,
  generateIdentity,
  jwkFingerprint,
  roomSecretTag,
  sha256Hex,
  signCanonical,
  verifyCanonical,
  type Identity,
  type PublicKeys,
} from './crypto';
import type {
  ChatItem,
  FileChunkPayload,
  FileManifest,
  IncomingFileChunkEvent,
  IncomingFileOfferEvent,
  IncomingMsgEvent,
  JoinAck,
  MemberState,
  TypingEvent,
} from './types';

type FileChatItem = Extract<ChatItem, { kind: 'file' }>;

const textEncoder = new TextEncoder();

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
  sendFile(file: File): void;
  cancelFile(fileId: string): void;
  notifyTyping(isTyping: boolean): void;
  dismissError(): void;
}

const MAX_ITEMS = 1000;
const TYPING_TTL = 4000;
const GHOST_TTL = 30_000; // сколько помним ключи вышедшего (для сообщений «на лету»)

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // всё состояние живёт в RAM — нужен предел
export const FILE_CHUNK_SIZE = 512 * 1024; // шифротекст чанка в b64 ≈ 683 КБ < 768 КБ серверного потолка
const FILE_CHUNK_WINDOW = 4; // не-ack-нутых чанков в полёте (flow-control)
const FILE_ACK_TIMEOUT = 15_000; // ждём ack сервера столько, дальше считаем сбой
const FILE_RETRY_BACKOFF = 1500; // пауза при отказе 'rate' (серверное окно 10 с)
const FILE_MAX_ATTEMPTS = 30;
const FILE_STALL_MS = 20_000; // без чанков столько — передача сорвалась
export const MAX_PREVIEW_SIZE = 10 * 1024 * 1024; // inline-превью только для небольших картинок

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Локальное состояние одной передачи файла (только RAM, очищается по завершении). */
interface FileTransfer {
  dir: 'send' | 'recv';
  itemId: string;
  roomId: string;
  meta: FileManifest;
  /** Отправка: id получателей; приём: id отправителя. */
  peers: string[];
  /** id сокета-отправителя (AAD чанков и оффера). */
  fromId: string;
  ts: number;
  /** Отправка: содержимое файла целиком (освобождается после передачи). */
  buf: Uint8Array<ArrayBuffer> | null;
  /** Приём: расшифрованные чанки по индексам. */
  chunks: Map<number, Uint8Array>;
  received: number;
  acked: number;
  inFlight: number;
  nextChunk: number;
  lastActivity: number;
  cancelled: boolean;
}

/** Строгая валидация расшифрованного манифеста — до его использования в арифметике чанков. */
function isValidManifest(m: unknown): m is FileManifest {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.fileId === 'string' && FILE_ID_RE.test(x.fileId) &&
    typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 256 &&
    typeof x.size === 'number' && Number.isInteger(x.size) && x.size > 0 &&
    typeof x.mime === 'string' && x.mime.length <= 128 &&
    typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) &&
    typeof x.chunkSize === 'number' && Number.isInteger(x.chunkSize) && x.chunkSize > 0 && x.chunkSize <= 1024 * 1024 &&
    typeof x.totalChunks === 'number' && Number.isInteger(x.totalChunks) && x.totalChunks > 0 && x.totalChunks <= 4096 &&
    Math.ceil((x.size as number) / (x.chunkSize as number)) === x.totalChunks
  );
}

/** Непрозрачный id файла: 24 hex-символа. */
function makeFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Человекочитаемый размер файла. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

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
  /** Активные передачи файлов (оба направления), ключ — fileId. */
  const fileTxRef = useRef(new Map<string, FileTransfer>());
  /** Object URL готовых файлов — revoke при выходе из чата. */
  const ownedUrlsRef = useRef(new Set<string>());

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

  const patchFileItem = useCallback((id: string, patch: (f: FileChatItem) => FileChatItem) => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === 'file' ? patch(it) : it)));
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
            text: `⚠ “${m.name}” ${tag ? 'has a different' : 'has no'} room passphrase${ownTag ? '' : ' (yours is set)'} — messages between you won't decrypt. Leave the chat and rejoin with the same passphrase.`,
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
              text: `⚠ The key of “${m.name}” has changed — this may be a different person. Verify the fingerprint ${fingerprint} over another channel.`,
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

  // --- передача файлов ------------------------------------------------------
  /** Помечаем передачу сорванной и освобождаем её буферы. */
  const failFileTransfer = useCallback(
    (t: FileTransfer, reason: 'cancelled' | 'integrity' | 'interrupted') => {
      if (fileTxRef.current.get(t.meta.fileId) === t) fileTxRef.current.delete(t.meta.fileId);
      t.cancelled = true;
      t.chunks.clear();
      t.buf = null;
      patchFileItem(t.itemId, (f) => ({ ...f, state: 'failed', failed: true, failedReason: reason }));
    },
    [patchFileItem],
  );

  /**
   * Отправитель: окно из FILE_CHUNK_WINDOW не-ack-нутых чанков. Ack от сервера
   * подтверждает релей (не получение) — этого хватает для flow-control и прогресса.
   * Отказ 'rate' — ретрай с паузой; прочие — передача сорвана.
   */
  const pumpFileChunks = useCallback(
    (t: FileTransfer) => {
      const socket = getSocket();
      while (!t.cancelled && t.inFlight < FILE_CHUNK_WINDOW && t.nextChunk < t.meta.totalChunks) {
        const index = t.nextChunk++;
        t.inFlight++;
        void (async () => {
          try {
            const off = index * t.meta.chunkSize;
            const plain = t.buf!.subarray(off, Math.min(off + t.meta.chunkSize, t.meta.size));
            const chunkAad = `${t.roomId}|${t.fromId}|${t.meta.fileId}|${index}`;
            const payloads = await Promise.all(
              t.peers.map(async (to): Promise<FileChunkPayload> => {
                const key = await keyFor(to);
                const { iv, data } = await encryptBytes(key, plain, chunkAad);
                return { to, fileId: t.meta.fileId, index, iv, data };
              }),
            );
            if (t.cancelled) return;

            for (const p of payloads) {
              let delivered = false;
              for (let attempt = 0; attempt < FILE_MAX_ATTEMPTS && !t.cancelled; attempt++) {
                const res = await new Promise<{ ok?: boolean; reason?: string } | null>((resolve) => {
                  const timer = window.setTimeout(() => resolve(null), FILE_ACK_TIMEOUT);
                  socket.emit('file:chunk', p, (ack: { ok?: boolean; reason?: string } | null) => {
                    window.clearTimeout(timer);
                    resolve(ack ?? null);
                  });
                });
                if (res?.ok) {
                  delivered = true;
                  break;
                }
                if (res && res.reason && res.reason !== 'rate') break; // постоянный отказ сервера
                await new Promise((resolve) => window.setTimeout(resolve, FILE_RETRY_BACKOFF));
              }
              if (!delivered) {
                failFileTransfer(t, 'interrupted');
                return;
              }
            }
            if (t.cancelled) return;

            t.acked++;
            t.lastActivity = Date.now();
            patchFileItem(t.itemId, (f) => ({
              ...f,
              progress: Math.min(t.acked / t.meta.totalChunks, 1),
            }));
          } catch {
            failFileTransfer(t, 'interrupted');
            return;
          } finally {
            t.inFlight--;
          }

          if (t.acked >= t.meta.totalChunks) {
            patchFileItem(t.itemId, (f) => ({ ...f, state: 'ready', progress: 1 }));
            t.buf = null; // ~100 МБ больше не нужны
            fileTxRef.current.delete(t.meta.fileId);
          } else {
            pumpFileChunks(t);
          }
        })();
      }
    },
    [failFileTransfer, keyFor, patchFileItem],
  );

  const sendFile = useCallback(
    (file: File) => {
      const r = roomRef.current;
      const idt = identityRef.current;
      if (!r || !idt) return;
      const targets = membersRef.current.map((m) => m.id);
      if (targets.length === 0) {
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: 'There is nobody to send the file to yet — invite someone first.',
          tone: 'warn',
        });
        return;
      }
      if (file.size === 0 || file.size > MAX_FILE_SIZE) {
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: `File is too large — the limit is ${formatBytes(MAX_FILE_SIZE)}.`,
          tone: 'warn',
        });
        return;
      }

      const fileId = makeFileId();
      const itemId = nextId();
      const ts = Date.now();
      const mime = file.type || 'application/octet-stream';
      const meta: FileManifest = {
        fileId,
        name: file.name,
        size: file.size,
        mime,
        sha256: '',
        chunkSize: FILE_CHUNK_SIZE,
        totalChunks: Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE)),
      };
      const t: FileTransfer = {
        dir: 'send',
        itemId,
        roomId: r.roomId,
        meta,
        peers: targets,
        fromId: r.selfId,
        ts,
        buf: null,
        chunks: new Map(),
        received: 0,
        acked: 0,
        inFlight: 0,
        nextChunk: 0,
        lastActivity: Date.now(),
        cancelled: false,
      };
      fileTxRef.current.set(fileId, t);
      pushItem({
        id: itemId,
        kind: 'file',
        mine: true,
        senderId: r.selfId,
        senderName: r.name,
        ts,
        fileId,
        name: file.name,
        size: file.size,
        mime,
        state: 'sending',
        progress: 0,
      });

      void (async () => {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const sha256 = await sha256Hex(buf);
          if (t.cancelled || fileTxRef.current.get(fileId) !== t) return;
          t.buf = buf;
          t.meta.sha256 = sha256;

          const seq = outSeqRef.current++;
          const sig = await signCanonical(
            idt.ecdsaPrivate,
            canonicalFileOffer(
              r.roomId,
              r.selfId,
              seq,
              ts,
              fileId,
              meta.name,
              meta.size,
              mime,
              sha256,
              meta.totalChunks,
              meta.chunkSize,
            ),
          );
          const offerAad = `${r.roomId}|${r.selfId}|${seq}|offer`;
          const payloads = await Promise.all(
            targets.map(async (to) => {
              const key = await keyFor(to);
              const { iv, data } = await encryptBytes(key, textEncoder.encode(JSON.stringify(meta)), offerAad);
              return { to, seq, ts, sig, iv, data };
            }),
          );
          if (t.cancelled || fileTxRef.current.get(fileId) !== t) return;
          getSocket().emit('file:offer', { payloads });
          pumpFileChunks(t);
        } catch {
          failFileTransfer(t, 'interrupted');
        }
      })();
    },
    [failFileTransfer, keyFor, pumpFileChunks, pushItem],
  );

  const cancelFile = useCallback(
    (fileId: string) => {
      const t = fileTxRef.current.get(fileId);
      if (t) failFileTransfer(t, 'cancelled');
    },
    [failFileTransfer],
  );

  // --- чистка «призраков», протухших индикаторов набора и застрявших файлов --
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
      for (const t of fileTxRef.current.values()) {
        if (!t.cancelled && now - t.lastActivity > FILE_STALL_MS) failFileTransfer(t, 'interrupted');
      }
    };
    const iv = window.setInterval(sweep, 1500);
    return () => window.clearInterval(iv);
  }, [failFileTransfer]);

  const resetRoomState = useCallback(() => {
    keyStoreRef.current.clear();
    derivedKeysRef.current.clear();
    nameFpRef.current.clear();
    lastSeqRef.current.clear();
    outSeqRef.current = 0;
    roomSecretRef.current = null;
    ownSecretTagRef.current = null;
    for (const t of fileTxRef.current.values()) t.cancelled = true;
    fileTxRef.current.clear();
    for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
    ownedUrlsRef.current.clear();
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
            setError(ack.error ?? 'Failed to restore the chat connection');
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
      // Буферы Engine.IO ушли вместе с сокетом — активные передачи не восстановить.
      for (const t of [...fileTxRef.current.values()]) failFileTransfer(t, 'interrupted');
    };

    const onMemberJoined = (m: MemberWire) => {
      addMembers([m]);
      pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: `${m.name} joined the chat`, tone: 'join' });
    };

    const onMemberLeft = ({ id, name }: { id: string; name: string }) => {
      removeMember(id);
      pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: `${name} left the chat`, tone: 'left' });
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
          text: `Dropped a replayed or outdated message from “${ev.fromName}”`,
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
            text: `Message from “${ev.fromName}” was not decrypted: your room passphrase is ${ownTag ? 'different' : 'not set'}. Leave the chat and rejoin with the passphrase chosen by the creator.`,
            tone: 'warn',
          });
        } else if (roomSecretRef.current) {
          pushItem({
            id: nextId(),
            kind: 'system',
            ts: Date.now(),
            text: 'Failed to decrypt. If this keeps happening — check the room passphrase.',
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

    // --- приём файлов --------------------------------------------------------
    const finishRecv = async (t: FileTransfer) => {
      const out = new Uint8Array(t.meta.size);
      let off = 0;
      for (let i = 0; i < t.meta.totalChunks; i++) {
        const c = t.chunks.get(i);
        if (!c) return;
        out.set(c, off);
        off += c.length;
      }
      const ok = (await sha256Hex(out)) === t.meta.sha256;
      if (!ok) {
        failFileTransfer(t, 'integrity');
        return;
      }
      const url = URL.createObjectURL(new Blob([out], { type: t.meta.mime || 'application/octet-stream' }));
      ownedUrlsRef.current.add(url);
      t.chunks.clear();
      patchFileItem(t.itemId, (f) => ({ ...f, state: 'ready', progress: 1, url }));
      fileTxRef.current.delete(t.meta.fileId);
    };

    const onFileOffer = async (ev: IncomingFileOfferEvent) => {
      const r = roomRef.current;
      if (!r) return;
      const lastSeq = lastSeqRef.current.get(ev.from) ?? -1;
      if (ev.seq <= lastSeq) return; // анти-replay, общий счётчик с текстовыми сообщениями
      try {
        const key = await keyFor(ev.from);
        const offerAad = `${r.roomId}|${ev.from}|${ev.seq}|offer`;
        const json = await decryptText(key, ev.iv, ev.data, offerAad);
        const meta = JSON.parse(json) as FileManifest;
        if (!isValidManifest(meta) || meta.size > MAX_FILE_SIZE) throw new Error('bad-offer');
        lastSeqRef.current.set(ev.from, ev.seq);

        const info = keyStoreRef.current.get(ev.from);
        const canonical = canonicalFileOffer(
          r.roomId,
          ev.from,
          ev.seq,
          ev.ts,
          meta.fileId,
          meta.name,
          meta.size,
          meta.mime,
          meta.sha256,
          meta.totalChunks,
          meta.chunkSize,
        );
        const verified = info ? await verifyCanonical(info.keys.ecdsa, canonical, ev.sig) : false;

        const itemId = nextId();
        fileTxRef.current.set(meta.fileId, {
          dir: 'recv',
          itemId,
          roomId: r.roomId,
          meta,
          peers: [ev.from],
          fromId: ev.from,
          ts: ev.ts,
          buf: null,
          chunks: new Map(),
          received: 0,
          acked: 0,
          inFlight: 0,
          nextChunk: 0,
          lastActivity: Date.now(),
          cancelled: false,
        });
        pushItem({
          id: itemId,
          kind: 'file',
          mine: false,
          senderId: ev.from,
          senderName: ev.fromName,
          ts: ev.ts,
          fileId: meta.fileId,
          name: meta.name,
          size: meta.size,
          mime: meta.mime,
          state: 'receiving',
          progress: 0,
          unverified: !verified,
        });
      } catch {
        lastSeqRef.current.set(ev.from, ev.seq);
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: `An encrypted file from “${ev.fromName}” could not be accepted.`,
          tone: 'warn',
        });
      }
    };

    const onFileChunk = async (ev: IncomingFileChunkEvent) => {
      const r = roomRef.current;
      if (!r) return;
      const t = fileTxRef.current.get(ev.fileId);
      if (!t || t.dir !== 'recv' || t.cancelled) return;
      if (t.peers[0] !== ev.from) return;
      if (!Number.isInteger(ev.index) || ev.index < 0 || ev.index >= t.meta.totalChunks) return;
      if (t.chunks.has(ev.index)) return; // повтор чанка
      try {
        const key = await keyFor(ev.from);
        const chunkAad = `${r.roomId}|${ev.from}|${ev.fileId}|${ev.index}`;
        const plain = await decryptBytes(key, ev.iv, ev.data, chunkAad);
        t.chunks.set(ev.index, plain);
        t.received += plain.length;
        t.lastActivity = Date.now();
        patchFileItem(t.itemId, (f) => ({ ...f, progress: Math.min(t.received / t.meta.size, 1) }));
        if (t.chunks.size === t.meta.totalChunks) void finishRecv(t);
      } catch {
        // GCM-тег не сошёлся: ключ не тот — остальные чанки тоже не расшифруются.
        failFileTransfer(t, 'integrity');
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('member:joined', onMemberJoined);
    socket.on('member:left', onMemberLeft);
    socket.on('msg:new', onMessage);
    socket.on('file:offer', onFileOffer);
    socket.on('file:chunk', onFileChunk);
    socket.on('typing', onTyping);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('member:joined', onMemberJoined);
      socket.off('member:left', onMemberLeft);
      socket.off('msg:new', onMessage);
      socket.off('file:offer', onFileOffer);
      socket.off('file:chunk', onFileChunk);
      socket.off('typing', onTyping);
    };
  }, [addMembers, applyMembers, failFileTransfer, keyFor, patchFileItem, pushItem, removeMember]);

  const join = useCallback(
    async (roomId: string, name: string, secret: string | null = null) => {
      setError(null);
      if (!identityRef.current) {
        setError('Keys are not ready yet, try again');
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
          () => resolve({ ok: false, error: 'The server is not responding. Make sure the server is running.' }),
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
        setError(ack.error ?? 'Failed to join the chat');
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
        text: `You're in chat ${roomId} · end-to-end encryption and signatures are active${roomSecretRef.current ? ' · passphrase applied' : ''}`,
      });
      if (ack.members && ack.members.length > 0) {
        addMembers(ack.members);
        pushItem({
          id: nextId(),
          kind: 'system',
          ts: Date.now(),
          text: `Public keys received: ${ack.members.length} ${plural(ack.members.length, [
            'participant',
            'participants',
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
          pushItem({ id: nextId(), kind: 'system', ts: Date.now(), text: 'Failed to encrypt the message', tone: 'warn' });
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
    sendFile,
    cancelFile,
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

/** Dictionary for generating passphrases (memorable, no special characters). */
const PASS_WORDS = [
  'apple','anchor','aurora','beacon','bridge','canyon','cedar','cliff','cloud','comet',
  'coral','cosmos','crane','crystal','dawn','delta','dune','eagle','ember','falcon',
  'fern','flint','forest','fossil','gecko','gemini','giant','giraffe','granite','harbor',
  'hazel','heron','island','ivory','jaguar','jasmine','jungle','koala','lagoon','lantern',
  'lunar','maple','marble','meadow','meteor','mirage','nebula','nickel','north','oasis',
  'onyx','orbit','otter','panda','pearl','pebble','penguin','phoenix','pilot','pine',
  'quartz','quiver','raven','reef','ridge','river','rocket','saffron','sailor','summit',
  'tundra','twilight','valley','velvet','vertex','violet','walnut','whisper','willow','zenith',
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

/** English plural: plural(3, ['participant', 'participants']). */
export function plural(n: number, forms: [string, string]): string {
  return n === 1 ? forms[0] : forms[1];
}
