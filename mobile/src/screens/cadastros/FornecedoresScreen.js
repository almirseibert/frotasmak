import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, RefreshControl, TouchableOpacity, Linking, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Pill, EmptyState, Loading } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

const nome = (p) => p.razaoSocial || p.nomeFantasia || `Fornecedor ${p.id}`;

const statusPill = (status = '') => {
  const t = status.toLowerCase();
  if (t.includes('inativ') || t.includes('bloque')) return { label: status, bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' };
  return { label: status || 'Ativo', bg: '#d1fae5', text: '#065f46', dot: '#10b981' };
};

export default function FornecedoresScreen() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getPartners();
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
    return rows.filter((p) =>
      [nome(p), p.nomeFantasia, p.cnpj, p.cidade, p.contatoResponsavel]
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
          placeholder="Razão social, CNPJ ou cidade…"
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
        ListEmptyComponent={<EmptyState icon="store-off-outline" title="Nenhum fornecedor encontrado" />}
        renderItem={({ item }) => {
          const st = statusPill(item.status_operacional);
          const tel = item.telefone || item.whatsapp;
          return (
            <View style={s.item}>
              <View style={s.itemIcon}>
                <Icon name="store" size={20} color={colors.amber} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.itemTitle} numberOfLines={1}>{nome(item)}</Text>
                  <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
                </View>
                <Text style={s.itemMeta} numberOfLines={1}>
                  {[item.cidade, item.contatoResponsavel].filter(Boolean).join(' · ') || '—'}
                </Text>
              </View>
              {tel ? (
                <TouchableOpacity
                  style={s.callBtn}
                  onPress={() => Linking.openURL(`tel:${String(tel).replace(/[^0-9+]/g, '')}`)}
                >
                  <Icon name="phone" size={18} color={colors.amber} />
                </TouchableOpacity>
              ) : null}
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
  itemTitle: { fontSize: 14, fontWeight: '700', color: colors.fg1, flexShrink: 1 },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
  callBtn: {
    width: 38, height: 38, borderRadius: radius.md, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
});
