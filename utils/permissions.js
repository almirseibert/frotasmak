// utils/permissions.js
// ─────────────────────────────────────────────────────────────────────────────
// FONTE ÚNICA DE PERMISSÃO DE PÁGINAS (backend = autoridade).
//
// O front NÃO deve manter um mapa próprio que decida acesso: ele recebe
// `effectivePages` calculado aqui (via /auth/me) e apenas renderiza o que o
// servidor liberou. As rotas da API usam as MESMAS funções deste arquivo para
// barrar acesso. Assim, menu e API não podem divergir — era a causa dos bugs
// "aparece na tela mas a API dá 403".
//
// Ao criar/renomear uma página, altere APENAS este arquivo.
// ─────────────────────────────────────────────────────────────────────────────

// role -> páginas que o role enxerga por padrão. 'admin' usa curinga '*'.
const ROLE_PAGE_ACCESS = {
  admin:         ['*'],
  gerencia:      ['dashboard','obras','planejamento','expenses','operacional','billing','terceirizados','reports','refueling','saldo_postos','comboio','admin_solicitacoes','orders','revisions','relatos','tires','guia_pecas','vehicles','employees','partners','inventory','fines','sigasul','supervisor_dashboard','analise_gerencial','admin_evidencias'],
  rh:            ['dashboard','obras','billing','reports','vehicles','employees','fines'],
  faturamento:   ['dashboard','obras','operacional','billing','terceirizados','reports','vehicles','admin_evidencias'],
  abastecimento: ['dashboard','obras','expenses','reports','refueling','saldo_postos','comboio','admin_solicitacoes','orders','vehicles','partners','inventory'],
  oficina:       ['dashboard','obras','reports','revisions','relatos','tires','guia_pecas','orders','vehicles','inventory','employees'],
  editor:        ['dashboard','obras','expenses','operacional','billing','terceirizados','reports','refueling','saldo_postos','comboio','admin_solicitacoes','orders','revisions','relatos','tires','guia_pecas','vehicles','employees','partners','inventory','fines'],
  supervisor:    ['dashboard','obras','supervisor_dashboard','expenses','operacional','billing','reports','revisions','relatos','tires','guia_pecas','orders','vehicles','admin_evidencias'],
  operador:      ['admin_solicitacoes_app','evidencias_app'],
  viewer:        ['dashboard','reports'],
  visualizador:  ['dashboard','reports'],
};

const VEHICLE_ACTION_BUTTONS = {
  admin:         ['edit','checklist','fines','history','documents','delete','block'],
  gerencia:      ['edit','checklist','fines','history','documents','block'],
  rh:            ['checklist','fines','history'],
  faturamento:   ['checklist','history'],
  abastecimento: ['checklist','history'],
  oficina:       ['checklist','history'],
  editor:        ['edit','checklist','fines','history','documents'],
  supervisor:    ['checklist','history'],
  viewer:        [],
  visualizador:  [],
};

const ROLES_NO_DELETE = ['gerencia','rh','faturamento','abastecimento','oficina','viewer','visualizador'];
const ROLES_NO_PASSWORD_RELEASE = ['gerencia','rh','faturamento','abastecimento','oficina','viewer','visualizador','editor'];

// page_permissions vem do MySQL como array (JSON já parseado) ou string. Normaliza para array|null.
function normalizePagePermissions(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
  }
  return null;
}

function getRolePages(role) {
  return ROLE_PAGE_ACCESS[(role || '').toLowerCase()] || ROLE_PAGE_ACCESS['viewer'];
}

// Páginas EFETIVAS de um usuário:
// - override individual (page_permissions não-vazio) vence o padrão do role;
// - admin ('*') nunca é reduzido, para não travar o próprio acesso.
// Aceita tanto `pagePermissions` (req.user) quanto `page_permissions` (linha do banco).
function getEffectivePages(user) {
  const role = ((user && (user.role || user.user_type)) || 'viewer').toLowerCase();
  const rolePages = getRolePages(role);
  if (rolePages.includes('*')) return rolePages;
  const custom = normalizePagePermissions(user && (user.pagePermissions != null ? user.pagePermissions : user.page_permissions));
  if (Array.isArray(custom) && custom.length > 0) return custom;
  return rolePages;
}

function canUserAccessPage(user, pageId) {
  const pages = getEffectivePages(user);
  return pages.includes('*') || pages.includes(pageId);
}

// Compat: checagem só por role (sem override). Prefira canUserAccessPage(user, ...).
function canAccessPage(role, pageId) {
  const pages = getRolePages(role);
  return pages.includes('*') || pages.includes(pageId);
}

// Middleware factory para proteger rotas. Requer authMiddleware antes (popula req.user).
// Uso: router.get('/x', requirePage('billing'), handler)
function requirePage(pageId) {
  return (req, res, next) => {
    if (req.user && canUserAccessPage(req.user, pageId)) return next();
    return res.status(403).json({ error: 'Acesso negado a este módulo.' });
  };
}

// Igual ao requirePage, mas aceita QUALQUER uma das páginas informadas.
// Usado onde a mesma rota serve o app do operador e o desktop do gestor
// (ex.: distribuição do comboio: 'comboio' OU 'admin_solicitacoes_app').
function requireAnyPage(pageIds) {
  const lista = Array.isArray(pageIds) ? pageIds : [pageIds];
  return (req, res, next) => {
    if (req.user && lista.some(p => canUserAccessPage(req.user, p))) return next();
    return res.status(403).json({ error: 'Acesso negado a este módulo.' });
  };
}

function getVehicleButtons(role) {
  return VEHICLE_ACTION_BUTTONS[(role || '').toLowerCase()] || [];
}

module.exports = {
  ROLE_PAGE_ACCESS,
  VEHICLE_ACTION_BUTTONS,
  ROLES_NO_DELETE,
  ROLES_NO_PASSWORD_RELEASE,
  normalizePagePermissions,
  getRolePages,
  getEffectivePages,
  canUserAccessPage,
  canAccessPage,
  requirePage,
  requireAnyPage,
  getVehicleButtons,
};
