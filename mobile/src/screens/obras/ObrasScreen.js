import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, RefreshControl, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Pill, EmptyState, Loading } from '../../components/ui';
import { colors, radius, spacing, obraStatus } from '../../theme/tokens';

const nomeObra = (o) => o.nome || o.descricao || `Obra ${o.id}`;

export default function ObrasScreen() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getObras();
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
    return rows.filter((o) =>
      [nomeObra(o), o.regiao, o.orgao_contratante, o.orgaoContratante]
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
          placeholder="Obra, região ou órgão…"
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
        ListEmptyComponent={<EmptyState icon="office-building-outline" title="Nenhuma obra encontrada" />}
        renderItem={({ item }) => {
          const cor = item.kpi?.status_cor || item.status_cor;
          const st = obraStatus[cor];
          return (
            <View style={s.item}>
              <View style={s.itemIcon}>
                <Icon name="office-building" size={20} color={colors.amber} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.itemTitle} numberOfLines={1}>{nomeObra(item)}</Text>
                  {st ? <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} /> : null}
                </View>
                <Text style={s.itemMeta} numberOfLines={1}>
                  {[item.regiao, item.orgao_contratante || item.orgaoContratante].filter(Boolean).join(' · ') || '—'}
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
