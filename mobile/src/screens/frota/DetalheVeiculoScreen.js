// Detalhe do veículo — leituras, dados cadastrais, alocação e últimas ordens
import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { Card, Pill, KpiCard, SectionTitle, Loading } from '../../components/ui';
import { colors, spacing, vehicleStatus, solicitacaoStatus } from '../../theme/tokens';

export default function DetalheVeiculoScreen({ route }) {
  const { id } = route.params;
  const [veiculo, setVeiculo] = useState(null);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, sols] = await Promise.all([
        api.getVehicle(id),
        api.getMinhasSolicitacoes().catch(() => []),
      ]);
      setVeiculo(v);
      setSolicitacoes(
        (Array.isArray(sols) ? sols : [])
          .filter((s) => String(s.veiculo_id) === String(id))
          .slice(0, 5)
      );
    } catch { /* mantém */ }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!veiculo) return <Loading />;

  const isTerceiro = veiculo.isOutsourced == 1 || veiculo.is_terceiro == 1;
  const st = isTerceiro
    ? vehicleStatus['Terceiro']
    : vehicleStatus[veiculo.status] || vehicleStatus['Disponível'];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={s.icon}>
            <Icon name="truck" size={26} color={isTerceiro ? '#a855f7' : colors.amber} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.placa}>{veiculo.placa || veiculo.registroInterno || '—'}</Text>
            <Text style={s.meta}>
              {[veiculo.tipo, veiculo.marca, veiculo.modelo].filter(Boolean).join(' · ')}
            </Text>
            <View style={{ marginTop: 4 }}>
              <Pill label={isTerceiro ? 'Terceiro' : (veiculo.status || '—')} bg={st.bg} text={st.text} dot={st.dot} />
            </View>
          </View>
        </View>
        {isTerceiro && (veiculo.nomeEmpresaTerceiro || veiculo.contratoTerceiro) ? (
          <View style={s.terceiroBox}>
            {veiculo.nomeEmpresaTerceiro ? (
              <Text style={s.terceiroText}>Empresa: {veiculo.nomeEmpresaTerceiro}</Text>
            ) : null}
            {veiculo.contratoTerceiro ? (
              <Text style={s.terceiroText}>Contrato: {veiculo.contratoTerceiro}</Text>
            ) : null}
          </View>
        ) : null}
      </Card>

      <View style={{ flexDirection: 'row', gap: spacing[2] }}>
        <KpiCard
          value={veiculo.odometro ? `${Number(veiculo.odometro).toLocaleString('pt-BR')}` : '—'}
          label="Odômetro (km)"
        />
        <KpiCard
          value={veiculo.horimetro ? `${Number(veiculo.horimetro).toLocaleString('pt-BR')}` : '—'}
          label="Horímetro (h)"
        />
      </View>

      <Card>
        <SectionTitle>Cadastro</SectionTitle>
        {[
          ['Registro interno', veiculo.registroInterno],
          ['Chassi', veiculo.chassi],
          ['Ano', veiculo.ano_fabricacao || veiculo.anoFabricacao],
          ['Cor', veiculo.cor],
          ['Rastreador', veiculo.rastreador],
          ['Média consumo', veiculo.media_consumo ? `${veiculo.media_consumo} km/L` : null],
          ['Capacidade tanque', veiculo.fuelCapacity ? `${veiculo.fuelCapacity} L` : null],
        ]
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <View key={key} style={s.dataRow}>
              <Text style={s.dataKey}>{key}</Text>
              <Text style={s.dataVal}>{String(value)}</Text>
            </View>
          ))}
      </Card>

      <SectionTitle>Últimas solicitações</SectionTitle>
      {solicitacoes.length === 0 ? (
        <Card>
          <Text style={s.emptyText}>Nenhuma solicitação recente deste veículo.</Text>
        </Card>
      ) : (
        solicitacoes.map((sol) => {
          const sst = solicitacaoStatus[sol.status] || solicitacaoStatus.PENDENTE;
          const quando = sol.data_solicitacao
            ? new Date(sol.data_solicitacao).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
            : '';
          return (
            <Card key={sol.id}>
              <View style={s.solHead}>
                <Text style={s.solNum}>#{sol.id}</Text>
                <Pill label={sst.label} bg={sst.bg} text={sst.text} dot={sst.dot} />
              </View>
              <Text style={s.meta}>
                {quando} · {sol.tipo_combustivel || '—'}
                {sol.flag_tanque_cheio ? ' · tanque cheio' : sol.litragem_solicitada ? ` · ${sol.litragem_solicitada} L` : ''}
              </Text>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  icon: {
    width: 52, height: 52, borderRadius: 14, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  placa: { fontSize: 19, fontWeight: '700', color: colors.fg1, letterSpacing: 0.5 },
  meta: { fontSize: 12, color: colors.fg3, marginTop: 1 },

  terceiroBox: {
    marginTop: spacing[3], paddingTop: spacing[2],
    borderTopWidth: 1, borderTopColor: colors.borderSubtle,
  },
  terceiroText: { fontSize: 12, color: colors.fg3 },

  dataRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3],
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle,
  },
  dataKey: { fontSize: 13, color: colors.fg3 },
  dataVal: { fontSize: 13, color: colors.fg1, fontWeight: '500' },

  solHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  solNum: { fontSize: 14, fontWeight: '600', color: colors.fg1, fontVariant: ['tabular-nums'] },
  emptyText: { fontSize: 13, color: colors.fg4, textAlign: 'center', paddingVertical: spacing[2] },
});
