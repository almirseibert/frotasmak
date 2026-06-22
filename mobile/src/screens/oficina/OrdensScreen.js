import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { brl, dateBR, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

const statusPill = (status = '') => {
  const t = status.toLowerCase();
  if (t.includes('cancel')) return { label: status, bg: colors.dangerBg, text: colors.danger, dot: '#b03828' };
  if (t.includes('conclu') || t.includes('pago') || t.includes('finaliz')) return { label: status, bg: colors.successBg, text: colors.success, dot: '#10b981' };
  if (t.includes('abert') || t.includes('pend')) return { label: status, bg: colors.warningBg, text: colors.warning, dot: '#fbbf24' };
  return { label: status || '—', bg: colors.surfaceMuted, text: colors.fg3, dot: colors.fg4 };
};

export default function OrdensScreen() {
  return (
    <SearchableList
      fetcher={api.getOrders}
      placeholder="Nº da ordem, fornecedor…"
      emptyIcon="clipboard-text-off-outline"
      emptyTitle="Nenhuma ordem encontrada"
      searchText={(o) => [o.orderNumber, o.supplier, o.type, o.invoiceNumber]}
      renderItem={(item) => {
        const total = item.totalValue ?? item.total;
        return (
          <ListItem
            icon="clipboard-list-outline"
            title={item.orderNumber ? `OS ${item.orderNumber}` : `Ordem #${item.id}`}
            pill={statusPill(item.status)}
            meta={join(item.type, item.supplier, dateBR(item.date), total != null ? brl(total) : null)}
          />
        );
      }}
    />
  );
}
