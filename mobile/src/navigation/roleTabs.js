// Navegação por papel — deriva de frontend/src/utils/permissions.js (ROLE_PAGE_ACCESS)
// Cada papel: até 4 abas fixas + "Mais" com o restante dos módulos permitidos.

export const ROLE_PAGE_ACCESS = {
  admin: ['*'],
  gerencia: ['dashboard', 'obras', 'expenses', 'operacional', 'billing', 'reports', 'refueling', 'comboio', 'admin_solicitacoes', 'orders', 'revisions', 'tires', 'vehicles', 'employees', 'partners', 'inventory', 'fines', 'sigasul', 'supervisor_dashboard'],
  rh: ['dashboard', 'obras', 'billing', 'reports', 'vehicles', 'employees', 'fines'],
  faturamento: ['dashboard', 'obras', 'operacional', 'billing', 'reports', 'vehicles'],
  abastecimento: ['dashboard', 'obras', 'expenses', 'reports', 'refueling', 'comboio', 'admin_solicitacoes', 'orders', 'vehicles', 'partners', 'inventory'],
  oficina: ['dashboard', 'obras', 'reports', 'revisions', 'tires', 'orders', 'vehicles', 'inventory', 'employees'],
  editor: ['dashboard', 'obras', 'expenses', 'operacional', 'billing', 'reports', 'refueling', 'comboio', 'admin_solicitacoes', 'orders', 'revisions', 'tires', 'vehicles', 'employees', 'partners', 'inventory', 'fines'],
  supervisor: ['dashboard', 'obras', 'supervisor_dashboard', 'expenses', 'operacional', 'billing', 'reports', 'revisions', 'tires', 'orders', 'vehicles'],
  operador: ['solicitacoes_app'],
  viewer: ['dashboard', 'reports'],
  visualizador: ['dashboard', 'reports'],
};

export const canAccessPage = (role, pageId) => {
  const pages = ROLE_PAGE_ACCESS[role?.toLowerCase()] || ROLE_PAGE_ACCESS.viewer;
  return pages.includes('*') || pages.includes(pageId);
};

// Catálogo de módulos (grade "Mais" agrupada — espelha grupos da Sidebar web)
export const MODULE_CATALOG = [
  {
    group: 'Obras & faturamento',
    items: [
      { id: 'obras', label: 'Obras', icon: 'office-building' },
      { id: 'expenses', label: 'Despesas', icon: 'cash' },
      { id: 'billing', label: 'Horas', icon: 'clock-outline' },
      { id: 'operacional', label: 'Central operacional', icon: 'view-dashboard-outline' },
    ],
  },
  {
    group: 'Operações',
    items: [
      { id: 'refueling', label: 'Abastecimento', icon: 'gas-station' },
      { id: 'comboio', label: 'Comboio', icon: 'tanker-truck' },
      { id: 'admin_solicitacoes', label: 'Solicitações (app)', icon: 'cellphone' },
    ],
  },
  {
    group: 'Oficina',
    items: [
      { id: 'revisions', label: 'Revisões', icon: 'wrench' },
      { id: 'tires', label: 'Pneus', icon: 'circle-double' },
      { id: 'orders', label: 'Ordens C/S', icon: 'clipboard-list-outline' },
    ],
  },
  {
    group: 'Cadastros',
    items: [
      { id: 'vehicles', label: 'Veículos', icon: 'truck' },
      { id: 'employees', label: 'Funcionários', icon: 'account-group' },
      { id: 'partners', label: 'Fornecedores', icon: 'store' },
      { id: 'inventory', label: 'Estoque', icon: 'package-variant' },
      { id: 'fines', label: 'Multas', icon: 'file-alert-outline' },
    ],
  },
  {
    group: 'Administração',
    items: [
      { id: 'admin_usuarios', label: 'Usuários & acesso', icon: 'shield-account', adminOnly: true },
      { id: 'sigasul', label: 'SigaSul GPS', icon: 'map-marker' },
      { id: 'reports', label: 'Relatórios', icon: 'chart-bar' },
    ],
  },
];

// Abas inferiores por papel: [{ name, label, icon, screen }]
// screen refere-se a chaves registradas no RootNavigator.
export const ROLE_TABS = {
  operador: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'OperadorHome' },
    { name: 'Solicitacoes', label: 'Solicitações', icon: 'format-list-bulleted', screen: 'MinhasSolicitacoes' },
    { name: 'Perfil', label: 'Perfil', icon: 'account', screen: 'Perfil' },
  ],
  admin: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'AdminHome' },
    { name: 'Solicitacoes', label: 'Solicitações', icon: 'gas-station', screen: 'FilaSolicitacoes' },
    { name: 'Frota', label: 'Frota', icon: 'truck', screen: 'Frota' },
    { name: 'Relatorios', label: 'Relatórios', icon: 'chart-bar', screen: 'Relatorios' },
    { name: 'Mais', label: 'Mais', icon: 'dots-grid', screen: 'Mais' },
  ],
  gerencia: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'AdminHome' },
    { name: 'Solicitacoes', label: 'Solicitações', icon: 'gas-station', screen: 'FilaSolicitacoes' },
    { name: 'Frota', label: 'Frota', icon: 'truck', screen: 'Frota' },
    { name: 'Relatorios', label: 'Relatórios', icon: 'chart-bar', screen: 'Relatorios' },
    { name: 'Mais', label: 'Mais', icon: 'dots-grid', screen: 'Mais' },
  ],
  abastecimento: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'AdminHome' },
    { name: 'Solicitacoes', label: 'Solicitações', icon: 'gas-station', screen: 'FilaSolicitacoes' },
    { name: 'Comboio', label: 'Comboio', icon: 'tanker-truck', screen: 'Comboio' },
    { name: 'Mais', label: 'Mais', icon: 'dots-grid', screen: 'Mais' },
  ],
  oficina: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'AdminHome' },
    { name: 'Frota', label: 'Frota', icon: 'truck', screen: 'Frota' },
    { name: 'Mais', label: 'Mais', icon: 'dots-grid', screen: 'Mais' },
  ],
  supervisor: [
    { name: 'Home', label: 'Obras', icon: 'office-building', screen: 'SupervisorHome' },
    { name: 'Frota', label: 'Frota', icon: 'truck', screen: 'Frota' },
    { name: 'Relatorios', label: 'Relatórios', icon: 'chart-bar', screen: 'Relatorios' },
    { name: 'Mais', label: 'Mais', icon: 'dots-grid', screen: 'Mais' },
  ],
  viewer: [
    { name: 'Home', label: 'Início', icon: 'home', screen: 'AdminHome' },
    { name: 'Relatorios', label: 'Relatórios', icon: 'chart-bar', screen: 'Relatorios' },
    { name: 'Perfil', label: 'Perfil', icon: 'account', screen: 'Perfil' },
  ],
};

export const getTabsForRole = (role) => {
  const r = (role || 'viewer').toLowerCase();
  if (ROLE_TABS[r]) return ROLE_TABS[r];
  // rh, faturamento, editor, visualizador → variações próximas
  if (r === 'editor') return ROLE_TABS.gerencia;
  if (r === 'rh' || r === 'faturamento' || r === 'visualizador') return ROLE_TABS.viewer;
  return ROLE_TABS.viewer;
};
