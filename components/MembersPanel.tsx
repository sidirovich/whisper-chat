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
        <button type="button" className="icon-btn side__close" onClick={onClose} aria-label="Close panel">
          <CloseIcon />
        </button>
      )}

      <div className="side__section side__invite">
        <span className="side__label">Room code</span>
        <div className="side__code">{roomId}</div>
        <div className="side__actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Link'}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onShareInvite}>
            <ShareIcon />
            Share
          </button>
        </div>
      </div>

      <div className="side__section side__members">
        <span className="side__label">
          In chat · {total} {plural(total, ['participant', 'participants'])}
        </span>
        <ul className="side__list">
          <li className="side__member side__member--self">
            <Avatar name={selfName} id="self" size={34} self />
            <div className="side__member-info">
              <span className="side__member-name">
                {selfName} <em>(you)</em>
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
                  <span className="side__member-tagwarn" title="The room passphrase doesn't match — messages won't decrypt">
                    passphrase mismatch
                  </span>
                )}
                <span className="side__member-fp" title="Public key fingerprint (SHA-256)">
                  {m.fingerprint}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="side__section side__info">
        <span className="side__label">
          <LockIcon width={15} height={15} /> How this is secured
        </span>
        <p>
          Messages are encrypted in the browser (ECDH P-256 + AES-256-GCM), separately for each
          participant. The server merely relays encrypted packets and public keys.
        </p>
        <p>
          You can compare key fingerprints with your contact out loud or over another channel —
          that way you make sure nobody swapped the keys.
        </p>
        <p>The conversation history is stored nowhere and disappears together with the chat.</p>
      </div>

      <button type="button" className="btn btn--danger-outline side__leave" onClick={onLeave}>
        <DoorIcon /> Leave chat
      </button>
    </>
  );
}
