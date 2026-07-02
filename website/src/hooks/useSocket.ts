import { useEffect, useState } from 'react';
import { getSocket, disconnectSocket } from '../services/socket';
import type { StewraSocket } from '../services/socket';
import { useAuth } from './useAuth';

/**
 * Returns the shared Socket.IO connection, (re)establishing it whenever there is an authenticated user
 * and tearing it down on logout. Components use the returned socket to attach event listeners; the
 * connection itself is a module singleton so every consumer shares one socket.
 */
export function useSocket(): StewraSocket | null {
  const { user } = useAuth();
  const [socket, setSocket] = useState<StewraSocket | null>(null);

  useEffect(() => {
    if (!user) {
      disconnectSocket();
      setSocket(null);
      return;
    }
    setSocket(getSocket());
    // We intentionally do NOT disconnect on unmount: the socket is app-wide and shared across pages.
    // It is only torn down when the user becomes null (logout), handled by the branch above.
  }, [user]);

  return socket;
}
