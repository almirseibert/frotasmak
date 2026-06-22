import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { num, dateBR, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

export default function HorasScreen() {
  return (
    <SearchableList
      fetcher={api.getBillingLogs}
      placeholder="Registro do veículo…"
      autoCapitalize="characters"
      emptyIcon="clock-alert-outline"
      emptyTitle="Nenhum apontamento de horas"
      searchText={(l) => [l.registroInterno, l.placa]}
      renderItem={(item) => {
        const horas = item.totalHours != null ? `${num(item.totalHours)} h` : null;
        return (
          <ListItem
            icon="clock-outline"
            title={item.registroInterno || item.placa || `Apontamento #${item.id}`}
            pill={horas ? { label: horas, bg: colors.infoBg, text: colors.info } : null}
            meta={join(dateBR(item.data || item.date), item.obraNome)}
          />
        );
      }}
    />
  );
}
