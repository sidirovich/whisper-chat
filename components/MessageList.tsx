'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '@/lib/types';
import Avatar from './Avatar';
import { ChevronDownIcon, CopyIcon, LockIcon, WarnIcon } from './icons';

interface MessageListProps {
  items: ChatItem[];
  inviteUrl: string;
  onCopyInvite: () => void;
}

const GROUP_GAP_MS = 5 * 60_000;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Лента: группировка сообщений одного автора, системные строки, автоскролл. */
export default function MessageList({ items, inviteUrl, onCopyInvite }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [unread, setUnread] = useState(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stickRef.current = atBottom;
    if (atBottom) setUnread(0);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = items[items.length - 1];
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setUnread(0);
    } else if (last && last.kind === 'text' && !last.mine) {
      setUnread((u) => u + 1);
    }
  }, [items]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnread(0);
  };

  return (
    <div className="messages" ref={scrollRef} onScroll={onScroll}>
      <div className="messages__inner">
        {items.length === 0 && (
          <div className="messages__empty">
            <span className="messages__empty-icon">
              <LockIcon width={30} height={30} />
            </span>
            <h2>Это новый защищённый чат</h2>
            <p>
              Отправьте ссылку собеседникам — когда кто-то присоединится, открытые ключи обменяются
              автоматически, и сообщения пойдут напрямую, минуя сервер в открытом виде.
            </p>
            <button type="button" className="btn btn--secondary" onClick={onCopyInvite}>
              <CopyIcon /> Скопировать ссылку-приглашение
            </button>
            <span className="messages__empty-url">{inviteUrl}</span>
          </div>
        )}

        {items.map((item, i) => {
          if (item.kind === 'system') {
            return (
              <div className="sysline" key={item.id}>
                <span className={`sysline__pill sysline__pill--${item.tone ?? 'info'}`}>{item.text}</span>
              </div>
            );
          }
          const prev = items[i - 1];
          const firstOfGroup =
            !prev ||
            prev.kind !== 'text' ||
            prev.senderId !== item.senderId ||
            item.ts - prev.ts > GROUP_GAP_MS;
          return (
            <div className={`msg msg--${item.mine ? 'mine' : 'other'}`} key={item.id}>
              {!item.mine && firstOfGroup ? (
                <Avatar name={item.senderName} id={item.senderId} size={32} />
              ) : (
                <span className="msg__avatar-pad" aria-hidden />
              )}
              <div className="msg__stack">
                {firstOfGroup && (
                  <div className={`msg__meta msg__meta--${item.mine ? 'mine' : 'other'}`}>
                    <span className="msg__author">{item.mine ? 'Вы' : item.senderName}</span>
                    <time>{formatTime(item.ts)}</time>
                  </div>
                )}
                {item.failed ? (
                  <div className="msg__bubble msg__bubble--failed" title="Не удалось расшифровать сообщение">
                    <WarnIcon /> Не удалось расшифровать сообщение
                  </div>
                ) : (
                  <div className={`msg__bubble${item.unverified ? ' msg__bubble--unverified' : ''}`}>
                    {item.text}
                    {item.unverified && (
                      <span className="msg__unverified" title="Подпись отправителя не прошла проверку">
                        подпись не проверена
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!stickRef.current && (
        <button type="button" className="messages__down" onClick={scrollToBottom} aria-label="Вниз к последним сообщениям">
          <ChevronDownIcon />
          {unread > 0 && <span className="messages__down-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    </div>
  );
}
