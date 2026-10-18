'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import { CloseIcon, FileIcon, PaperclipIcon, SendIcon, SmileIcon } from './icons';
import { formatBytes, MAX_FILE_SIZE } from '@/lib/useChat';

interface ComposerProps {
  onSend: (text: string) => void;
  onSendFile: (file: File) => void;
  onTyping: (isTyping: boolean) => void;
  disabled?: boolean;
}

export const MAX_MESSAGE_LEN = 2000;

/** Поле ввода: эмодзи-пикер, вложение файлов, авторастущая textarea, Enter для отправки (на десктопе). */
export default function Composer({ onSend, onSendFile, onTyping, disabled }: ComposerProps) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
    if (disabled) return;
    const value = text.trim();
    const hasText = !!value && value.length <= MAX_MESSAGE_LEN;
    const fileOk = !!pendingFile && pendingFile.size > 0 && pendingFile.size <= MAX_FILE_SIZE;
    if (!hasText && !fileOk) return;
    if (fileOk) onSendFile(pendingFile);
    if (hasText) onSend(value);
    setText('');
    setPendingFile(null);
    if (fileRef.current) fileRef.current.value = '';
    setPickerOpen(false);
    onTyping(false);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    requestAnimationFrame(() => {
      resize();
      taRef.current?.focus();
    });
  }, [disabled, onSend, onSendFile, onTyping, pendingFile, resize, text]);

  const pickFile = (file: File | null | undefined) => {
    if (file) setPendingFile(file);
    if (fileRef.current) fileRef.current.value = '';
  };

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
  const fileTooBig = !!pendingFile && (pendingFile.size === 0 || pendingFile.size > MAX_FILE_SIZE);

  return (
    <div className="composer" ref={boxRef}>
      {pickerOpen && (
        <EmojiPicker anchorRef={boxRef} onPick={insertEmoji} onClose={() => setPickerOpen(false)} />
      )}

      {pendingFile && (
        <div className={`composer__file${fileTooBig ? ' is-too-big' : ''}`}>
          <FileIcon width={16} height={16} />
          <span className="composer__file-name">{pendingFile.name}</span>
          <span className="composer__file-size">{formatBytes(pendingFile.size)}</span>
          {fileTooBig && <span className="composer__file-warn">over the {formatBytes(MAX_FILE_SIZE)} limit</span>}
          <button
            type="button"
            className="composer__file-remove"
            onClick={() => setPendingFile(null)}
            aria-label="Remove attachment"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      )}

      <button
        type="button"
        className="composer__attach"
        onClick={() => fileRef.current?.click()}
        aria-label="Attach file"
        title="Attach file"
        disabled={disabled}
      >
        <PaperclipIcon width={21} height={21} />
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      <button
        type="button"
        className={`composer__emoji${pickerOpen ? ' is-active' : ''}`}
        onClick={() => setPickerOpen((v) => !v)}
        aria-label="Add emoji"
        aria-expanded={pickerOpen}
        title="Emoji"
      >
        <SmileIcon width={24} height={24} />
      </button>

      <textarea
        ref={taRef}
        className="composer__input"
        rows={1}
        value={text}
        placeholder="Message…"
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
        disabled={disabled || (!text.trim() && !pendingFile) || overLimit || fileTooBig}
        aria-label={pendingFile ? 'Send file' : 'Send message'}
        title="Send (Enter)"
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
