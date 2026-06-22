// Nova Solicitação — wizard em 3 etapas (espelha SolicitacaoAbastecimentoPage do web)
// Payload: multipart para POST /solicitacoes (campos do solicitacaoAppController)
import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, Switch,
  Image, Alert, StyleSheet,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import SelectModal from '../../components/SelectModal';
import { Card, PrimaryButton, SectionTitle } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

const COMBUSTIVEIS = [
  { id: 'dieselS10', label: 'Diesel S10' },
  { id: 'dieselS500', label: 'Diesel S500' },
  { id: 'gasolinaComum', label: 'Gasolina comum' },
  { id: 'gasolinaAditivada', label: 'Gasolina aditivada' },
  { id: 'etanol', label: 'Etanol' },
  { id: 'arla32', label: 'Arla 32' },
];

export default function NovaSolicitacaoScreen({ navigation }) {
  const [step, setStep] = useState(1);

  // Dados de apoio
  const [vehicles, setVehicles] = useState([]);
  const [obras, setObras] = useState([]);
  const [partners, setPartners] = useState([]);
  const [employees, setEmployees] = useState([]);

  // Seleções
  const [veiculo, setVeiculo] = useState(null);
  const [obra, setObra] = useState(null);
  const [posto, setPosto] = useState(null);
  const [condutor, setCondutor] = useState(null);
  const [combustivel, setCombustivel] = useState(null);
  const [tanqueCheio, setTanqueCheio] = useState(false);
  const [litragem, setLitragem] = useState('');
  const [odometro, setOdometro] = useState('');
  const [horimetro, setHorimetro] = useState('');
  const [observacao, setObservacao] = useState('');
  const [foto, setFoto] = useState(null);
  const [coords, setCoords] = useState(null);

  const [modal, setModal] = useState(null); // 'veiculo' | 'obra' | 'posto' | 'condutor'
  const [sending, setSending] = useState(false);
  const [fieldError, setFieldError] = useState(null); // { campo, mensagem }

  useEffect(() => {
    (async () => {
      const [v, o, p, e] = await Promise.all([
        api.getVehicles().catch(() => []),
        api.getObras().catch(() => []),
        api.getPartners().catch(() => []),
        api.getEmployees().catch(() => []),
      ]);
      setVehicles(
        (Array.isArray(v) ? v : []).filter(
          (x) => !['Inativo', 'Sucata'].includes(x.status)
        )
      );
      setObras(Array.isArray(o) ? o : []);
      setPartners(
        (Array.isArray(p) ? p : []).filter(
          (x) => x.status_operacional !== 'BLOQUEADO' && (!x.tipo_parceiro || x.tipo_parceiro === 'posto')
        )
      );
      setEmployees((Array.isArray(e) ? e : []).filter((x) => (x.status || '').toLowerCase() === 'ativo'));
    })();

    // GPS em paralelo, não bloqueia o fluxo
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch { /* segue sem GPS */ }
    })();
  }, []);

  const vehicleItems = useMemo(
    () => vehicles.map((v) => ({
      ...v,
      _label: `${v.placa || v.registroInterno || '—'}`,
      _sub: [v.tipo, v.marca].filter(Boolean).join(' · '),
    })),
    [vehicles]
  );
  const obraItems = useMemo(
    () => obras.map((o) => ({ ...o, _label: o.nome || o.descricao || `Obra ${o.id}` })),
    [obras]
  );
  const postoItems = useMemo(
    () => partners.map((p) => ({ ...p, _label: p.razaoSocial || p.nomeFantasia || `Posto ${p.id}` })),
    [partners]
  );
  const condutorItems = useMemo(
    () => employees.map((e) => ({ ...e, _label: e.nome, _sub: e.registroInterno })),
    [employees]
  );

  const isTerceiro = veiculo && (veiculo.isOutsourced == 1 || veiculo.is_terceiro == 1);

  const tirarFoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Câmera', 'Permita o acesso à câmera para fotografar o painel.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (!result.canceled && result.assets?.length) setFoto(result.assets[0]);
  };

  const validarEtapa = () => {
    if (step === 1) {
      if (!veiculo) return 'Selecione o veículo.';
      if (!obra) return 'Selecione a obra.';
      if (!condutor) return 'Selecione o condutor/responsável.';
    }
    if (step === 2) {
      if (!posto) return 'Selecione o posto.';
      if (!combustivel) return 'Selecione o combustível.';
      if (!tanqueCheio && (!litragem || parseFloat(litragem.replace(',', '.')) <= 0)) {
        return "Informe a litragem ou marque 'Tanque cheio'.";
      }
    }
    if (step === 3) {
      if (!odometro && !horimetro) return 'Informe odômetro ou horímetro.';
      if (!foto) return 'A foto do painel é obrigatória.';
    }
    return null;
  };

  const avancar = () => {
    const erro = validarEtapa();
    if (erro) {
      Alert.alert('Atenção', erro);
      return;
    }
    if (step < 3) setStep(step + 1);
    else enviar();
  };

  const enviar = async () => {
    setSending(true);
    setFieldError(null);
    try {
      const fd = new FormData();
      fd.append('veiculo_id', String(veiculo.id));
      fd.append('obra_id', String(obra.id));
      fd.append('posto_id', String(posto.id));
      fd.append('funcionario_id', String(condutor.id));
      fd.append('tipo_combustivel', combustivel.id);
      fd.append('flag_tanque_cheio', tanqueCheio ? '1' : '0');
      fd.append('flag_outros', '0');
      fd.append('litragem', tanqueCheio ? '0' : litragem.replace(',', '.'));
      fd.append('odometro', odometro ? odometro.replace(',', '.') : '0');
      fd.append('horimetro', horimetro ? horimetro.replace(',', '.') : '0');
      fd.append('latitude', coords ? String(coords.latitude) : '0');
      fd.append('longitude', coords ? String(coords.longitude) : '0');
      fd.append('observacao', observacao || '');
      fd.append('foto_painel', {
        uri: foto.uri,
        name: 'painel.jpg',
        type: 'image/jpeg',
      });

      await api.criarSolicitacao(fd);
      Alert.alert('Enviado', 'Solicitação criada. Aguarde a liberação do administrador.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      // Backend devolve { campo, tipo, valor_informado, valor_anterior }
      if (e.data?.campo) {
        setFieldError({ campo: e.data.campo, mensagem: e.message });
        if (['odometro', 'horimetro'].includes(e.data.campo)) setStep(3);
      } else {
        Alert.alert('Não foi possível enviar', e.message || 'Erro no servidor.');
      }
    } finally {
      setSending(false);
    }
  };

  const SelectorTile = ({ icon, label, value, sub, onPress, error }) => (
    <TouchableOpacity
      style={[s.tile, error && { borderColor: colors.danger }]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      <Icon name={icon} size={20} color={colors.amber} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.tileLabel}>{label}</Text>
        <Text style={[s.tileValue, !value && { color: colors.fg5 }]} numberOfLines={1}>
          {value || 'Selecionar…'}
        </Text>
        {sub ? <Text style={s.tileSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.fg4} />
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <View style={s.stepper}>
        {[1, 2, 3].map((n) => (
          <View
            key={n}
            style={[s.step, n < step && s.stepDone, n === step && s.stepActive]}
          />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
        {step === 1 && (
          <>
            <SectionTitle>Etapa 1 · Veículo e obra</SectionTitle>
            <SelectorTile
              icon="truck" label="Veículo"
              value={veiculo?._label || (veiculo ? veiculo.placa : null)}
              sub={veiculo ? [veiculo.tipo, isTerceiro ? 'terceiro — sem travas de leitura' : null].filter(Boolean).join(' · ') : null}
              onPress={() => setModal('veiculo')}
            />
            <SelectorTile
              icon="office-building" label="Obra"
              value={obra?._label || obra?.nome}
              onPress={() => setModal('obra')}
            />
            <SelectorTile
              icon="account" label="Condutor / responsável"
              value={condutor?.nome}
              onPress={() => setModal('condutor')}
            />
          </>
        )}

        {step === 2 && (
          <>
            <SectionTitle>Etapa 2 · Combustível</SectionTitle>
            <SelectorTile
              icon="store" label="Posto"
              value={posto?._label || posto?.razaoSocial}
              onPress={() => setModal('posto')}
            />
            <View style={s.fuelGrid}>
              {COMBUSTIVEIS.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[s.fuelOpt, combustivel?.id === c.id && s.fuelOptSel]}
                  onPress={() => setCombustivel(c)}
                >
                  <Text style={[s.fuelOptText, combustivel?.id === c.id && s.fuelOptTextSel]}>
                    {c.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Card>
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Tanque cheio</Text>
                <Switch
                  value={tanqueCheio}
                  onValueChange={setTanqueCheio}
                  trackColor={{ true: colors.amber }}
                />
              </View>
              {!tanqueCheio && (
                <View style={{ marginTop: spacing[2] }}>
                  <Text style={s.inputLabel}>Litragem (L)</Text>
                  <TextInput
                    style={s.input}
                    value={litragem}
                    onChangeText={setLitragem}
                    keyboardType="decimal-pad"
                    placeholder="180"
                    placeholderTextColor={colors.fg5}
                  />
                </View>
              )}
            </Card>
          </>
        )}

        {step === 3 && (
          <>
            <SectionTitle>Etapa 3 · Leitura e evidência</SectionTitle>

            {fieldError ? (
              <Card tone="warning">
                <Text style={s.fieldErrorTitle}>Revise a leitura</Text>
                <Text style={s.fieldErrorMsg}>{fieldError.mensagem}</Text>
              </Card>
            ) : null}

            <View style={{ flexDirection: 'row', gap: spacing[2] }}>
              <View style={{ flex: 1 }}>
                <Text style={s.inputLabel}>Odômetro (km)</Text>
                <TextInput
                  style={[s.input, fieldError?.campo === 'odometro' && s.inputError]}
                  value={odometro}
                  onChangeText={setOdometro}
                  keyboardType="decimal-pad"
                  placeholder={veiculo?.odometro ? `Atual: ${veiculo.odometro}` : '—'}
                  placeholderTextColor={colors.fg5}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.inputLabel}>Horímetro (h)</Text>
                <TextInput
                  style={[s.input, fieldError?.campo === 'horimetro' && s.inputError]}
                  value={horimetro}
                  onChangeText={setHorimetro}
                  keyboardType="decimal-pad"
                  placeholder={veiculo?.horimetro ? `Atual: ${veiculo.horimetro}` : '—'}
                  placeholderTextColor={colors.fg5}
                />
              </View>
            </View>

            <TouchableOpacity style={s.photoFrame} activeOpacity={0.8} onPress={tirarFoto}>
              {foto ? (
                <Image source={{ uri: foto.uri }} style={s.photoPreview} />
              ) : (
                <>
                  <Icon name="camera-plus" size={32} color={colors.amber} />
                  <Text style={s.photoTitle}>Tirar foto do painel</Text>
                  <Text style={s.photoSub}>Leitura nítida do odômetro/horímetro</Text>
                </>
              )}
            </TouchableOpacity>
            {foto ? (
              <PrimaryButton label="Refazer foto" icon="camera-retake" variant="outline" onPress={tirarFoto} />
            ) : null}

            <View>
              <Text style={s.inputLabel}>Observação (opcional)</Text>
              <TextInput
                style={[s.input, { minHeight: 70, textAlignVertical: 'top' }]}
                value={observacao}
                onChangeText={setObservacao}
                multiline
                placeholder="Alguma informação extra…"
                placeholderTextColor={colors.fg5}
              />
            </View>

            <Text style={s.gpsHint}>
              <Icon name="map-marker" size={12} color={coords ? colors.success : colors.fg4} />{' '}
              {coords ? 'Localização capturada' : 'Sem GPS — enviando sem localização'}
            </Text>
          </>
        )}
      </ScrollView>

      <View style={s.footer}>
        {step > 1 && (
          <PrimaryButton
            label="Voltar" variant="outline"
            style={{ flex: 1 }}
            onPress={() => setStep(step - 1)}
            disabled={sending}
          />
        )}
        <PrimaryButton
          label={step < 3 ? 'Continuar' : 'Enviar solicitação'}
          icon={step < 3 ? 'arrow-right' : 'send'}
          style={{ flex: 2 }}
          onPress={avancar}
          loading={sending}
        />
      </View>

      <SelectModal
        visible={modal === 'veiculo'} title="Selecionar veículo"
        items={vehicleItems} labelKey="_label" subLabelKey="_sub"
        onSelect={(item) => { setVeiculo(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
      <SelectModal
        visible={modal === 'obra'} title="Selecionar obra"
        items={obraItems} labelKey="_label"
        onSelect={(item) => { setObra(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
      <SelectModal
        visible={modal === 'posto'} title="Selecionar posto"
        items={postoItems} labelKey="_label"
        onSelect={(item) => { setPosto(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
      <SelectModal
        visible={modal === 'condutor'} title="Condutor / responsável"
        items={condutorItems} labelKey="_label" subLabelKey="_sub"
        onSelect={(item) => { setCondutor(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  stepper: {
    flexDirection: 'row', gap: 6, paddingHorizontal: spacing[4],
    paddingVertical: spacing[3], backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  step: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  stepActive: { backgroundColor: colors.amber },
  stepDone: { backgroundColor: colors.success },

  tile: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  tileLabel: { fontSize: 10, color: colors.fg4, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  tileValue: { fontSize: 14, fontWeight: '500', color: colors.fg1, marginTop: 1 },
  tileSub: { fontSize: 11, color: colors.fg3, marginTop: 1 },

  fuelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  fuelOpt: {
    minWidth: '30%', flexGrow: 1, paddingVertical: 10, paddingHorizontal: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, alignItems: 'center',
  },
  fuelOptSel: { borderColor: colors.amber, backgroundColor: colors.warningBg },
  fuelOptText: { fontSize: 12.5, fontWeight: '500', color: colors.fg2 },
  fuelOptTextSel: { color: colors.fg1 },

  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  switchLabel: { fontSize: 14, fontWeight: '500', color: colors.fg1 },

  inputLabel: {
    fontSize: 11, color: colors.fg4, textTransform: 'uppercase',
    letterSpacing: 0.5, fontWeight: '600', marginBottom: 4,
  },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: 11,
    fontSize: 15, color: colors.fg2,
  },
  inputError: { borderColor: colors.danger },

  fieldErrorTitle: { fontSize: 13, fontWeight: '600', color: '#5a3a18' },
  fieldErrorMsg: { fontSize: 12, color: colors.fg3, marginTop: 2, lineHeight: 17 },

  photoFrame: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.fg5,
    borderRadius: radius.lg, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center', padding: spacing[5],
    minHeight: 140, overflow: 'hidden',
  },
  photoPreview: { width: '100%', height: 180, borderRadius: radius.md },
  photoTitle: { fontSize: 14, fontWeight: '600', color: colors.fg1, marginTop: 6 },
  photoSub: { fontSize: 11, color: colors.fg3, marginTop: 2 },

  gpsHint: { fontSize: 11, color: colors.fg4, textAlign: 'center' },

  footer: {
    flexDirection: 'row', gap: spacing[2], padding: spacing[4],
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
});
