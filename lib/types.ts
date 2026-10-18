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
      kind: 'system';
      text: string;
      ts: number;
      tone?: 'join' | 'left' | 'warn';
    };
