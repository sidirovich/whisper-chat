import type { PublicKeys } from './crypto';

/** Общие типы протокола чата v2 (используются только на клиенте). */

/** Участник комнаты, каким его видит клиент. */
export interface MemberState {
  id: string;
  name: string;
  keys: PublicKeys;
  /** Короткий отпечаток обоих ключей (для визуальной сверки). */
  fingerprint: string;
  /** Публичный тег секретной фразы комнаты ('' — фразы нет). Для сверки совпадения. */
  secretTag: string;
}

/** Ответ сервера на room:join. */
export interface JoinAck {
  ok: boolean;
  error?: string;
  self?: { id: string };
  members?: { id: string; name: string; publicKey: PublicKeys; secretTag?: string }[];
  count?: number;
}

/** Зашифрованная «порция» сообщения для конкретного получателя. */
export interface EncryptedPayload {
  to: string;
  seq: number;
  ts: number;
  sig: string;
  iv: string;
  data: string;
}

/** Событие msg:new от сервера. */
export interface IncomingMsgEvent {
  from: string;
  fromName: string;
  seq: number;
  ts: number;
  sig: string;
  iv: string;
  data: string;
}

/** Событие typing от сервера. */
export interface TypingEvent {
  id: string;
  name: string;
  typing: boolean;
}

/** Зашифрованный чанк файла для конкретного получателя (без подписи — аутентичность даёт GCM+AAD). */
export interface FileChunkPayload {
  to: string;
  fileId: string;
  index: number;
  iv: string;
  data: string;
}

/** Событие file:offer от сервера (шифроманный манифест + ECDSA-подпись). */
export interface IncomingFileOfferEvent {
  from: string;
  fromName: string;
  seq: number;
  ts: number;
  sig: string;
  iv: string;
  data: string;
}

/** Событие file:chunk от сервера. */
export interface IncomingFileChunkEvent {
  from: string;
  fromName: string;
  fileId: string;
  index: number;
  iv: string;
  data: string;
}

/** Расшифрованный манифест файла (payload события file:offer). */
export interface FileManifest {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  /** SHA-256 исходного содержимого в hex. */
  sha256: string;
  chunkSize: number;
  totalChunks: number;
}

export type FileTransferState = 'sending' | 'receiving' | 'ready' | 'failed';

/** Элемент ленты чата. */
export type ChatItem =
  | {
      id: string;
      kind: 'text';
      mine: boolean;
      senderId: string;
      senderName: string;
      text: string;
      ts: number;
      failed?: boolean;
      /** Подпись отправителя не прошла проверку. */
      unverified?: boolean;
    }
  | {
      id: string;
      kind: 'file';
      mine: boolean;
      senderId: string;
      senderName: string;
      ts: number;
      fileId: string;
      name: string;
      size: number;
      mime: string;
      state: FileTransferState;
      /** 0..1 — доля ack-нутых (sending) или полученных (receiving) чанков. */
      progress: number;
      /** Object URL собранного Blob (state 'ready', только у получателя). */
      url?: string;
      failed?: boolean;
      failedReason?: 'cancelled' | 'integrity' | 'interrupted';
      /** Подпись манифеста не прошла проверку. */
      unverified?: boolean;
    }
  | {
      id: string;
      kind: 'system';
      text: string;
      ts: number;
      tone?: 'join' | 'left' | 'warn';
    };
