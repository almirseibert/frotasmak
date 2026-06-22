import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { dateTimeBR, join } from '../../utils/format';

const TIPO_LABEL = {
  mudanca_obra: 'Mudança de obra',
  mudanca_operador: 'Mudança de operador',
};

const statusPill = (status = '') => {
  const t = status.toLowerCase();
  if (t.includes('resolv')) return { label: 'Resolvida', bg: '#d1fae5', text: '#065f46', dot: '#10b981' };
  return { label: 'Pendente', bg: '#fef3c7', text: '#78350f', dot: '#fbbf24' };
};

export default function CentralOperacionalScreen() {
  return (
    <SearchableList
      fetcher={api.getOperationalRequests}
      placeholder="Veículo ou obra…"
      autoCapitalize="characters"
      emptyIcon="check-circle-outline"
      emptyTitle="Nenhuma requisição operacional"
      searchText={(r) => [r.veiculo_registro, r.obra_atual_nome, r.solicitante_email]}
      renderItem={(item) => {
        const st = statusPill(item.status);
        return (
          <ListItem
            icon="swap-horizontal"
            title={item.veiculo_registro || `Requisição #${item.id}`}
            pill={st}
            meta={join(TIPO_LABEL[item.tipo] || item.tipo, item.obra_atual_nome, dateTimeBR(item.created_at))}
          />
        );
      }}
    />
  );
}
