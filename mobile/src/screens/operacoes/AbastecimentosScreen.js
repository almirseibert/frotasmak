import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, RefreshControl, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Pill, EmptyState, Loading } from '../../components/ui';
import { colors, radius, spacing, solicitacaoStatus } from '../../theme/tokens';

const neutral = { bg: '#f4f4f5', text: '#3f3f46', dot: '#a1a1aa' };

const formatDate = (r) => {
  const raw = r.date || r.data || r.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('pt-BR');
};

export default function AbastecimentosScreen() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getRefuelings();
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows((prev) => prev || []);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.authNumber, r.partnerName, r.placa, r.status, r.createdBy]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    );
  }, [rows, query]);

  if (rows === null) return <Loading />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <View style={s.searchWrap}>
        <Icon name="magnify" size={18} color={colors.fg4} />
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Autorização, posto ou placa…"
          placeholderTextColor={colors.fg5}
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')}>
            <Icon name="close-circle" size={16} color={colors.fg4} />
          </TouchableOpacity>
        ) : null}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ padding: spacing[4], paddingTop: spacing[2], gap: spacing[2], flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<EmptyState icon="gas-station-off" title="Nenhum abastecimento encontrado" />}
        renderItem={({ item }) => {
          const st = solicitacaoStatus[(item.status || '').toUpperCase()] || neutral;
          const litros = item.litrosLiberados
            ? `${Number(item.litrosLiberados).toLocaleString('pt-BR')} L`
            : null;
          const date = formatDate(item);
          return (
            <View style={s.item}>
              <View style={s.itemIcon}>
                <Icon name="gas-station" size={20} color={colors.amber} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.itemTitle} numberOfLines={1}>
                    {item.authNumber ? `Aut. ${item.authNumber}` : `#${item.id}`}
                  </Text>
                  {item.status ? (
                    <Pill label={st.label || item.status} bg={st.bg} text={st.text} dot={st.dot} />
                  ) : null}
                </View>
                <Text style={s.itemMeta} numberOfLines={1}>
                  {[item.placa, item.partnerName, litros, date].filter(Boolean).join(' · ') || '—'}
                </Text>
              </View>
            </View>
          );
        }}
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
  itemTitle: { fontSize: 14, fontWeight: '700', color: colors.fg1 },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
});
