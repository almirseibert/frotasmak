// Detalhe da solicitação + envio de comprovante (cupom fiscal)
// PUT /solicitacoes/:id/comprovante (multipart foto_cupom)
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Image, Alert,
  RefreshControl, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api, { getBaseUrl } from '../../api/client';
import { Card, Pill, PrimaryButton, SectionTitle, Loading } from '../../components/ui';
import { colors, radius, spacing, solicitacaoStatus } from '../../theme/tokens';

export default function DetalheSolicitacaoScreen({ route, navigation }) {
  const { id } = route.params;
  const [sol, setSol] = useState(null);
  const [foto, setFoto] = useState(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api.getMinhasSolicitacoes();
      const found = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(id));
      if (found) setSol(found);
    } catch { /* mantém estado anterior */ }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const tirarFoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Câmera', 'Permita o acesso à câmera para fotografar o cupom.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (!result.canceled && result.assets?.length) setFoto(result.assets[0]);
  };

  const enviarComprovante = async () => {
    if (!foto) {
      Alert.alert('Atenção', 'Tire a foto do cupom fiscal antes de enviar.');
      return;
    }
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('foto_cupom', { uri: foto.uri, name: 'cupom.jpg', type: 'image/jpeg' });
      await api.enviarComprovante(id, fd);
      Alert.alert('Enviado', 'Comprovante enviado para validação do administrador.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Erro', e.message || 'Não foi possível enviar o comprovante.');
    } finally {
      setSending(false);
    }
  };

  if (!sol) return <Loading />;

  const st = solicitacaoStatus[sol.status] || solicitacaoStatus.PENDENTE;
  const quando = sol.data_solicitacao
    ? new Date(sol.data_solicitacao).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';
  const podeEnviarCupom = sol.status === 'LIBERADO';
  const fotoPainelUrl = sol.foto_painel_path ? `${getBaseUrl()}${sol.foto_painel_path}` : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={s.head}>
        <Text style={s.num}>#{sol.id}</Text>
        <Pill label={st.label} bg={st.bg} text={st.text} dot={st.dot} />
      </View>
      <Text style={s.when}>{quando}{sol.solicitante_nome ? ` · ${sol.solicitante_nome}` : ''}</Text>

      {sol.status === 'LIBERADO' && (
        <Card tone="success">
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Icon name="check-circle" size={22} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Liberado para abastecer</Text>
              <Text style={s.bannerSub}>
                Apresente este número no posto e envie o cupom em seguida.
              </Text>
            </View>
          </View>
        </Card>
      )}

      {sol.status === 'PENDENTE' && (
        <Card tone="warning">
          <Text style={s.bannerTitleWarn}>Aguardando liberação</Text>
          <Text style={s.bannerSub}>O administrador foi notificado da sua solicitação.</Text>
        </Card>
      )}

      <Card>
        <SectionTitle>Dados</SectionTitle>
        {[
          ['Veículo', sol.placa || sol.veiculo_nome],
          ['Obra', sol.obra_nome],
          ['Posto', sol.posto_nome],
          ['Combustível', sol.tipo_combustivel],
          ['Litragem', sol.flag_tanque_cheio ? 'Tanque cheio' : sol.litragem_solicitada ? `${sol.litragem_solicitada} L` : '—'],
          ['Odômetro', sol.odometro_informado ? `${sol.odometro_informado} km` : null],
          ['Horímetro', sol.horimetro_informado ? `${sol.horimetro_informado} h` : null],
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

      {fotoPainelUrl ? (
        <Card>
          <SectionTitle>Foto do painel</SectionTitle>
          <Image source={{ uri: fotoPainelUrl }} style={s.photoExisting} resizeMode="cover" />
        </Card>
      ) : null}

      {podeEnviarCupom && (
        <>
          <SectionTitle>Comprovante (cupom fiscal)</SectionTitle>
          <TouchableOpacity style={s.photoFrame} activeOpacity={0.8} onPress={tirarFoto}>
            {foto ? (
              <Image source={{ uri: foto.uri }} style={s.photoPreview} />
            ) : (
              <>
                <Icon name="camera-plus" size={32} color={colors.amber} />
                <Text style={s.photoTitle}>Tirar foto do cupom fiscal</Text>
                <Text style={s.photoSub}>Garanta CNPJ, valor e litros visíveis</Text>
              </>
            )}
          </TouchableOpacity>
          {foto ? (
            <PrimaryButton label="Refazer foto" icon="camera-retake" variant="outline" onPress={tirarFoto} />
          ) : null}
          <PrimaryButton
            label="Enviar comprovante"
            icon="upload"
            onPress={enviarComprovante}
            loading={sending}
            disabled={!foto}
          />
        </>
      )}

      {sol.status === 'AGUARDANDO_BAIXA' && (
        <Card tone="warning">
          <Text style={s.bannerTitleWarn}>Cupom em análise</Text>
          <Text style={s.bannerSub}>O administrador está validando o comprovante enviado.</Text>
        </Card>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  num: { fontSize: 22, fontWeight: '700', color: colors.fg1, fontVariant: ['tabular-nums'] },
  when: { fontSize: 12, color: colors.fg4, marginTop: -spacing[2] },

  bannerTitle: { fontSize: 14, fontWeight: '600', color: colors.success },
  bannerTitleWarn: { fontSize: 14, fontWeight: '600', color: '#5a3a18' },
  bannerSub: { fontSize: 12, color: colors.fg3, marginTop: 2, lineHeight: 17 },

  dataRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3],
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle,
  },
  dataKey: { fontSize: 13, color: colors.fg3 },
  dataVal: { fontSize: 13, color: colors.fg1, fontWeight: '500', flex: 1, textAlign: 'right' },

  photoExisting: { width: '100%', height: 160, borderRadius: radius.md, marginTop: spacing[2] },

  photoFrame: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.fg5,
    borderRadius: radius.lg, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center', padding: spacing[5],
    minHeight: 140, overflow: 'hidden',
  },
  photoPreview: { width: '100%', height: 180, borderRadius: radius.md },
  photoTitle: { fontSize: 14, fontWeight: '600', color: colors.fg1, marginTop: 6 },
  photoSub: { fontSize: 11, color: colors.fg3, marginTop: 2 },
});
