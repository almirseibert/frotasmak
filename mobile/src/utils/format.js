// Helpers de formatação compartilhados pelas telas de listagem.

export const brl = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR') : null;
};

export const dateBR = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('pt-BR');
};

export const dateTimeBR = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const join = (...parts) => parts.filter(Boolean).join(' · ') || '—';
