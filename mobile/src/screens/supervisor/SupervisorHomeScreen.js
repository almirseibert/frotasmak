import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { KpiCard, Card, Pill, SectionTitle, EmptyState, Loading } from '../../components/ui';
import { colors, spacing, radius, obraStatus } from '../../theme/tokens';

// Ordem de criticidade (espelha STATUS_ORDER do SupervisorDashboard web)
const STATUS_ORDER = { red: 0, violet: 1, yellow: 2, green: 3 };

const formatObraNome = (obra) => {
  const nome = obra?.nome || '';
  const orgao = obra?.orgao_contratante || obra?.orgaoContratante || obra?.kpi?.orgao_contratante;
  const limpo = orgao && String(orgao).trim();
  return limpo ? `${nome} (${limpo})` : nome;
};

function ObraRow({ obra, onPress }) {
  const cor = obra.kpi?.status_cor || 'green';
  const st = obraStatus[cor] || obraStatus.green;
  const perc = Math.round(obra.kpi?.percentual_conclusao || 0);
  const dias = obra.kpi?.dias_restantes_estimados;
  const maquinas = obra.kpi?.maquinas_ativas || 0;

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress}>
      <Card style={{ gap: 8 }}>
        <View style={s.obraTop}>
          <Text style={s.obraNome} numberOfLines={2}>{formatObraNome(obra)}</Text>
          <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
        </View>

        <View style={s.bar}>
          <View style={[s.barFill, { width: `${Math.min(perc, 100)}%`, backgroundColor: st.dot }]} />
        </View>

        <View style={s.obraMeta}>
          <Text style={s.metaItem}>
            <Icon name="check-circle-outline" size={12} color={colors.fg4} /> {perc}% concluído
          </Text>
          <Text style={s.metaItem}>
            <Icon name="truck" size={12} color={colors.fg4} /> {maquinas} máq.
          </Text>
          {!obra.kpi?.is_hidden && dias > 0 ? (
            <Text style={[s.metaItem, dias < 15 ? { color: colors.danger, fontWeight: '600' } : null]}>
              <Icon name="calendar-clock" size={12} /> {dias}d restantes
            </Text>
          ) : null}
        </View>
      </Card>
    </TouchableOpacity>
  );
}

export default function SupervisorHomeScreen({ navigation }) {
  const { user, role } = useAuth();
  const [obras, setObras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const data = await api.getSupervisorDashboard().catch(() => []);
    const lista = (Array.isArray(data) ? data : []).filter(
      (o) => (o.kpi?.tipo_registro || 'obra') !== 'centro_custo'
    );
    setObras(lista);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const kpis = useMemo(() => {
    let horas = 0, somaPerc = 0, criticas = 0;
    obras.forEach((o) => {
      horas += Number(o.kpi?.horas_contratadas || 0);
      somaPerc += Number(o.kpi?.percentual_conclusao || 0);
      if (o.kpi?.status_cor === 'red' || o.kpi?.status_cor === 'violet') criticas++;
    });
    return {
      total: obras.length,
      horas: Math.round(horas),
      media: obras.length ? Math.round(somaPerc / obras.length) : 0,
      criticas,
    };
  }, [obras]);

  const filtradas = useMemo(() => {
    const norm = (x) => (x || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const q = norm(search);
    const lista = q
      ? obras.filter((o) => norm(formatObraNome(o)).includes(q) || norm(o.responsavel).includes(q))
      : obras;
    return [...lista].sort(
      (a, b) =>
        (STATUS_ORDER[a.kpi?.status_cor] ?? 9) - (STATUS_ORDER[b.kpi?.status_cor] ?? 9) ||
        (b.kpi?.percentual_conclusao || 0) - (a.kpi?.percentual_conclusao || 0)
    );
  }, [obras, search]);

  const criticas = filtradas.filter((o) => ['red', 'violet'].includes(o.kpi?.status_cor));
  const demais = filtradas.filter((o) => !['red', 'violet'].includes(o.kpi?.status_cor));

  const goto = (obra) =>
    navigation.navigate('DetalheObra', { id: obra.id, nome: formatObraNome(obra) });

  if (loading) return <Loading />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View>
        <Text style={s.title}>Gestão de obras</Text>
        <Text style={s.subtitle}>{user?.name} · {role}</Text>
      </View>

      <View style={s.kpiRow}>
        <KpiCard value={String(kpis.total)} label="Obras ativas" />
        <KpiCard
          value={String(kpis.criticas)}
          label="Críticas"
          color={kpis.criticas ? colors.danger : undefined}
        />
      </View>
      <View style={s.kpiRow}>
        <KpiCard value={`${kpis.media}%`} label="Conclusão média" />
        <KpiCard value={`${kpis.horas.toLocaleString('pt-BR')}h`} label="Horas contratadas" />
      </View>

      <View style={s.searchBox}>
        <Icon name="magnify" size={18} color={colors.fg4} />
        <TextInput
          style={s.searchInput}
          placeholder="Buscar obra ou responsável..."
          placeholderTextColor={colors.fg5}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Icon name="close-circle" size={18} color={colors.fg4} />
          </TouchableOpacity>
        ) : null}
      </View>

      {filtradas.length === 0 ? (
        <EmptyState
          icon="office-building-outline"
          title={obras.length === 0 ? 'Nenhuma obra ativa' : 'Nenhuma obra encontrada'}
          subtitle={obras.length === 0 ? 'As obras ativas aparecem aqui.' : 'Tente outro termo de busca.'}
        />
      ) : (
        <>
          {criticas.length > 0 && (
            <>
              <SectionTitle>Críticas / atenção · {criticas.length}</SectionTitle>
              {criticas.map((o) => <ObraRow key={o.id} obra={o} onPress={() => goto(o)} />)}
            </>
          )}
          {demais.length > 0 && (
            <>
              <SectionTitle>Demais obras · {demais.length}</SectionTitle>
              {demais.map((o) => <ObraRow key={o.id} obra={o} onPress={() => goto(o)} />)}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 20, fontWeight: '700', color: colors.fg1 },
  subtitle: { fontSize: 12, color: colors.fg3, textTransform: 'capitalize' },
  kpiRow: { flexDirection: 'row', gap: spacing[2] },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, paddingHorizontal: spacing[3], height: 44,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.fg1, padding: 0 },
  obraTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  obraNome: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg1 },
  bar: { height: 6, borderRadius: radius.full, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radius.full },
  obraMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metaItem: { fontSize: 12, color: colors.fg3 },
});
