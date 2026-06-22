import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { num, join } from '../../utils/format';
import { colors } from '../../theme/tokens';

export default function EstoqueScreen() {
  return (
    <SearchableList
      fetcher={api.getInventoryItems}
      placeholder="Item, SKU ou código…"
      emptyIcon="package-variant-closed"
      emptyTitle="Nenhum item em estoque"
      searchText={(i) => [i.name, i.sku, i.internalCode, i.categoryName]}
      renderItem={(item) => {
        const qtd = Number(item.quantity) || 0;
        const min = Number(item.minQuantity) || 0;
        const baixo = min > 0 && qtd <= min;
        const unidade = item.unit ? ` ${item.unit}` : '';
        return (
          <ListItem
            icon="package-variant"
            title={item.name || `Item #${item.id}`}
            pill={{
              label: `${num(qtd)}${unidade}`,
              bg: baixo ? colors.dangerBg : colors.successBg,
              text: baixo ? colors.danger : colors.success,
              dot: baixo ? '#b03828' : '#10b981',
            }}
            meta={join(item.categoryName, item.sku || item.internalCode, baixo ? `mín. ${num(min)}` : null)}
          />
        );
      }}
    />
  );
}
