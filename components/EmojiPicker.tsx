'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOJI_CATEGORIES, getRecent, pushRecent, searchEmojis } from '@/lib/emoji';
import { CloseIcon, SearchIcon } from './icons';

interface EmojiPickerProps {
  /** Ссылка на контейнер-«якорь» (композер): клик вне него закрывает пикер. */
  anchorRef: React.RefObject<HTMLElement>;
  onPick: (emoji: string) => void;
  onClose: () => void;
}

/**
 * Встроенный эмодзи-пикер: 8 категорий, поиск по ключевым словам, «недавние».
 * Открытым остаётся пока пользователь не закроет — удобно вставлять несколько подряд.
 */
export default function EmojiPicker({ anchorRef, onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<string>(() => (getRecent().length ? 'recent' : EMOJI_CATEGORIES[0].id));
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return; // клик по кнопке-переключателю обработает композер
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  const found = useMemo(() => searchEmojis(query), [query]);
  const active = EMOJI_CATEGORIES.find((c) => c.id === tab);
  const grid = query ? found : tab === 'recent' ? getRecent() : active?.emojis ?? [];
  const recents = getRecent();

  const pick = (emoji: string) => {
    pushRecent(emoji);
    onPick(emoji);
  };

  return (
    <div className="ep" ref={panelRef} role="dialog" aria-label="Emoji picker">
      <div className="ep__head">
        <SearchIcon className="ep__search-icon" />
        <input
          ref={searchRef}
          className="ep__search"
          type="text"
          placeholder="Search: cat, fire, ok…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search emoji"
        />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close emoji picker">
          <CloseIcon />
        </button>
      </div>

      <div className="ep__body">
        {grid.length === 0 ? (
          <p className="ep__empty">{query ? 'Nothing found 🤷' : 'Nothing here yet — pick an emoji and it will show up here'}</p>
        ) : (
          <>
            {!query && tab === 'recent' && <p className="ep__caption">Recent</p>}
            {!query && tab !== 'recent' && active && <p className="ep__caption">{active.label}</p>}
            {query && <p className="ep__caption">Found: {found.length}</p>}
            <div className="ep__grid">
              {grid.map((emoji) => (
                <button key={emoji} type="button" className="ep__cell" onClick={() => pick(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="ep__tabs" role="tablist" aria-label="Emoji categories">
        {recents.length > 0 && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'recent'}
            className={`ep__tab${tab === 'recent' && !query ? ' is-active' : ''}`}
            onClick={() => {
              setTab('recent');
              setQuery('');
            }}
          >
            🕐
          </button>
        )}
        {EMOJI_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={tab === c.id}
            title={c.label}
            className={`ep__tab${tab === c.id && !query ? ' is-active' : ''}`}
            onClick={() => {
              setTab(c.id);
              setQuery('');
            }}
          >
            {c.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
