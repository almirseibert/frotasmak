import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Pill, EmptyState, Loading } from '../../components/ui';
import { colors, radius, spacing, solicitacaoStatus } from '../../theme/tokens';

const ABERTAS = ['PENDENTE', 'LIBERADO', 'AGUARDANDO_BAIXA'];

export default function MinhasSolicitacoesScreen({ navigation }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('abertas');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getMinhasSolicitacoes();
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

  if (rows === null) return <Loading />;

  const filtered = rows.filter((sol) =>
    tab === 'abertas' ? ABERTAS.includes(sol.status) : !ABERTAS.includes(sol.status)
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <View style={s.segmented}>
        {[['abertas', 'Em andamento'], ['historico', 'Histórico']].map(([key, label]) => (
          <TouchableOpacity
            key={key}
            style={[s.segment, tab === key && s.segmentActive]}
            onPress={() => setTab(key)}
          >
            <Text style={[s.segmentText, tab === key && s.segmentTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ padding: spacing[4], gap: spacing[2], flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <EmptyState
            icon="clipboard-text-off-outline"
            title={tab === 'abertas' ? 'Nada em andamento' : 'Sem histórico ainda'}
            subtitle={tab === 'abertas' ? 'Suas solicitações abertas aparecem aqui.' : undefined}
          />
        }
        renderItem={({ item }) => {
          const st = solicitacaoStatus[item.status] || solicitacaoStatus.PENDENTE;
          const data = item.data_solicitacao
            ? new Date(item.data_solicitacao).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '';
          return (
            <TouchableOpacity
              style={s.item}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('DetalheSolicitacao', { id: item.id })}
            >
              <View style={s.itemHead}>
                <Text style={s.itemNum}>#{item.id}</Text>
                <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
              </View>
              <Text style={s.itemMeta}>
                {item.placa || item.veiculo_nome || 'Veículo'} · {item.tipo_combustivel || '—'}
                {item.flag_tanque_cheio ? ' · tanque cheio' : item.litragem_solicitada ? ` · ${item.litragem_solicitada} L` : ''}
              </Text>
              <Text style={s.itemMeta}>
                {data}{item.solicitante_nome ? ` · ${item.solicitante_nome}` : ''}
              </Text>
              {item.status === 'LIBERADO' ? (
                <View style={s.itemAction}>
                  <Icon name="camera" size={14} color={colors.amber} />
                  <Text style={s.itemActionText}>Toque para enviar o cupom</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  segmented: {
    flexDirection: 'row', margin: spacing[4], marginBottom: 0,
    backgroundColor: '#ebe5da', borderRadius: radius.md, padding: 3, gap: 3,
  },
  segment: { flex: 1, paddingVertical: 8, borderRadius: radius.sm, alignItems: 'center' },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { fontSize: 13, fontWeight: '500', color: colors.fg3 },
  segmentTextActive: { color: colors.fg1 },

  item: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  itemNum: { fontSize: 14, fontWeight: '600', color: colors.fg1, fontVariant: ['tabular-nums'] },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
  itemAction: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderSubtle,
  },
  itemActionText: { fontSize: 13, color: colors.amber, fontWeight: '600' },
});
