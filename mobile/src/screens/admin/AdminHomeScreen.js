import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { KpiCard, Card, SectionTitle } from '../../components/ui';
import { colors, spacing } from '../../theme/tokens';

export default function AdminHomeScreen({ navigation }) {
  const { user, role } = useAuth();
  const [vehicles, setVehicles] = useState([]);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [cadastros, setCadastros] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const isAdmin = role === 'admin';

  const load = useCallback(async () => {
    const [v, sol, reg] = await Promise.all([
      api.getVehicles().catch(() => []),
      api.getMinhasSolicitacoes().catch(() => []),
      isAdmin ? api.getRegistrationRequests().catch(() => []) : Promise.resolve([]),
    ]);
    setVehicles(Array.isArray(v) ? v : []);
    setSolicitacoes(Array.isArray(sol) ? sol : []);
    setCadastros(Array.isArray(reg) ? reg : []);
  }, [isAdmin]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const frotaAtiva = vehicles.filter(
    (v) => !['Inativo', 'Sucata'].includes(v.status) && !v.isOutsourced && !v.is_terceiro
  ).length;
  const emManutencao = vehicles.filter((v) => v.status === 'Manutenção').length;
  const pendentes = solicitacoes.filter((s) => s.status === 'PENDENTE');
  const aguardandoBaixa = solicitacoes.filter((s) => s.status === 'AGUARDANDO_BAIXA');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={s.header}>
        <View>
          <Text style={s.title}>Painel geral</Text>
          <Text style={s.subtitle}>{user?.name} · {role}</Text>
        </View>
      </View>

      <View style={s.kpiRow}>
        <KpiCard value={String(frotaAtiva)} label="Frota ativa" />
        <KpiCard value={String(emManutencao)} label="Manutenção" color={emManutencao ? colors.danger : undefined} />
      </View>
      <View style={s.kpiRow}>
        <KpiCard value={String(pendentes.length)} label="Solicitações pendentes" color={pendentes.length ? colors.amber : undefined} />
        <KpiCard value={String(aguardandoBaixa.length)} label="Aguardando baixa" />
      </View>

      {(pendentes.length > 0 || cadastros.length > 0) && (
        <>
          <SectionTitle>Exige sua ação</SectionTitle>

          {pendentes.length > 0 && (
            <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('Solicitacoes')}>
              <Card tone="warning">
                <View style={s.actionRow}>
                  <Icon name="gas-station" size={18} color={colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.actionTitle}>
                      {pendentes.length} solicitaç{pendentes.length === 1 ? 'ão' : 'ões'} pendente{pendentes.length === 1 ? '' : 's'}
                    </Text>
                    <Text style={s.actionSub} numberOfLines={1}>
                      {pendentes.slice(0, 3).map((p) => p.placa || `#${p.id}`).join(', ')}
                    </Text>
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.warning} />
                </View>
              </Card>
            </TouchableOpacity>
          )}

          {cadastros.length > 0 && (
            <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('CadastrosPendentes')}>
              <Card tone="warning">
                <View style={s.actionRow}>
                  <Icon name="account-plus" size={18} color={colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.actionTitle}>
                      {cadastros.length} cadastro{cadastros.length === 1 ? '' : 's'} aguardando aprovação
                    </Text>
                    <Text style={s.actionSub} numberOfLines={1}>
                      {cadastros.slice(0, 3).map((c) => c.name || c.email).join(', ')}
                    </Text>
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.warning} />
                </View>
              </Card>
            </TouchableOpacity>
          )}
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: colors.fg1 },
  subtitle: { fontSize: 12, color: colors.fg3, textTransform: 'capitalize' },
  kpiRow: { flexDirection: 'row', gap: spacing[2] },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actionTitle: { fontSize: 14, fontWeight: '600', color: '#5a3a18' },
  actionSub: { fontSize: 12, color: colors.fg3, marginTop: 1 },
});
