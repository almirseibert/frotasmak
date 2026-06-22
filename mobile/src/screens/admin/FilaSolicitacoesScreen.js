import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, RefreshControl, TouchableOpacity, Alert, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Pill, EmptyState, Loading, PrimaryButton } from '../../components/ui';
import { colors, radius, spacing, solicitacaoStatus } from '../../theme/tokens';

const TABS = [
  ['PENDENTE', 'Pendentes'],
  ['AGUARDANDO_BAIXA', 'Baixas'],
  ['historico', 'Histórico'],
];

export default function FilaSolicitacoesScreen({ navigation }) {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('PENDENTE');
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

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

  const avaliar = (sol, aprovado) => {
    const acao = aprovado ? 'Liberar' : 'Negar';
    Alert.alert(`${acao} #${sol.id}`, `${sol.placa || 'Veículo'} · ${sol.tipo_combustivel || ''}`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: acao,
        style: aprovado ? 'default' : 'destructive',
        onPress: async () => {
          setBusyId(sol.id);
          try {
            await api.avaliarSolicitacao(sol.id, {
              aprovado,
              avaliado_por: { id: user?.id, name: user?.name },
            });
            await load();
          } catch (e) {
            Alert.alert('Erro', e.message || 'Não foi possível avaliar.');
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  if (rows === null) return <Loading />;

  const filtered = rows.filter((sol) =>
    tab === 'historico'
      ? !['PENDENTE', 'AGUARDANDO_BAIXA'].includes(sol.status)
      : sol.status === tab
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <View style={s.segmented}>
        {TABS.map(([key, label]) => (
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
          <EmptyState icon="check-all" title="Fila limpa" subtitle="Nada aguardando ação aqui." />
        }
        renderItem={({ item }) => {
          const st = solicitacaoStatus[item.status] || solicitacaoStatus.PENDENTE;
          const quando = item.data_solicitacao
            ? new Date(item.data_solicitacao).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '';
          return (
            <TouchableOpacity
              style={s.item}
              activeOpacity={0.8}
              onPress={() => navigation.navigate('AnaliseSolicitacao', { solicitacao: item })}
            >
              <View style={s.itemHead}>
                <Text style={s.itemNum}>#{item.id}</Text>
                <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
              </View>
              <Text style={s.itemMeta}>
                {item.placa || item.veiculo_nome || 'Veículo'} · {item.solicitante_nome || '—'}
              </Text>
              <Text style={s.itemMeta}>
                {item.tipo_combustivel || '—'}
                {item.flag_tanque_cheio ? ' · tanque cheio' : item.litragem_solicitada ? ` · ${item.litragem_solicitada} L` : ''}
                {item.posto_nome ? ` · ${item.posto_nome}` : ''}
              </Text>
              <Text style={s.itemMetaDim}>{quando}{item.obra_nome ? ` · ${item.obra_nome}` : ''}</Text>

              {item.status === 'PENDENTE' ? (
                <View style={s.actions}>
                  <PrimaryButton
                    label="Liberar" icon="check"
                    style={{ flex: 1, minHeight: 40, paddingVertical: 8 }}
                    loading={busyId === item.id}
                    onPress={() => avaliar(item, true)}
                  />
                  <PrimaryButton
                    label="Negar" icon="close" variant="danger"
                    style={{ flex: 1, minHeight: 40, paddingVertical: 8 }}
                    disabled={busyId === item.id}
                    onPress={() => avaliar(item, false)}
                  />
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
  segmentText: { fontSize: 12.5, fontWeight: '500', color: colors.fg3 },
  segmentTextActive: { color: colors.fg1 },

  item: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  itemNum: { fontSize: 14, fontWeight: '600', color: colors.fg1, fontVariant: ['tabular-nums'] },
  itemMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
  itemMetaDim: { fontSize: 11, color: colors.fg4, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[3] },
});
