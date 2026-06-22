// Análise de solicitação (admin) — foto do painel, leitura informada × atual,
// localização e ações Liberar/Negar. Usado a partir da FilaSolicitacoes.
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Image, Alert, StyleSheet, Linking, TouchableOpacity,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api, { getBaseUrl } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Card, Pill, PrimaryButton, SectionTitle, Loading } from '../../components/ui';
import { colors, radius, spacing, solicitacaoStatus } from '../../theme/tokens';

export default function AnaliseSolicitacaoScreen({ route, navigation }) {
  const { solicitacao: initial, id } = route.params || {};
  const { user } = useAuth();
  const [sol, setSol] = useState(initial || null);
  const [veiculo, setVeiculo] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!initial && id) {
        const rows = await api.getMinhasSolicitacoes();
        const found = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(id));
        if (found) setSol(found);
      }
    } catch { /* mantém */ }
  }, [initial, id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      if (sol?.veiculo_id) {
        try {
          const v = await api.getVehicle(sol.veiculo_id);
          setVeiculo(v);
        } catch { /* sem dados do veículo */ }
      }
    })();
  }, [sol?.veiculo_id]);

  if (!sol) return <Loading />;

  const st = solicitacaoStatus[sol.status] || solicitacaoStatus.PENDENTE;
  const fotoPainelUrl = sol.foto_painel_path ? `${getBaseUrl()}${sol.foto_painel_path}` : null;
  const fotoCupomUrl = sol.foto_cupom_path ? `${getBaseUrl()}${sol.foto_cupom_path}` : null;

  const odoInformado = parseFloat(sol.odometro_informado) || 0;
  const horiInformado = parseFloat(sol.horimetro_informado) || 0;
  const odoAtual = parseFloat(veiculo?.odometro) || 0;
  const horiAtual = parseFloat(veiculo?.horimetro) || 0;

  const saltoOdo = odoInformado > 0 && odoAtual > 0 ? odoInformado - odoAtual : null;
  const saltoHori = horiInformado > 0 && horiAtual > 0 ? horiInformado - horiAtual : null;
  const isTerceiro = veiculo && (veiculo.isOutsourced == 1 || veiculo.is_terceiro == 1);
  const alertaLeitura = !isTerceiro && (
    (saltoOdo !== null && (saltoOdo < 0 || saltoOdo > 1000)) ||
    (saltoHori !== null && (saltoHori < 0 || saltoHori > 50))
  );

  const temGps = sol.geo_latitude && sol.geo_longitude
    && Number(sol.geo_latitude) !== 0 && Number(sol.geo_longitude) !== 0;

  const avaliar = (aprovado) => {
    const acao = aprovado ? 'Liberar' : 'Negar';
    Alert.alert(`${acao} #${sol.id}`, `${sol.placa || 'Veículo'} · ${sol.tipo_combustivel || ''}`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: acao,
        style: aprovado ? 'default' : 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.avaliarSolicitacao(sol.id, {
              aprovado,
              avaliado_por: { id: user?.id, name: user?.name },
            });
            navigation.goBack();
          } catch (e) {
            Alert.alert('Erro', e.message || 'Não foi possível avaliar.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const LeituraCard = ({ label, informado, atual, salto, limite, unidade }) => (
    <View style={[s.leituraCard, salto !== null && (salto < 0 || salto > limite) && s.leituraCardAlert]}>
      <Text style={s.leituraLabel}>{label}</Text>
      <Text style={s.leituraValor}>
        {informado > 0 ? `${informado.toLocaleString('pt-BR')} ${unidade}` : '—'}
      </Text>
      {atual > 0 ? (
        <Text style={s.leituraAtual}>atual: {atual.toLocaleString('pt-BR')} {unidade}</Text>
      ) : null}
      {salto !== null ? (
        <Text style={[s.leituraSalto, (salto < 0 || salto > limite) && { color: colors.danger }]}>
          {salto >= 0 ? '+' : ''}{salto.toLocaleString('pt-BR')} {unidade}
          {salto > limite ? ` (>${limite})` : salto < 0 ? ' (regressão)' : ''}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <ScrollView contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
        <View style={s.head}>
          <Text style={s.num}>#{sol.id}</Text>
          <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
        </View>
        <Text style={s.sub}>
          {sol.placa || sol.veiculo_nome || 'Veículo'} · {sol.solicitante_nome || '—'}
          {sol.obra_nome ? ` · ${sol.obra_nome}` : ''}
        </Text>

        {isTerceiro ? (
          <Card style={{ borderColor: '#e9d5ff', backgroundColor: '#faf5ff' }}>
            <Text style={[s.alertTitle, { color: '#6b21a8' }]}>Veículo terceirizado</Text>
            <Text style={s.alertSub}>Sem travas de leitura/orçamento — só registra consumo.</Text>
          </Card>
        ) : alertaLeitura ? (
          <Card tone="warning">
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Icon name="alert" size={20} color={colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={s.alertTitle}>Leitura fora do padrão</Text>
                <Text style={s.alertSub}>Confira a foto do painel antes de liberar.</Text>
              </View>
            </View>
          </Card>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing[2] }}>
          <LeituraCard label="Odômetro" informado={odoInformado} atual={odoAtual} salto={saltoOdo} limite={1000} unidade="km" />
          <LeituraCard label="Horímetro" informado={horiInformado} atual={horiAtual} salto={saltoHori} limite={50} unidade="h" />
        </View>

        <Card>
          <SectionTitle>Pedido</SectionTitle>
          {[
            ['Combustível', sol.tipo_combustivel],
            ['Litragem', sol.flag_tanque_cheio ? 'Tanque cheio' : sol.litragem_solicitada ? `${sol.litragem_solicitada} L` : '—'],
            ['Posto', sol.posto_nome],
            ['Observação', sol.observacao],
          ]
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <View key={key} style={s.dataRow}>
                <Text style={s.dataKey}>{key}</Text>
                <Text style={s.dataVal} numberOfLines={2}>{String(value)}</Text>
              </View>
            ))}
        </Card>

        {temGps ? (
          <TouchableOpacity
            onPress={() => Linking.openURL(`https://maps.google.com/?q=${sol.geo_latitude},${sol.geo_longitude}`)}
            activeOpacity={0.7}
          >
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="map-marker" size={18} color={colors.amber} />
                <Text style={s.gpsText}>
                  Local do envio: {Number(sol.geo_latitude).toFixed(4)}, {Number(sol.geo_longitude).toFixed(4)}
                </Text>
                <Icon name="open-in-new" size={14} color={colors.fg4} />
              </View>
            </Card>
          </TouchableOpacity>
        ) : null}

        {fotoPainelUrl ? (
          <Card>
            <SectionTitle>Foto do painel</SectionTitle>
            <Image source={{ uri: fotoPainelUrl }} style={s.photo} resizeMode="contain" />
          </Card>
        ) : (
          <Card tone="warning">
            <Text style={s.alertSub}>Sem foto do painel anexada.</Text>
          </Card>
        )}

        {fotoCupomUrl ? (
          <Card>
            <SectionTitle>Cupom fiscal</SectionTitle>
            <Image source={{ uri: fotoCupomUrl }} style={s.photo} resizeMode="contain" />
          </Card>
        ) : null}
      </ScrollView>

      {sol.status === 'PENDENTE' && (
        <View style={s.footer}>
          <PrimaryButton
            label="Negar" icon="close" variant="danger"
            style={{ flex: 1 }} disabled={busy}
            onPress={() => avaliar(false)}
          />
          <PrimaryButton
            label="Liberar" icon="check"
            style={{ flex: 2 }} loading={busy}
            onPress={() => avaliar(true)}
          />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  num: { fontSize: 22, fontWeight: '700', color: colors.fg1, fontVariant: ['tabular-nums'] },
  sub: { fontSize: 13, color: colors.fg3, marginTop: -spacing[2] },

  alertTitle: { fontSize: 14, fontWeight: '600', color: '#5a3a18' },
  alertSub: { fontSize: 12, color: colors.fg3, marginTop: 2 },

  leituraCard: {
    flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: spacing[3],
  },
  leituraCardAlert: { borderColor: colors.dangerBorder, backgroundColor: colors.dangerBg },
  leituraLabel: { fontSize: 10, color: colors.fg4, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  leituraValor: { fontSize: 17, fontWeight: '700', color: colors.fg1, marginTop: 2, fontVariant: ['tabular-nums'] },
  leituraAtual: { fontSize: 11, color: colors.fg3, marginTop: 1 },
  leituraSalto: { fontSize: 12, fontWeight: '600', color: colors.success, marginTop: 2 },

  dataRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3],
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle,
  },
  dataKey: { fontSize: 13, color: colors.fg3 },
  dataVal: { fontSize: 13, color: colors.fg1, fontWeight: '500', flex: 1, textAlign: 'right' },

  gpsText: { flex: 1, fontSize: 13, color: colors.fg2 },
  photo: { width: '100%', height: 220, borderRadius: radius.md, marginTop: spacing[2], backgroundColor: colors.surfaceMuted },

  footer: {
    flexDirection: 'row', gap: spacing[2], padding: spacing[4],
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
});
