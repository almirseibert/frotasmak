// AuthContext — espelha frontend/src/contexts/AuthContext.js
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { setAuthToken, TOKEN_KEY, USER_KEY } from '../api/client';
import { registerPushToken, unregisterPushToken } from '../push/notifications';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Restaura sessão ao abrir o app
  useEffect(() => {
    (async () => {
      try {
        const [token, cached] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(USER_KEY),
        ]);
        if (!token) return;
        setAuthToken(token);
        if (cached) setUser(JSON.parse(cached));
        // Revalida no servidor (token pode ter expirado — 24h)
        const fresh = await api.getMe();
        setUser(fresh);
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(fresh));
      } catch {
        await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
        setAuthToken(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (identifier, password) => {
    const res = await api.login(identifier, password);
    setAuthToken(res.token);
    await AsyncStorage.setItem(TOKEN_KEY, res.token);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await unregisterPushToken(); // antes de limpar o token (precisa do header auth)
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    setAuthToken(null);
    setUser(null);
  }, []);

  // Registra o push token sempre que houver um usuário logado (login ou boot).
  useEffect(() => {
    if (user?.id) registerPushToken();
  }, [user?.id]);

  const role = (user?.user_type || user?.role || 'viewer').toLowerCase();

  return (
    <AuthContext.Provider value={{ user, role, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
