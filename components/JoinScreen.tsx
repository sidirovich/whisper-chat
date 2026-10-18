'use client';

import { useEffect, useRef, useState } from 'react';
import { makePassphrase } from '@/lib/useChat';
import { BoltIcon, GhostIcon, KeyIcon, LockIcon, WarnIcon } from './icons';

interface JoinScreenProps {
  initialCode: string;
  keysReady: boolean;
  insecure: boolean;
  busy: boolean;
  error: string | null;
  onJoin: (name: string, code: string | null, secret: string | null) => Promise<boolean>;
}

const NAME_KEY = 'encrypt-chat:name';
const MAX_NAME = 24;
const MIN_CODE = 6;
const MAX_CODE = 10;

export default function JoinScreen({ initialCode, keysReady, insecure, busy, error, onJoin }: JoinScreenProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Только имя — метаданные о чатах не сохраняем вовсе.
    const saved = sessionStorage.getItem(NAME_KEY);
    if (saved) {
      setName(saved);
      codeRef.current?.focus();
    } else {
      nameRef.current?.focus();
    }
  }, []);

  // Пришли по ссылке-приглашению — сразу подставляем код в поле.
  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  // Вставка полной ссылки-приглашения тоже должна работать: вытаскиваем код из текста.
  const handleCodeChange = (raw: string) => {
    const up = raw.toUpperCase();
    if (up.length > MAX_CODE) {
      const m = up.match(/[A-HJ-NP-Z2-9]{6,10}/);
      setCode(m ? m[0] : up.replace(/[^A-Z2-9]/g, '').slice(0, MAX_CODE));
      return;
    }
    setCode(up);
  };

  const codeNorm = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_CODE);
  const nameOk = name.trim().length >= 1;
  const canJoin = nameOk && codeNorm.length >= MIN_CODE && keysReady && !busy;
  const canCreate = nameOk && keysReady && !busy;

  const submitJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canJoin) return;
    sessionStorage.setItem(NAME_KEY, name.trim());
    void onJoin(name.trim(), codeNorm, secret.trim() || null);
  };

  const submitCreate = () => {
    if (!canCreate) return;
    sessionStorage.setItem(NAME_KEY, name.trim());
    void onJoin(name.trim(), null, secret.trim() || null);
  };

  return (
    <main className="join">
      <div className="join__glow join__glow--1" aria-hidden />
      <div className="join__glow join__glow--2" aria-hidden />

      <div className="join__card">
        <div className="join__logo" aria-hidden>
          <svg viewBox="0 0 64 64" width="46" height="46">
            <rect width="64" height="64" rx="15" fill="url(#lg)" />
            <defs>
              <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#6d7cff" />
                <stop offset="1" stopColor="#a55cf6" />
              </linearGradient>
            </defs>
            <rect x="15" y="28" width="34" height="24" rx="7" fill="#fff" />
            <path d="M23 28v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
            <circle cx="32" cy="39" r="4" fill="#6d7cff" />
          </svg>
        </div>
        <h1 className="join__title">Whisper</h1>
        <p className="join__subtitle">
          End-to-end encrypted chat with message signatures. Keys are created in your browser —
          the server only sees encrypted messages and never stores history.
        </p>

        {insecure && (
          <div className="banner banner--warn" role="alert">
            <WarnIcon /> The browser does not expose Web Crypto. Open the page over HTTPS or from
            localhost.
          </div>
        )}

        <form className="join__form" onSubmit={submitJoin}>
          <label className="field">
            <span className="field__label">Your name</span>
            <input
              ref={nameRef}
              className="field__input"
              type="text"
              value={name}
              maxLength={MAX_NAME}
              placeholder="e.g. Anna"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Room code</span>
            <input
              ref={codeRef}
              className="field__input field__input--code"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              value={codeNorm}
              maxLength={200}
              placeholder="Code or invite link"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => handleCodeChange(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Passphrase (optional)</span>
            <input
              className="field__input"
              type="password"
              value={secret}
              maxLength={128}
              placeholder="Empty — chat without a passphrase"
              autoComplete="new-password"
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
            />
            <span className="field__hint">
              It participates in encryption key derivation and is never sent to the server. Every
              participant must enter the same passphrase.{' '}
              <button
                type="button"
                className="join__gen"
                onClick={() => setSecret(makePassphrase())}
                disabled={busy}
              >
                Generate
              </button>
            </span>
          </label>

          {initialCode && codeNorm !== initialCode && (
            <p className="join__hint">You were invited — enter code {initialCode} or your own.</p>
          )}

          {error && (
            <div className="banner banner--error" role="alert">
              <WarnIcon /> {error}
            </div>
          )}

          <button className="btn btn--primary btn--block" type="submit" disabled={!canJoin}>
            {busy ? 'Joining…' : 'Join chat'}
          </button>
          <button className="join__alt" type="button" onClick={submitCreate} disabled={!canCreate}>
            or <span>create a new secure chat</span>
          </button>
          {!keysReady && !insecure && <p className="join__hint">Generating encryption keys…</p>}
        </form>

        <ul className="join__features">
          <li>
            <LockIcon /> End-to-end encryption: ECDH + AES-256-GCM
          </li>
          <li>
            <KeyIcon /> ECDSA signatures: message authorship can't be forged
          </li>
          <li>
            <BoltIcon /> Keys are handed to newcomers and members automatically
          </li>
          <li>
            <GhostIcon /> No history is stored: chats live only in memory
          </li>
        </ul>
      </div>

      <p className="join__footer">Nothing is logged • Nothing is stored • RAM only</p>
    </main>
  );
}
