import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../api/client';
import { KpiCard, SectionTitle, ListRow, Loading } from '../../components/ui';
import { colors, spacing } from '../../theme/tokens';

const isTerceiro = (v) => v.isOutsourced == 1 || v.is_terceiro == 1;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// Data pode vir como r.date ou r.data, ISO ou "YYYY-MM-DD ..."
const parseDate = (r) => {
  const raw = r.date || r.data || r.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export default function RelatoriosScreen({ navigation }) {
  const [vehicles, setVehicles] = useState(null);
  const [refuelings, setRefuelings] = useState([]);
  const [obras, setObras] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [v, r, o] = await Promise.all([
      api.getVehicles().catch(() => []),
      api.getRefuelings().catch(() => []),
      api.getObras().catch(() => []),
    ]);
    setVehicles(Array.isArray(v) ? v : []);
    setRefuelings(Array.isArray(r) ? r : []);
    setObras(Array.isArray(o) ? o : []);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (vehicles === null) return <Loading />;

  // --- Frota ---
  const proprios = vehicles.filter((v) => !isTerceiro(v));
  const frotaAtiva = proprios.filter((v) => !['Inativo', 'Sucata'].includes(v.status)).length;
  const emObra = vehicles.filter((v) => v.status === 'Em Obra' || v.status === 'Em Operação').length;
  const emManutencao = vehicles.filter((v) => v.status === 'Manutenção').length;
  const terceiros = vehicles.filter(isTerceiro).length;

  // --- Abastecimentos do mês corrente ---
  const now = new Date();
  const doMes = refuelings.filter((r) => {
    const d = parseDate(r);
    return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const litrosMes = doMes.reduce((acc, r) => acc + num(r.litrosLiberados), 0);
  const concluidos = refuelings.filter((r) => /CONCLU/i.test(r.status || '')).length;

  // --- Obras por criticidade ---
  const obrasCriticas = obras.filter((o) => (o.kpi?.status_cor || o.status_cor) === 'red').length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={s.title}>Visão geral</Text>

      <SectionTitle>Frota</SectionTitle>
      <View style={s.kpiRow}>
        <KpiCard value={String(frotaAtiva)} label="Própria ativa" />
        <KpiCard value={String(emObra)} label="Em obra / operação" color={colors.info} />
      </View>
      <View style={s.kpiRow}>
        <KpiCard value={String(emManutencao)} label="Manutenção" color={emManutencao ? colors.danger : undefined} />
        <KpiCard value={String(terceiros)} label="Terceiros" />
      </View>

      <SectionTitle>Abastecimentos · {now.toLocaleDateString('pt-BR', { month: 'long' })}</SectionTitle>
      <View style={s.kpiRow}>
        <KpiCard value={String(doMes.length)} label="Pedidos no mês" />
        <KpiCard
          value={litrosMes.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}
          label="Litros liberados"
          color={colors.amber}
        />
      </View>
      <View style={s.kpiRow}>
        <KpiCard value={String(refuelings.length)} label="Total registrado" />
        <KpiCard value={String(concluidos)} label="Concluídos" color={colors.success} />
      </View>

      <SectionTitle>Obras</SectionTitle>
      <View style={s.kpiRow}>
        <KpiCard value={String(obras.length)} label="Total" />
        <KpiCard value={String(obrasCriticas)} label="Críticas" color={obrasCriticas ? colors.danger : undefined} />
      </View>

      <SectionTitle>Detalhar</SectionTitle>
      <View style={{ gap: spacing[2] }}>
        <ListRow icon="gas-station" title="Abastecimentos" subtitle="Todos os pedidos e baixas" onPress={() => navigation.navigate('Abastecimentos')} />
        <ListRow icon="truck" title="Frota" subtitle="Veículos e leituras" onPress={() => navigation.navigate('Frota')} />
        <ListRow icon="office-building" title="Obras" subtitle="Contratos e regiões" onPress={() => navigation.navigate('Obras')} />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 20, fontWeight: '700', color: colors.fg1 },
  kpiRow: { flexDirection: 'row', gap: spacing[2] },
});
