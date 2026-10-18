'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '@/lib/types';
import { formatBytes, MAX_PREVIEW_SIZE } from '@/lib/useChat';
import Avatar from './Avatar';
import { ChevronDownIcon, CopyIcon, DownloadIcon, FileIcon, LockIcon, WarnIcon } from './icons';

type FileChatItem = Extract<ChatItem, { kind: 'file' }>;

interface MessageListProps {
  items: ChatItem[];
  inviteUrl: string;
  onCopyInvite: () => void;
  onCancelFile?: (fileId: string) => void;
}

const GROUP_GAP_MS = 5 * 60_000;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/** Бабл файла: прогресс передачи, кнопка Download, inline-превью небольших картинок. */
function FileBubble({ item, onCancel }: { item: FileChatItem; onCancel?: (fileId: string) => void }) {
  const inFlight = item.state === 'sending' || item.state === 'receiving';
  const imageUrl = item.mime.startsWith('image/') && item.size <= MAX_PREVIEW_SIZE ? item.url : undefined;
  const status = (() => {
    if (item.failed) {
      if (item.failedReason === 'cancelled') return 'cancelled';
      if (item.failedReason === 'integrity') return 'integrity check failed';
      return item.mine ? 'not sent' : 'interrupted';
    }
    if (inFlight) return `${Math.round(item.progress * 100)}%`;
    if (item.mine) return 'sent';
    return '';
  })();

  // Картинки: превью во всю ширину бабла, метаданные — плашкой поверх нижнего края.
  if (imageUrl) {
    return (
      <div
        className={`msg__bubble msg__bubble--image${item.failed ? ' is-failed' : ''}${item.unverified ? ' msg__bubble--unverified' : ''}`}
      >
        <a
          className="msg__file-media"
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          title="Open full size"
          aria-label={`Open ${item.name} full size`}
        >
          <img className="msg__file-img" src={imageUrl} alt={item.name} draggable={false} />
          {inFlight && <span className="msg__file-veil" aria-hidden />}
        </a>
        <div className="msg__file-strip">
          <span className="msg__file-name" title={item.name}>
            {item.name}
          </span>
          <span className="msg__file-sub">
            {inFlight ? `${Math.round(item.progress * 100)}%` : formatBytes(item.size)}
            {!inFlight && status ? ` · ${status}` : ''}
            {!inFlight && item.unverified ? ' · signature unverified' : ''}
          </span>
          {inFlight && item.mine && onCancel && (
            <button type="button" className="msg__file-cancel" onClick={() => onCancel(item.fileId)}>
              Cancel
            </button>
          )}
          {!inFlight && item.state === 'ready' && !item.mine && (
            <a className="msg__file-download" href={imageUrl} download={item.name}>
              <DownloadIcon width={13} height={13} /> Download
            </a>
          )}
          {inFlight && (
            <div
              className="msg__file-bar"
              role="progressbar"
              aria-valuenow={Math.round(item.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${Math.max(item.progress * 100, 4)}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`msg__bubble msg__bubble--file${item.failed ? ' is-failed' : ''}${item.unverified ? ' msg__bubble--unverified' : ''}`}
    >
      <span className="msg__file-icon">
        <FileIcon width={22} height={22} />
      </span>
      <div className="msg__file-info">
        <span className="msg__file-name" title={item.name}>
          {item.name}
        </span>
        <span className="msg__file-sub">
          {formatBytes(item.size)}
          {status ? ` · ${status}` : ''}
          {item.unverified ? ' · signature unverified' : ''}
        </span>
        {inFlight && (
          <div
            className="msg__file-bar"
            role="progressbar"
            aria-valuenow={Math.round(item.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${Math.max(item.progress * 100, 4)}%` }} />
          </div>
        )}
        {inFlight && item.mine && onCancel && (
          <button type="button" className="msg__file-cancel" onClick={() => onCancel(item.fileId)}>
            Cancel
          </button>
        )}
        {item.state === 'ready' && item.url && !item.mine && (
          <a className="msg__file-download" href={item.url} download={item.name}>
            <DownloadIcon width={14} height={14} /> Download
          </a>
        )}
      </div>
    </div>
  );
}

/** Лента: группировка сообщений одного автора, системные строки, автоскролл. */
export default function MessageList({ items, inviteUrl, onCopyInvite, onCancelFile }: MessageListProps) {
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
            <h2>This is a new secure chat</h2>
            <p>
              Send the link to the people you want to talk to — as soon as someone joins, public
              keys are exchanged automatically, and messages flow directly without ever reaching
              the server in plaintext.
            </p>
            <button type="button" className="btn btn--secondary" onClick={onCopyInvite}>
              <CopyIcon /> Copy invite link
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
          const prevIsMsg = !!prev && (prev.kind === 'text' || prev.kind === 'file');
          const firstOfGroup =
            !prevIsMsg ||
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
                    <span className="msg__author">{item.mine ? 'You' : item.senderName}</span>
                    <time>{formatTime(item.ts)}</time>
                  </div>
                )}
                {item.kind === 'file' ? (
                  <FileBubble item={item} onCancel={onCancelFile} />
                ) : item.failed ? (
                  <div className="msg__bubble msg__bubble--failed" title="Failed to decrypt the message">
                    <WarnIcon /> Failed to decrypt the message
                  </div>
                ) : (
                  <div className={`msg__bubble${item.unverified ? ' msg__bubble--unverified' : ''}`}>
                    {item.text}
                    {item.unverified && (
                      <span className="msg__unverified" title="The sender's signature failed verification">
                        signature unverified
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
        <button type="button" className="messages__down" onClick={scrollToBottom} aria-label="Scroll down to the latest messages">
          <ChevronDownIcon />
          {unread > 0 && <span className="messages__down-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    </div>
  );
}
