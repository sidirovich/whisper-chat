import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Единственное соединение на вкладку; подключаемся явно, когда есть ключи. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 600,
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
}
