// Lista genérica com busca + pull-to-refresh + loading/vazio.
// Usada pelas telas de listagem simples (despesas, oficina, estoque, multas…).
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, RefreshControl, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Pill, EmptyState, Loading } from './ui';
import { colors, radius, spacing } from '../theme/tokens';

// Linha padrão: ícone + título (+ pill opcional) + meta + acessório à direita.
export function ListItem({ icon, title, pill, meta, right, onPress }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={s.item} activeOpacity={0.7} onPress={onPress}>
      {icon ? (
        <View style={s.itemIcon}>
          <Icon name={icon} size={20} color={colors.amber} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={s.itemTitle} numberOfLines={1}>{title}</Text>
          {pill ? <Pill label={pill.label} bg={pill.bg} text={pill.text} dot={pill.dot} /> : null}
        </View>
        {meta ? <Text style={s.itemMeta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {right || (onPress ? <Icon name="chevron-right" size={18} color={colors.fg4} /> : null)}
    </Wrapper>
  );
}

export default function SearchableList({
  fetcher,
  searchText,          // (item) => string[] | string  — campos pesquisáveis
  placeholder = 'Buscar…',
  keyboardType,
  autoCapitalize = 'sentences',
  emptyIcon = 'inbox',
  emptyTitle = 'Nada encontrado',
  renderItem,
}) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetcher();
      setRows(Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []));
    } catch {
      setRows((prev) => prev || []);
    }
  }, [fetcher]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q || !searchText) return rows;
    return rows.filter((item) => {
      const v = searchText(item);
      const arr = Array.isArray(v) ? v : [v];
      return arr.filter(Boolean).some((field) => String(field).toLowerCase().includes(q));
    });
  }, [rows, query, searchText]);

  if (rows === null) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      {searchText ? (
        <View style={s.searchWrap}>
          <Icon name="magnify" size={18} color={colors.fg4} />
          <TextInput
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={placeholder}
            placeholderTextColor={colors.fg5}
            keyboardType={keyboardType}
            autoCapitalize={autoCapitalize}
          />
          {query ? (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Icon name="close-circle" size={16} color={colors.fg4} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(item, i) => String(item.id ?? item._id ?? i)}
        contentContainerStyle={{ padding: spacing[4], paddingTop: spacing[2], gap: spacing[2], flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<EmptyState icon={emptyIcon} title={emptyTitle} />}
        renderItem={({ item }) => renderItem(item)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3],
    margin: spacing[4], marginBottom: 0,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.fg2 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  itemIcon: {
    width: 38, height: 38, borderRadius: radius.md, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  itemTitle: { fontSize: 14, fontWeight: '700', color: colors.fg1, flexShrink: 1 },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
});
