import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { join } from '../../utils/format';

const statusPill = (status = '') => {
  const t = status.toLowerCase();
  if (t.includes('estoque')) return { label: status, bg: '#d1fae5', text: '#065f46', dot: '#10b981' };
  if (t.includes('uso') || t.includes('veículo') || t.includes('veiculo')) return { label: status, bg: '#e0f2fe', text: '#0c4a6e', dot: '#0ea5e9' };
  if (t.includes('sucata') || t.includes('descart')) return { label: status, bg: '#f4f4f5', text: '#3f3f46', dot: '#a1a1aa' };
  if (t.includes('reforma') || t.includes('conserto')) return { label: status, bg: '#ffedd5', text: '#9a3412', dot: '#f97316' };
  return { label: status || '—', bg: '#f5f2ed', text: '#6a5e4e', dot: '#9a8a78' };
};

export default function PneusScreen() {
  return (
    <SearchableList
      fetcher={api.getTires}
      placeholder="Nº de fogo, marca ou veículo…"
      autoCapitalize="characters"
      emptyIcon="circle-off-outline"
      emptyTitle="Nenhum pneu cadastrado"
      searchText={(t) => [t.fireNumber, t.brand, t.model, t.size, t.vehicleRegistro]}
      renderItem={(item) => (
        <ListItem
          icon="circle-double"
          title={item.fireNumber ? `Fogo ${item.fireNumber}` : `Pneu #${item.id}`}
          pill={statusPill(item.status)}
          meta={join(
            [item.brand, item.model].filter(Boolean).join(' '),
            item.size,
            item.vehicleRegistro || item.location
          )}
        />
      )}
    />
  );
}
