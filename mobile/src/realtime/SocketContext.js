// Socket.io — mesmos eventos do web (server:sync, admin:notificacao).
// Mantém contagem de pendências para badges das abas.
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import api, { getBaseUrl } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Notifications, isExpoGo } from '../push/notifications';

const SocketContext = createContext({ pendentes: 0, cadastros: 0, syncTick: 0 });

const ADMIN_ROLES = ['admin', 'gerencia', 'abastecimento', 'editor'];

export const SocketProvider = ({ children }) => {
  const { user, role } = useAuth();
  const [pendentes, setPendentes] = useState(0);
  const [cadastros, setCadastros] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const socketRef = useRef(null);

  const isAdminLike = ADMIN_ROLES.includes(role);

  const refreshCounts = useCallback(async () => {
    if (!user || !isAdminLike) return;
    try {
      const [sols, regs] = await Promise.all([
        api.getMinhasSolicitacoes().catch(() => []),
        role === 'admin' ? api.getRegistrationRequests().catch(() => []) : Promise.resolve([]),
      ]);
      setPendentes((Array.isArray(sols) ? sols : []).filter((s) => s.status === 'PENDENTE').length);
      setCadastros(Array.isArray(regs) ? regs.length : 0);
    } catch { /* mantém contagens */ }
  }, [user, role, isAdminLike]);

  useEffect(() => {
    if (!user) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setPendentes(0);
      setCadastros(0);
      return;
    }

    refreshCounts();

    const socket = io(getBaseUrl(), { transports: ['websocket'] });
    socketRef.current = socket;

    const onSync = (payload) => {
      setSyncTick((t) => t + 1);
      const targets = payload?.targets || [];
      if (targets.includes('solicitacoes') || targets.includes('admin_requests')) {
        refreshCounts();
      }
    };
    const onNotificacao = () => refreshCounts();

    socket.on('server:sync', onSync);
    socket.on('admin:notificacao', onNotificacao);

    // Push recebido/tocado → atualiza contagens (badges) como o socket faz.
    // Listeners de push só fora do Expo Go (no Expo Go o módulo de push é no-op).
    const pushReceived = isExpoGo ? null : Notifications.addNotificationReceivedListener(() => refreshCounts());
    const pushResponse = isExpoGo ? null : Notifications.addNotificationResponseReceivedListener(() => refreshCounts());

    return () => {
      socket.off('server:sync', onSync);
      socket.off('admin:notificacao', onNotificacao);
      socket.disconnect();
      socketRef.current = null;
      pushReceived?.remove();
      pushResponse?.remove();
    };
  }, [user, refreshCounts]);

  return (
    <SocketContext.Provider value={{ pendentes, cadastros, syncTick, refreshCounts }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useRealtime = () => useContext(SocketContext);
