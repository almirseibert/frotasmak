// Design tokens — Terroso Mineral (espelha frontend/design_handoff/tokens/colors_and_type.css)

export const colors = {
  // Brand
  amber: '#9E7A42',
  amberHover: '#8a6a34',
  gold: '#facc15',

  // Shell escuro
  shellBg: '#1c1a17',
  shellSurface: '#252018',
  shellBorder: '#3d3528',
  shellText: '#8a7a68',
  shellTextHi: '#f0ebe3',

  // App
  appBg: '#f5f3ef',
  surface: '#ffffff',
  surfaceSubtle: '#faf9f7',
  surfaceMuted: '#f5f2ed',

  // Texto
  fg1: '#1e1a14',
  fg2: '#3d3528',
  fg3: '#6a5e4e',
  fg4: '#9a8a78',
  fg5: '#b0a090',
  fgInverse: '#ffffff',

  // Bordas
  border: '#e8e0d4',
  borderSubtle: '#f0ebe3',
  borderStrong: '#d4c8b8',

  // Semântico
  success: '#3d5a44',
  successBg: '#f3f8f4',
  successBorder: '#b8d4bc',
  warning: '#a06828',
  warningBg: '#fdf8ec',
  warningBorder: '#e8d8bc',
  danger: '#b03828',
  dangerBg: '#fdf0ec',
  dangerBorder: '#e8c8bc',
  info: '#2d5a8a',
  infoBg: '#eff5fc',
  infoBorder: '#c0d4e8',
};

// Status de solicitação de abastecimento (enum do banco → cor)
export const solicitacaoStatus = {
  PENDENTE: { label: 'Pendente', bg: '#fef3c7', text: '#78350f', dot: '#fbbf24' },
  LIBERADO: { label: 'Liberado', bg: '#e0f2fe', text: '#0c4a6e', dot: '#0ea5e9' },
  AGUARDANDO_BAIXA: { label: 'Em análise', bg: '#ffedd5', text: '#9a3412', dot: '#f97316' },
  CONCLUIDO: { label: 'Concluído', bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  CONCLUIDA: { label: 'Concluído', bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  NEGADO: { label: 'Negado', bg: '#fdf0ec', text: '#b03828', dot: '#b03828' },
  REJEITADO: { label: 'Rejeitado', bg: '#fdf0ec', text: '#b03828', dot: '#b03828' },
};

// Status de veículo
export const vehicleStatus = {
  'Disponível': { bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  'Ativo': { bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  'Em Obra': { bg: '#e0f2fe', text: '#0c4a6e', dot: '#0ea5e9' },
  'Em Operação': { bg: '#ede9fe', text: '#3730a3', dot: '#8b5cf6' },
  'Manutenção': { bg: '#ffedd5', text: '#9a3412', dot: '#f97316' },
  'Aguardando': { bg: '#fef3c7', text: '#78350f', dot: '#fbbf24' },
  'Sucata': { bg: '#f4f4f5', text: '#3f3f46', dot: '#71717a' },
  'Inativo': { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' },
  'Terceiro': { bg: '#f3e8ff', text: '#6b21a8', dot: '#a855f7' },
};

// Criticidade da obra (status_cor do /supervisor/dashboard → cor)
export const obraStatus = {
  red: { label: 'Crítica', bg: '#fdf0ec', text: '#b03828', dot: '#ef4444' },
  violet: { label: 'Atenção', bg: '#f3e8ff', text: '#6b21a8', dot: '#a855f7' },
  yellow: { label: 'Em andamento', bg: '#fef3c7', text: '#78350f', dot: '#fbbf24' },
  green: { label: 'Saudável', bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
};

export const radius = { sm: 6, md: 8, lg: 12, xl: 14, xxl: 16, full: 9999 };

export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 };

export const type = {
  // RN usa fontes do sistema por padrão; Roboto é a padrão no Android.
  mono: 'monospace',
  size: {
    xxs: 10, xs: 12, sm: 14, base: 16, lg: 18, xl: 20, xxl: 24, xxxl: 30,
  },
};
