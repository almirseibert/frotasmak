import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, RefreshControl, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Pill, EmptyState, Loading } from '../../components/ui';
import { colors, radius, spacing, vehicleStatus } from '../../theme/tokens';

const iconForType = (tipo = '') => {
  const t = tipo.toLowerCase();
  if (t.includes('escavadeira') || t.includes('retro')) return 'excavator';
  if (t.includes('moto')) return 'motorbike';
  if (t.includes('automóvel') || t.includes('automovel') || t.includes('picape')) return 'car';
  if (t.includes('caminhão') || t.includes('caminhao') || t.includes('cavalo')) return 'truck';
  return 'truck-outline';
};

export default function FrotaScreen({ navigation }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getVehicles();
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
    return rows.filter((v) =>
      [v.placa, v.registroInterno, v.tipo, v.marca, v.modelo]
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
          placeholder="Placa, registro ou tipo…"
          placeholderTextColor={colors.fg5}
          autoCapitalize="characters"
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
        ListEmptyComponent={
          <EmptyState icon="truck-off" title="Nenhum veículo encontrado" />
        }
        renderItem={({ item }) => {
          const isTerceiro = item.isOutsourced == 1 || item.is_terceiro == 1;
          const st = isTerceiro
            ? vehicleStatus['Terceiro']
            : vehicleStatus[item.status] || vehicleStatus['Disponível'];
          const leitura = item.odometro
            ? `${Number(item.odometro).toLocaleString('pt-BR')} km`
            : item.horimetro
              ? `${Number(item.horimetro).toLocaleString('pt-BR')} h`
              : null;
          return (
            <TouchableOpacity
              style={[s.item, isTerceiro && { borderColor: '#e9d5ff' }]}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('DetalheVeiculo', { id: item.id, placa: item.placa })}
            >
              <View style={[s.itemIcon, isTerceiro && { backgroundColor: '#f3e8ff' }]}>
                <Icon
                  name={iconForType(item.tipo)}
                  size={20}
                  color={isTerceiro ? '#a855f7' : colors.amber}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.itemPlaca}>{item.placa || item.registroInterno || '—'}</Text>
                  <Pill label={isTerceiro ? 'Terceiro' : (item.status || '—')} bg={st.bg} text={st.text} dot={st.dot} />
                </View>
                <Text style={s.itemMeta} numberOfLines={1}>
                  {[item.tipo, item.marca, leitura].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Icon name="chevron-right" size={18} color={colors.fg4} />
            </TouchableOpacity>
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
  itemPlaca: { fontSize: 14, fontWeight: '700', color: colors.fg1, letterSpacing: 0.5 },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
});
