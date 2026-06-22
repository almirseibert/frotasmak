import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { KpiCard, Card, Pill, SectionTitle, EmptyState, Loading } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';

const formatBRL = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

// Sem operador real definido → entra placeholder e, após 7 dias na obra,
// bloqueia emissão de ordens (ver refuelingController PLACEHOLDER_OPERATOR_BLOCK).
const semOperador = (v) => {
  const op = (v.operador_atual || '').trim().toLowerCase();
  return !op || op === 'a definir';
};

function VeiculoRow({ v }) {
  const alerta = semOperador(v);
  return (
    <Card tone={alerta ? 'warning' : undefined} style={{ gap: 6 }}>
      <View style={s.vTop}>
        <Text style={s.placa}>{v.placa}</Text>
        <Text style={s.tipo} numberOfLines={1}>{[v.marca, v.modelo].filter(Boolean).join(' ') || v.tipo}</Text>
      </View>
      <View style={s.vMeta}>
        <Text style={s.metaItem}>
          <Icon name="account-hard-hat" size={12} color={alerta ? colors.warning : colors.fg4} />{' '}
          {alerta ? 'Operador a definir' : v.operador_atual}
        </Text>
        <Text style={s.metaItem}>
          <Icon name="clock-outline" size={12} color={colors.fg4} /> {(v.media_diaria || 0).toFixed(1)} h/dia
        </Text>
      </View>
      {v.proximo_destino ? (
        <Text style={s.destino} numberOfLines={1}>
          <Icon name="map-marker-right-outline" size={12} color={colors.fg4} /> Próx.: {v.proximo_destino}
        </Text>
      ) : null}
    </Card>
  );
}

export default function DetalheObraScreen({ route }) {
  const { id } = route.params || {};
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const d = await api.getObraDetalhe(id).catch(() => null);
    setData(d);
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) return <Loading />;
  if (!data) {
    return <EmptyState icon="alert-circle-outline" title="Obra não encontrada" subtitle="Não foi possível carregar os detalhes." />;
  }

  const { contract = {}, financeiro = {}, producao = {}, veiculos = [] } = data;
  const oculta = contract.is_hidden === 1;
  const semOp = veiculos.filter(semOperador);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={s.kpiRow}>
        <KpiCard
          value={oculta ? '—' : `${(producao.media_diaria_atual || 0).toFixed(1)}h`}
          label="Média diária"
        />
        <KpiCard value={`${(producao.horas_executadas || 0).toLocaleString('pt-BR')}h`} label="Executadas" />
      </View>
      <View style={s.kpiRow}>
        <KpiCard value={`${Math.round(producao.saldo_horas || 0).toLocaleString('pt-BR')}h`} label="Saldo de horas" />
        <KpiCard value={String(veiculos.length)} label="Veículos alocados" />
      </View>

      <SectionTitle>Financeiro</SectionTitle>
      <Card style={{ gap: 8 }}>
        <View style={s.finRow}>
          <Text style={s.finLabel}>Contrato</Text>
          <Text style={s.finValue}>{formatBRL(financeiro.total_contrato)}</Text>
        </View>
        <View style={s.finRow}>
          <Text style={s.finLabel}>Despesas</Text>
          <Text style={[s.finValue, { color: colors.danger }]}>{formatBRL(financeiro.total_despesas)}</Text>
        </View>
        <View style={[s.finRow, s.finTotal]}>
          <Text style={[s.finLabel, { fontWeight: '600', color: colors.fg1 }]}>Pendente faturamento</Text>
          <Text style={[s.finValue, { color: colors.success }]}>{formatBRL(financeiro.pendente_faturamento)}</Text>
        </View>
      </Card>

      {semOp.length > 0 && (
        <Card tone="warning">
          <View style={s.alertRow}>
            <Icon name="account-alert" size={18} color={colors.warning} />
            <Text style={s.alertText}>
              {semOp.length} veículo{semOp.length === 1 ? '' : 's'} sem operador real definido — após 7 dias,
              a emissão de ordens é bloqueada.
            </Text>
          </View>
        </Card>
      )}

      <SectionTitle>Veículos alocados · {veiculos.length}</SectionTitle>
      {veiculos.length === 0 ? (
        <EmptyState icon="truck-outline" title="Nenhum veículo alocado" />
      ) : (
        veiculos.map((v) => <VeiculoRow key={v.id} v={v} />)
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  kpiRow: { flexDirection: 'row', gap: spacing[2] },
  vTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  placa: { fontSize: 15, fontWeight: '700', color: colors.fg1, fontVariant: ['tabular-nums'] },
  tipo: { flex: 1, fontSize: 12, color: colors.fg3, textAlign: 'right' },
  vMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metaItem: { fontSize: 12, color: colors.fg3 },
  destino: { fontSize: 12, color: colors.fg3 },
  finRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  finLabel: { fontSize: 13, color: colors.fg3 },
  finValue: { fontSize: 14, fontWeight: '500', color: colors.fg1, fontVariant: ['tabular-nums'] },
  finTotal: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 2 },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  alertText: { flex: 1, fontSize: 13, color: '#5a3a18', lineHeight: 18 },
});
