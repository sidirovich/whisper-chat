'use client';

import { useEffect, useState } from 'react';
import ChatRoom from '@/components/ChatRoom';
import JoinScreen from '@/components/JoinScreen';
import { makeRoomCode, parseRoomCodeFromUrl, useChat } from '@/lib/useChat';

export default function Page() {
  const chat = useChat();
  const [inviteCode, setInviteCode] = useState<string | null>(null);

  // Читаем invite-ссылку (#ABCDEF) один раз после монтирования, чтобы не
  // разъехаться с SSR-разметкой.
  useEffect(() => {
    setInviteCode(parseRoomCodeFromUrl());
  }, []);

  const handleJoin = async (name: string, code: string | null, secret: string | null) => {
    const roomId = code ?? makeRoomCode();
    const ok = await chat.join(roomId, name, secret);
    if (ok) {
      // Ссылка становится invite-ссылкой: её можно скопировать собеседнику.
      window.history.replaceState(null, '', `#${roomId}`);
    }
    return ok;
  };

  const handleLeave = () => {
    chat.leave();
    window.history.replaceState(null, '', window.location.pathname);
  };

  return chat.room ? (
    <ChatRoom chat={chat} onLeave={handleLeave} />
  ) : (
    <JoinScreen
      initialCode={inviteCode ?? ''}
      keysReady={chat.keysReady}
      insecure={chat.insecure}
      busy={chat.status === 'joining'}
      error={chat.error}
      onJoin={handleJoin}
    />
  );
}
