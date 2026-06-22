import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { num, dateBR, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

// O plano pode vir achatado ou aninhado em item.revision.
const rev = (item) => item.revision || item;

export default function RevisoesScreen() {
  return (
    <SearchableList
      fetcher={api.getRevisions}
      placeholder="Placa, registro ou descrição…"
      autoCapitalize="characters"
      emptyIcon="wrench-outline"
      emptyTitle="Nenhum plano de revisão"
      searchText={(item) => [item.placa, item.registroInterno, item.modelo, rev(item).descricao]}
      renderItem={(item) => {
        const r = rev(item);
        const proxima =
          r.proximaRevisaoData ? `Vence ${dateBR(r.proximaRevisaoData)}`
          : r.proximaRevisaoOdometro ? `${num(r.proximaRevisaoOdometro)} km`
          : r.proximaRevisaoHorimetro ? `${num(r.proximaRevisaoHorimetro)} h`
          : null;
        const atrasada = /atras|vencid/i.test(r.status || '');
        return (
          <ListItem
            icon="wrench"
            title={item.placa || item.registroInterno || r.descricao || `Revisão #${item.id}`}
            pill={r.status ? {
              label: r.status,
              bg: atrasada ? colors.dangerBg : colors.warningBg,
              text: atrasada ? colors.danger : colors.warning,
            } : null}
            meta={join(r.descricao, proxima, item.modelo)}
          />
        );
      }}
    />
  );
}
