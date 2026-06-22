import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { dateBR, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

const statusPill = (status = '') => {
  const t = status.toLowerCase();
  if (t.includes('pag')) return { label: status, bg: colors.successBg, text: colors.success, dot: '#10b981' };
  if (t.includes('vencid') || t.includes('atras')) return { label: status, bg: colors.dangerBg, text: colors.danger, dot: '#b03828' };
  if (t.includes('pend') || t.includes('abert')) return { label: status, bg: colors.warningBg, text: colors.warning, dot: '#fbbf24' };
  return { label: status || '—', bg: colors.surfaceMuted, text: colors.fg3, dot: colors.fg4 };
};

export default function MultasScreen() {
  return (
    <SearchableList
      fetcher={api.getFines}
      placeholder="Placa, condutor ou local…"
      autoCapitalize="characters"
      emptyIcon="file-check-outline"
      emptyTitle="Nenhuma multa registrada"
      searchText={(f) => [f.vehicleInfo?.placa, f.employeeInfo?.nome, f.local, f.descricao]}
      renderItem={(item) => (
        <ListItem
          icon="file-alert-outline"
          title={item.vehicleInfo?.placa || item.descricao || `Multa #${item.id}`}
          pill={statusPill(item.status)}
          meta={join(
            item.descricao,
            item.employeeInfo?.nome,
            item.dataVencimento ? `vence ${dateBR(item.dataVencimento)}` : dateBR(item.dataInfra || item.dataInfração)
          )}
        />
      )}
    />
  );
}
