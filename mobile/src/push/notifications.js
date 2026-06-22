// Push notifications (expo-notifications).
// Registra o Expo push token do dispositivo e o envia ao backend, associado
// ao usuário logado (POST /auth/push-token). O backend dispara pushes pelo
// canal "push" do notificationDispatcher (mesmos eventos do web).
//
// ⚠️ Push remoto foi REMOVIDO do Expo Go no SDK 53+. Só de *importar*
// expo-notifications no Expo Go o pacote já registra um push-token listener e
// derruba o app. Por isso NÃO usamos import estático: carregamos o módulo via
// require() apenas fora do Expo Go. No Expo Go tudo de push vira no-op; em dev
// build / standalone funciona normalmente.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import api from '../api/client';

export const isExpoGo =
  Constants.appOwnership === 'expo' ||
  Constants.executionEnvironment === 'storeClient';

// Carrega expo-notifications/-device só fora do Expo Go.
let Notifications = null;
let Device = null;
if (!isExpoGo) {
  Notifications = require('expo-notifications');
  Device = require('expo-device');
  // Em foreground, mostra banner + som (sem isso, no Android nada aparece).
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

const getProjectId = () =>
  Constants?.expoConfig?.extra?.eas?.projectId ||
  Constants?.easConfig?.projectId ||
  null;

// Pede permissão e retorna o Expo push token (string) ou null se indisponível.
export const getExpoPushToken = async () => {
  if (isExpoGo || !Notifications) return null; // push remoto indisponível no Expo Go (SDK 53+)
  if (!Device?.isDevice) return null;          // emulador/web não recebem push real

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Padrão',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#9E7A42',
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  const projectId = getProjectId();
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    return data;
  } catch (err) {
    // Sem projectId/EAS configurado o token não é emitido — não quebra o app.
    console.warn('[push] getExpoPushTokenAsync falhou:', err?.message);
    return null;
  }
};

// Registra o token no backend para o usuário logado. Idempotente.
export const registerPushToken = async () => {
  try {
    const token = await getExpoPushToken();
    if (!token) return null;
    await api.registerPushToken(token, Platform.OS);
    return token;
  } catch (err) {
    console.warn('[push] registro de token falhou:', err?.message);
    return null;
  }
};

// Remove o token do backend (no logout) para parar de receber pushes.
export const unregisterPushToken = async () => {
  try {
    const token = await getExpoPushToken();
    if (token) await api.removePushToken(token);
  } catch (err) {
    console.warn('[push] remoção de token falhou:', err?.message);
  }
};

export { Notifications };
