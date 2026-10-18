'use client';

import { useState } from 'react';
import type { MemberState } from '@/lib/types';
import { plural } from '@/lib/useChat';
import Avatar from './Avatar';
import { CheckIcon, CloseIcon, CopyIcon, DoorIcon, LockIcon, ShareIcon } from './icons';

interface MembersPanelProps {
  roomId: string;
  selfName: string;
  selfFingerprint: string | null;
  members: MemberState[];
  /** Тег секретной фразы текущего пользователя ('' — фразы нет). */
  ownSecretTag: string;
  onCopyInvite: () => void;
  onShareInvite: () => void;
  onLeave: () => void;
  onClose?: () => void; // только в мобильном drawer
}

/** Сайдбар: код чата + приглашение, участники с отпечатками ключей, детали безопасности. */
export default function MembersPanel({
  roomId,
  selfName,
  selfFingerprint,
  members,
  ownSecretTag,
  onCopyInvite,
  onShareInvite,
  onLeave,
  onClose,
}: MembersPanelProps) {
  const [copied, setCopied] = useState(false);
  const total = members.length + 1;

  const copy = () => {
    onCopyInvite();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      {onClose && (
        <button type="button" className="icon-btn side__close" onClick={onClose} aria-label="Закрыть панель">
          <CloseIcon />
        </button>
      )}

      <div className="side__section side__invite">
        <span className="side__label">Код чата</span>
        <div className="side__code">{roomId}</div>
        <div className="side__actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Скопировано' : 'Ссылка'}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onShareInvite}>
            <ShareIcon />
            Поделиться
          </button>
        </div>
      </div>

      <div className="side__section side__members">
        <span className="side__label">
          В чате · {total} {plural(total, ['участник', 'участника', 'участников'])}
        </span>
        <ul className="side__list">
          <li className="side__member side__member--self">
            <Avatar name={selfName} id="self" size={34} self />
            <div className="side__member-info">
              <span className="side__member-name">
                {selfName} <em>это вы</em>
              </span>
              <span className="side__member-fp">{selfFingerprint ?? '…'}</span>
            </div>
          </li>
          {members.map((m) => (
            <li className="side__member" key={m.id}>
              <Avatar name={m.name} id={m.id} size={34} />
              <div className="side__member-info">
                <span className="side__member-name">{m.name}</span>
                {m.secretTag !== ownSecretTag && (
                  <span className="side__member-tagwarn" title="Секретная фраза комнаты не совпадает — сообщения не расшифруются">
                    фраза не совпадает
                  </span>
                )}
                <span className="side__member-fp" title="Отпечаток открытого ключа (SHA-256)">
                  {m.fingerprint}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="side__section side__info">
        <span className="side__label">
          <LockIcon width={15} height={15} /> Как это защищено
        </span>
        <p>
          Сообщения шифруются в браузере (ECDH P-256 + AES-256-GCM) отдельно для каждого участника.
          Сервер лишь передаёт шифрованные пакеты и открытые ключи.
        </p>
        <p>
          Отпечатки ключей можно сверить с собеседником голосом или по другому каналу — так вы
          убедитесь, что ключи никто не подменил.
        </p>
        <p>История переписки нигде не сохраняется и исчезает вместе с чатом.</p>
      </div>

      <button type="button" className="btn btn--danger-outline side__leave" onClick={onLeave}>
        <DoorIcon /> Покинуть чат
      </button>
    </>
  );
}
