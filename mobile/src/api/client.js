// API client — espelha frontend/src/services/apiClient.js (mesmo backend de produção)
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API_URL =
  Constants?.expoConfig?.extra?.apiUrl ||
  'https://frotasmak-frotas-backend.oehpg2.easypanel.host/api';

export const TOKEN_KEY = '@makfrotas/token';
export const USER_KEY = '@makfrotas/user';

export const getApiUrl = () => API_URL;
export const getBaseUrl = () => API_URL.replace(/\/api$/, '');

let authToken = null;
export const setAuthToken = (token) => { authToken = token; };

const apiFetch = async (endpoint, options = {}) => {
  const token = authToken || (await AsyncStorage.getItem(TOKEN_KEY));

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body instanceof FormData) delete headers['Content-Type'];

  let response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, { ...options, headers });
  } catch (networkErr) {
    const err = new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    err.isNetworkError = true;
    err.cause = networkErr;
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const err = new Error(
      errorData.message || errorData.error || `Erro ${response.status}`
    );
    // Preserva payload (campo, tipo, valor_*) para a UI destacar o input ofensor
    err.status = response.status;
    err.data = errorData;
    throw err;
  }

  if (response.status === 204) return null;
  return response.json();
};

const api = {
  // --- Auth ---
  login: (identifier, password) =>
    apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: identifier, password }),
    }),
  getMe: () => apiFetch('/auth/me'),
  register: (data) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  changePassword: (data) =>
    apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
  registerPushToken: (token, platform) =>
    apiFetch('/auth/push-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  removePushToken: (token) =>
    apiFetch('/auth/push-token', { method: 'DELETE', body: JSON.stringify({ token }) }),

  // --- Solicitações (operador) ---
  getMinhasSolicitacoes: () => apiFetch('/solicitacoes'),
  getMeuStatus: () => apiFetch('/solicitacoes/meus-status'),
  criarSolicitacao: (formData) =>
    apiFetch('/solicitacoes', { method: 'POST', body: formData }),
  enviarComprovante: (id, formData) =>
    apiFetch(`/solicitacoes/${id}/comprovante`, { method: 'PUT', body: formData }),

  // --- Solicitações (admin) ---
  avaliarSolicitacao: (id, data) =>
    apiFetch(`/solicitacoes/${id}/avaliar`, { method: 'PUT', body: JSON.stringify(data) }),
  confirmarBaixa: (id, data) =>
    apiFetch(`/solicitacoes/${id}/confirmar-baixa`, { method: 'PUT', body: JSON.stringify(data) }),
  rejeitarComprovante: (id, data) =>
    apiFetch(`/solicitacoes/${id}/rejeitar-comprovante`, { method: 'PUT', body: JSON.stringify(data) }),

  // --- Cadastros pendentes (admin) ---
  getRegistrationRequests: () => apiFetch('/admin/registration-requests'),
  approveRegistration: (data) =>
    apiFetch('/admin/registration-requests/approve', { method: 'POST', body: JSON.stringify(data) }),
  rejectRegistration: (id) =>
    apiFetch(`/admin/registration-requests/${id}`, { method: 'DELETE' }),

  // --- Frota ---
  getVehicles: () => apiFetch('/vehicles'),
  getVehicle: (id) => apiFetch(`/vehicles/${id}`),

  // --- Supervisor (gestão de obras) ---
  getSupervisorDashboard: () => apiFetch('/supervisor/dashboard'),
  getObraDetalhe: (id) => apiFetch(`/supervisor/obra/${id}`),

  // --- Apoio (selects da nova solicitação) ---
  getObras: () => apiFetch('/obras'),
  getPartners: () => apiFetch('/partners'),
  getEmployees: () => apiFetch('/employees'),

  // --- Abastecimentos / ordens ---
  getRefuelings: () => apiFetch('/refuelings'),

  // --- Comboio (distribuição de combustível pelo operador) ---
  getComboioTransactions: () => apiFetch('/comboioTransactions'),
  criarComboioSaida: (formData) =>
    apiFetch('/comboioTransactions/saida', { method: 'POST', body: formData }),

  // --- Despesas / horas / central operacional ---
  getExpenses: () => apiFetch('/expenses'),
  getBillingLogs: () => apiFetch('/billing'),
  getOperationalRequests: () => apiFetch('/operationalRequests'),

  // --- Oficina (revisões, pneus, ordens C/S) ---
  getRevisions: () => apiFetch('/revisions'),
  getTires: () => apiFetch('/tires'),
  getOrders: () => apiFetch('/orders'),

  // --- Estoque / multas / GPS ---
  getInventoryItems: () => apiFetch('/inventory/items'),
  getFines: () => apiFetch('/fines'),
  getSigasulPositions: () => apiFetch('/sigasul/positions'),

  raw: apiFetch,
};

export default api;
