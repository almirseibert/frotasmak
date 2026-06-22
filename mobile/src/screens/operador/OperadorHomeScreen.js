import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Card, Pill, SectionTitle, EmptyState, PrimaryButton } from '../../components/ui';
import { colors, spacing, solicitacaoStatus } from '../../theme/tokens';

const ABERTAS = ['PENDENTE', 'LIBERADO', 'AGUARDANDO_BAIXA'];

export default function OperadorHomeScreen({ navigation }) {
  const { user } = useAuth();
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [bloqueado, setBloqueado] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rows, status] = await Promise.all([
        api.getMinhasSolicitacoes(),
        api.getMeuStatus().catch(() => null),
      ]);
      setSolicitacoes(Array.isArray(rows) ? rows : []);
      setBloqueado(!!status?.bloqueado_abastecimento);
    } catch {
      // mantém dados anteriores; pull-to-refresh tenta de novo
    }
  }, []);

  useFocusEffect(
    useCallback(() => { load(); }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const minhasAbertas = solicitacoes.filter(
    (sol) => ABERTAS.includes(sol.status) && sol.usuario_id === user?.id
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={s.header}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>
            {(user?.name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.hello}>Olá, {(user?.name || '').split(' ')[0]}</Text>
          <Text style={s.role}>Operador</Text>
        </View>
      </View>

      {bloqueado ? (
        <Card tone="danger">
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Icon name="lock" size={20} color={colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={s.blockTitle}>Abastecimento bloqueado</Text>
              <Text style={s.blockSub}>Procure o administrador para liberar seu acesso.</Text>
            </View>
          </View>
        </Card>
      ) : (
        <PrimaryButton
          label="Nova solicitação"
          icon="gas-station"
          onPress={() => navigation.navigate('NovaSolicitacao')}
        />
      )}

      <SectionTitle>Em andamento · {minhasAbertas.length}</SectionTitle>

      {minhasAbertas.length === 0 ? (
        <EmptyState
          icon="gas-station-off"
          title="Nenhuma solicitação aberta"
          subtitle="Toque em Nova solicitação para pedir um abastecimento."
        />
      ) : (
        minhasAbertas.map((sol) => {
          const st = solicitacaoStatus[sol.status] || solicitacaoStatus.PENDENTE;
          return (
            <Card key={sol.id}>
              <View style={s.solHead}>
                <Text style={s.solNum}>#{sol.id}</Text>
                <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
              </View>
              <Text style={s.solMeta}>
                {sol.placa || sol.veiculo_nome || 'Veículo'} · {sol.tipo_combustivel || '—'}
                {sol.flag_tanque_cheio ? ' · tanque cheio' : sol.litragem_solicitada ? ` · ${sol.litragem_solicitada} L` : ''}
              </Text>
              {sol.posto_nome ? <Text style={s.solMeta}>{sol.posto_nome}</Text> : null}
              {sol.status === 'LIBERADO' ? (
                <Text
                  style={s.solAction}
                  onPress={() => navigation.navigate('DetalheSolicitacao', { id: sol.id })}
                >
                  Enviar comprovante →
                </Text>
              ) : null}
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing[1] },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: colors.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.fgInverse, fontSize: 16, fontWeight: '600' },
  hello: { fontSize: 18, fontWeight: '700', color: colors.fg1 },
  role: { fontSize: 12, color: colors.fg3 },

  blockTitle: { fontSize: 14, fontWeight: '600', color: colors.danger },
  blockSub: { fontSize: 12, color: colors.fg3, marginTop: 1 },

  solHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  solNum: { fontSize: 14, fontWeight: '600', color: colors.fg1, fontVariant: ['tabular-nums'] },
  solMeta: { fontSize: 12, color: colors.fg3, marginTop: 1 },
  solAction: {
    fontSize: 13, color: colors.amber, fontWeight: '600',
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderSubtle,
  },
});
