import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { brl, dateBR, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

export default function DespesasScreen() {
  return (
    <SearchableList
      fetcher={api.getExpenses}
      placeholder="Descrição, categoria…"
      emptyIcon="cash-remove"
      emptyTitle="Nenhuma despesa encontrada"
      searchText={(e) => [e.description, e.category, e.createdBy]}
      renderItem={(item) => (
        <ListItem
          icon="cash"
          title={item.description || item.category || `Despesa #${item.id}`}
          pill={item.amount != null ? { label: brl(item.amount), bg: colors.warningBg, text: colors.warning } : null}
          meta={join(item.category, dateBR(item.createdAt || item.date), item.createdBy)}
        />
      )}
    />
  );
}
