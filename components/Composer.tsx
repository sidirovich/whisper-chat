'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import { SendIcon, SmileIcon } from './icons';

interface ComposerProps {
  onSend: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
  disabled?: boolean;
}

export const MAX_MESSAGE_LEN = 2000;

/** Поле ввода: эмодзи-пикер, авторастущая textarea, Enter для отправки (на десктопе). */
export default function Composer({ onSend, onTyping, disabled }: ComposerProps) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCoarsePointer(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  const resize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, []);

  const stopTypingSoon = useCallback(() => {
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => onTyping(false), 2500);
  }, [onTyping]);

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || value.length > MAX_MESSAGE_LEN || disabled) return;
    onSend(value);
    setText('');
    setPickerOpen(false);
    onTyping(false);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    requestAnimationFrame(() => {
      resize();
      taRef.current?.focus();
    });
  }, [disabled, onSend, onTyping, resize, text]);

  const handleChange = (value: string) => {
    setText(value);
    resize();
    onTyping(true);
    stopTypingSoon();
  };

  const insertEmoji = (emoji: string) => {
    const el = taRef.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
      resize();
    });
  };

  const overLimit = text.length > MAX_MESSAGE_LEN;

  return (
    <div className="composer" ref={boxRef}>
      {pickerOpen && (
        <EmojiPicker anchorRef={boxRef} onPick={insertEmoji} onClose={() => setPickerOpen(false)} />
      )}

      <button
        type="button"
        className={`composer__emoji${pickerOpen ? ' is-active' : ''}`}
        onClick={() => setPickerOpen((v) => !v)}
        aria-label="Добавить эмодзи"
        aria-expanded={pickerOpen}
        title="Эмодзи"
      >
        <SmileIcon width={24} height={24} />
      </button>

      <textarea
        ref={taRef}
        className="composer__input"
        rows={1}
        value={text}
        placeholder="Сообщение…"
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !coarsePointer && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <button
        type="button"
        className="composer__send"
        onClick={submit}
        disabled={disabled || !text.trim() || overLimit}
        aria-label="Отправить сообщение"
        title="Отправить (Enter)"
      >
        <SendIcon />
      </button>

      {text.length > MAX_MESSAGE_LEN * 0.85 && (
        <span className={`composer__counter${overLimit ? ' is-over' : ''}`}>
          {text.length}/{MAX_MESSAGE_LEN}
        </span>
      )}
    </div>
  );
}
