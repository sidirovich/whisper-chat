'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatApi } from '@/lib/useChat';
import { plural } from '@/lib/useChat';
import Avatar from './Avatar';
import Composer from './Composer';
import ConfirmModal from './ConfirmModal';
import MembersPanel from './MembersPanel';
import MessageList from './MessageList';
import { CopyIcon, LockIcon, MenuIcon, UsersIcon } from './icons';

interface ChatRoomProps {
  chat: ChatApi;
  onLeave: () => void;
}

export default function ChatRoom({ chat, onLeave }: ChatRoomProps) {
  const { room, members, items, typing, status } = chat;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);

  const inviteUrl = useMemo(
    () => (room ? `${window.location.origin}${window.location.pathname}#${room.roomId}` : ''),
    [room],
  );

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* буфер недоступен — можно продублировать код вручную */
    }
  }, [inviteUrl]);

  const shareInvite = useCallback(async () => {
    if (room && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `Чат ${room.roomId} в «Шёпоте»`, url: inviteUrl });
        return;
      } catch {
        /* пользователь отменил — ничего не делаем */
      }
    }
    void copyInvite();
  }, [copyInvite, inviteUrl, room]);

  // Escape закрывает мобильный drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (!room) return null;

  const total = members.length + 1;
  const online = status === 'online';
  const typingLabel = (() => {
    if (typing.length === 0) return null;
    if (typing.length === 1) return `${typing[0].name} печатает…`;
    if (typing.length === 2) return `${typing[0].name} и ${typing[1].name} печатают…`;
    return `${typing[0].name} и ещё ${typing.length - 1} печатают…`;
  })();

  return (
    <div className="chat">
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

      <aside className={`side${drawerOpen ? ' is-open' : ''}`}>
        <MembersPanel
          roomId={room.roomId}
          selfName={room.name}
          selfFingerprint={chat.selfFingerprint}
          members={members}
          onCopyInvite={() => void copyInvite()}
          onShareInvite={() => void shareInvite()}
          onLeave={() => {
            setDrawerOpen(false);
            setConfirmLeave(true);
          }}
          onClose={() => setDrawerOpen(false)}
        />
      </aside>

      <div className="chat__main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn topbar__burger"
            onClick={() => setDrawerOpen(true)}
            aria-label="Участники и настройки чата"
          >
            <MenuIcon />
          </button>

          <div className="topbar__center">
            <button
              type="button"
              className="topbar__members"
              onClick={() => setDrawerOpen(true)}
              aria-label={`Открыть список участников: ${total}`}
            >
              {members.length > 0 && <Avatar name={members[0].name} id={members[0].id} size={26} />}
              <span className="topbar__title">{room.roomId}</span>
              <span className="topbar__count">
                <UsersIcon width={14} height={14} />
                {total} {plural(total, ['участник', 'участника', 'участников'])}
              </span>
            </button>
          </div>

          <div className="topbar__right">
            <span className="pill pill--lock" title="Сквозное шифрование AES-256-GCM">
              <LockIcon width={14} height={14} /> E2E
            </span>
            <span className={`pill pill--status${online ? ' is-online' : ' is-waiting'}`}>
              <i className="pill__dot" aria-hidden />
              {online ? 'на связи' : 'переподключение…'}
            </span>
            {copied && (
              <span className="pill pill--copied" role="status">
                ссылка скопирована
              </span>
            )}
          </div>
        </header>

        {status === 'reconnecting' && (
          <div className="chat__notice" role="status">
            Связь с сервером потеряна — переподключаемся, чат восстановится автоматически.
          </div>
        )}

        <MessageList items={items} inviteUrl={inviteUrl} onCopyInvite={() => void copyInvite()} />

        {members.length === 0 && items.length > 0 && (
          <div className="chat__alone" role="status">
            <span>Вы пока одни — отправьте ссылку собеседнику:</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copyInvite()}>
              <CopyIcon /> {inviteUrl.replace(/^https?:\/\//, '')}
            </button>
          </div>
        )}

        <div className="chat__typing" aria-live="polite">
          {typingLabel ?? '\u00A0'}
        </div>

        <Composer onSend={chat.sendText} onTyping={chat.notifyTyping} />
      </div>

      <ConfirmModal
        open={confirmLeave}
        title="Покинуть чат?"
        body="Локальная переписка исчезнет, а на сервере её никогда и не было. Вернуться можно по ссылке-приглашению."
        confirmLabel="Покинуть"
        danger
        onConfirm={() => {
          setConfirmLeave(false);
          onLeave();
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </div>
  );
}
