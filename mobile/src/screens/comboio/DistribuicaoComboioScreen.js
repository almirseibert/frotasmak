// Distribuição (saída) do comboio — wizard em 2 etapas, espelha
// ComboioDistribuicaoModal do web. Multipart para POST /comboioTransactions/saida.
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Image, Alert, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import SelectModal from '../../components/SelectModal';
import { Card, PrimaryButton, SectionTitle } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

const FUEL_LABELS = { dieselS10: 'Diesel S10', dieselComum: 'Diesel Comum' };
const parseFuelLevels = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};
const today = () => new Date().toISOString().split('T')[0];

// Captura de foto (câmera). Retorna asset via setter.
const pickFoto = async (onPick) => {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('Câmera', 'Permita o acesso à câmera para registrar a foto.');
    return;
  }
  const r = await ImagePicker.launchCameraAsync({ quality: 0.6 });
  if (!r.canceled && r.assets?.length) onPick(r.assets[0]);
};

function PhotoTile({ label, hint, foto, onPress }) {
  return (
    <TouchableOpacity style={[s.photo, foto && s.photoOk]} activeOpacity={0.8} onPress={onPress}>
      {foto ? (
        <Image source={{ uri: foto.uri }} style={s.photoPreview} />
      ) : (
        <>
          <Icon name="camera-plus" size={26} color={colors.amber} />
          <Text style={s.photoLabel}>{label}</Text>
          {hint ? <Text style={s.photoHint}>{hint}</Text> : null}
        </>
      )}
    </TouchableOpacity>
  );
}

export default function DistribuicaoComboioScreen({ route, navigation }) {
  const { comboioId } = route.params || {};
  const { user } = useAuth();

  const [step, setStep] = useState(1);
  const [vehicles, setVehicles] = useState([]);
  const [obras, setObras] = useState([]);
  const [employees, setEmployees] = useState([]);

  const [veiculo, setVeiculo] = useState(null);
  const [obra, setObra] = useState(null);
  const [funcionario, setFuncionario] = useState(null);
  const [combustivel, setCombustivel] = useState('');
  const [odometro, setOdometro] = useState('');
  const [horimetro, setHorimetro] = useState('');
  const [litragem, setLitragem] = useState('');
  const [fotos, setFotos] = useState({ horimetro: null, re: null, medidorZerado: null, litragem: null });

  const [modal, setModal] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [v, o, e] = await Promise.all([
        api.getVehicles().catch(() => []),
        api.getObras().catch(() => []),
        api.getEmployees().catch(() => []),
      ]);
      setVehicles(Array.isArray(v) ? v : []);
      setObras(Array.isArray(o) ? o : []);
      setEmployees((Array.isArray(e) ? e : []).filter((x) => (x.status || '').toLowerCase() === 'ativo'));
    })();
  }, []);

  const comboio = useMemo(() => vehicles.find((v) => v.id === comboioId) || null, [vehicles, comboioId]);
  const fuelLevels = parseFuelLevels(comboio?.fuelLevels);
  const availableFuels = useMemo(
    () => Object.entries(fuelLevels).filter(([, l]) => Number(l) > 0),
    [fuelLevels]
  );
  const stock = Number(fuelLevels[combustivel]) || 0;

  const vehicleItems = useMemo(
    () => vehicles
      .filter((v) => !v.isComboioVehicle && v.id !== comboioId && !['Inativo', 'Sucata'].includes(v.status))
      .map((v) => ({ ...v, _label: `${v.registroInterno || v.placa || '—'}`, _sub: [v.modelo, v.placa].filter(Boolean).join(' · ') })),
    [vehicles, comboioId]
  );
  const obraItems = useMemo(
    () => obras.filter((o) => (o.status || 'ativa') === 'ativa').map((o) => ({ ...o, _label: o.nome || `Obra ${o.id}` })),
    [obras]
  );
  const employeeItems = useMemo(
    () => employees.map((e) => ({ ...e, _label: e.nome, _sub: e.profissao || e.registroInterno })),
    [employees]
  );

  // Auto-preenche obra/combustível ao escolher o veículo (sugestões editáveis).
  useEffect(() => {
    if (!veiculo) return;
    setObra((prev) => prev || obras.find((o) => o.id === veiculo.obraAtualId) || null);
    setCombustivel((prev) => prev || (availableFuels.length === 1 ? availableFuels[0][0] : ''));
  }, [veiculo]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFoto = useCallback((key) => (asset) => setFotos((p) => ({ ...p, [key]: asset })), []);

  const canStart =
    veiculo && obra && funcionario && combustivel &&
    (odometro || horimetro) &&
    fotos.horimetro && fotos.re && fotos.medidorZerado;

  const handleStart = () => {
    if (!veiculo || !obra || !funcionario || !combustivel) return Alert.alert('Atenção', 'Preencha veículo, obra, funcionário e combustível.');
    if (!odometro && !horimetro) return Alert.alert('Atenção', 'Informe o odômetro ou o horímetro atual.');
    if (!fotos.horimetro || !fotos.re || !fotos.medidorZerado) return Alert.alert('Atenção', 'Tire as 3 fotos exigidas antes de iniciar.');
    setStep(2);
  };

  const handleFinish = async () => {
    const liters = parseFloat(String(litragem).replace(',', '.'));
    if (!liters || liters <= 0) return Alert.alert('Atenção', 'Informe a litragem abastecida.');
    if (!fotos.litragem) return Alert.alert('Atenção', 'Tire a foto do medidor com a litragem.');
    if (liters > stock) return Alert.alert('Saldo insuficiente', `Disponível no comboio: ${stock.toFixed(1)} L.`);

    setSending(true);
    try {
      const fd = new FormData();
      fd.append('comboioVehicleId', String(comboioId));
      fd.append('receivingVehicleId', String(veiculo.id));
      fd.append('obraId', String(obra.id));
      fd.append('employeeId', String(funcionario.id));
      fd.append('fuelType', combustivel);
      fd.append('liters', String(liters));
      fd.append('date', new Date(today() + 'T12:00:00Z').toISOString());
      fd.append('odometro', odometro ? odometro.replace(',', '.') : '0');
      fd.append('horimetro', horimetro ? horimetro.replace(',', '.') : '0');
      fd.append('createdBy', JSON.stringify({
        userId: user?.id,
        userEmail: user?.email || 'sistema@frotasmak.com',
        name: user?.name,
      }));
      fd.append('foto_horimetro', { uri: fotos.horimetro.uri, name: 'horimetro.jpg', type: 'image/jpeg' });
      fd.append('foto_re', { uri: fotos.re.uri, name: 're.jpg', type: 'image/jpeg' });
      fd.append('foto_medidor_zerado', { uri: fotos.medidorZerado.uri, name: 'medidor_zerado.jpg', type: 'image/jpeg' });
      fd.append('foto_litragem', { uri: fotos.litragem.uri, name: 'litragem.jpg', type: 'image/jpeg' });

      await api.criarComboioSaida(fd);
      Alert.alert('Registrado', 'Abastecimento registrado com sucesso.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Não foi possível registrar', e.message || 'Erro no servidor.');
    } finally {
      setSending(false);
    }
  };

  const Tile = ({ icon, label, value, sub, onPress }) => (
    <TouchableOpacity style={s.tile} activeOpacity={0.7} onPress={onPress}>
      <Icon name={icon} size={20} color={colors.amber} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.tileLabel}>{label}</Text>
        <Text style={[s.tileValue, !value && { color: colors.fg5 }]} numberOfLines={1}>{value || 'Selecionar…'}</Text>
        {sub ? <Text style={s.tileSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.fg4} />
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <View style={s.stepper}>
        {[1, 2].map((n) => (
          <View key={n} style={[s.step, n < step && s.stepDone, n === step && s.stepActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
        {step === 1 ? (
          <>
            <SectionTitle>Passo 1 · Dados e fotos iniciais</SectionTitle>
            <Tile icon="truck" label="Veículo a abastecer" value={veiculo?._label} sub={veiculo?._sub} onPress={() => setModal('veiculo')} />

            {veiculo && (
              <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.inputLabel}>Odômetro (km)</Text>
                  <TextInput
                    style={s.input} value={odometro} onChangeText={setOdometro}
                    keyboardType="decimal-pad"
                    placeholder={veiculo.odometro ? `Atual: ${veiculo.odometro}` : '—'}
                    placeholderTextColor={colors.fg5}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.inputLabel}>Horímetro (h)</Text>
                  <TextInput
                    style={s.input} value={horimetro} onChangeText={setHorimetro}
                    keyboardType="decimal-pad"
                    placeholder={veiculo.horimetro ? `Atual: ${veiculo.horimetro}` : '—'}
                    placeholderTextColor={colors.fg5}
                  />
                </View>
              </View>
            )}

            <Tile icon="account-hard-hat" label="Funcionário (operando)" value={funcionario?.nome} onPress={() => setModal('funcionario')} />
            <Tile icon="office-building" label="Obra (centro de custo)" value={obra?._label || obra?.nome} onPress={() => setModal('obra')} />

            <View>
              <Text style={s.inputLabel}>Combustível</Text>
              <View style={s.fuelGrid}>
                {availableFuels.length === 0 ? (
                  <Text style={s.noFuel}>Comboio sem saldo de combustível.</Text>
                ) : availableFuels.map(([type, level]) => (
                  <TouchableOpacity
                    key={type}
                    style={[s.fuelOpt, combustivel === type && s.fuelOptSel]}
                    onPress={() => setCombustivel(type)}
                  >
                    <Text style={[s.fuelOptText, combustivel === type && s.fuelOptTextSel]}>
                      {FUEL_LABELS[type] || type} ({Number(level).toFixed(0)} L)
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <SectionTitle>Fotos obrigatórias</SectionTitle>
            <PhotoTile label="Horímetro / odômetro" hint="Painel mostrando a leitura" foto={fotos.horimetro} onPress={() => pickFoto(setFoto('horimetro'))} />
            <PhotoTile label="RE ou placa" hint="Registro interno ou placa do veículo" foto={fotos.re} onPress={() => pickFoto(setFoto('re'))} />
            <PhotoTile label="Medidor zerado" hint="Bomba/medidor antes de iniciar" foto={fotos.medidorZerado} onPress={() => pickFoto(setFoto('medidorZerado'))} />
          </>
        ) : (
          <>
            <SectionTitle>Passo 2 · Litragem</SectionTitle>
            <Card style={{ gap: 6 }}>
              <View style={s.sumRow}><Text style={s.sumLabel}>Veículo</Text><Text style={s.sumValue}>{veiculo?._label}</Text></View>
              <View style={s.sumRow}><Text style={s.sumLabel}>Combustível</Text><Text style={s.sumValue}>{FUEL_LABELS[combustivel] || combustivel}</Text></View>
              <View style={s.sumRow}><Text style={s.sumLabel}>Disponível no comboio</Text><Text style={s.sumValue}>{stock.toFixed(1)} L</Text></View>
            </Card>

            <Card tone="warning">
              <Text style={s.hintText}>Abasteça o veículo agora. Em seguida fotografe o medidor e informe a litragem.</Text>
            </Card>

            <PhotoTile label="Medidor com a litragem" hint="Foto do medidor com os litros abastecidos" foto={fotos.litragem} onPress={() => pickFoto(setFoto('litragem'))} />

            <View>
              <Text style={s.inputLabel}>Litragem abastecida (L)</Text>
              <TextInput
                style={[s.input, s.litersInput]} value={litragem} onChangeText={setLitragem}
                keyboardType="decimal-pad" placeholder="0,00" placeholderTextColor={colors.fg5}
              />
            </View>
          </>
        )}
      </ScrollView>

      <View style={s.footer}>
        {step === 2 && (
          <PrimaryButton label="Voltar" variant="outline" style={{ flex: 1 }} onPress={() => setStep(1)} disabled={sending} />
        )}
        {step === 1 ? (
          <PrimaryButton label="Iniciar abastecimento" icon="arrow-right" style={{ flex: 2 }} onPress={handleStart} disabled={!canStart} />
        ) : (
          <PrimaryButton label="Finalizar" icon="check" style={{ flex: 2 }} onPress={handleFinish} loading={sending} />
        )}
      </View>

      <SelectModal
        visible={modal === 'veiculo'} title="Veículo a abastecer"
        items={vehicleItems} labelKey="_label" subLabelKey="_sub"
        onSelect={(item) => { setVeiculo(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
      <SelectModal
        visible={modal === 'funcionario'} title="Funcionário"
        items={employeeItems} labelKey="_label" subLabelKey="_sub"
        onSelect={(item) => { setFuncionario(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
      <SelectModal
        visible={modal === 'obra'} title="Obra"
        items={obraItems} labelKey="_label"
        onSelect={(item) => { setObra(item); setModal(null); }}
        onClose={() => setModal(null)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  stepper: {
    flexDirection: 'row', gap: 6, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
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

  inputLabel: { fontSize: 11, color: colors.fg4, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600', marginBottom: 4 },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: 11, fontSize: 15, color: colors.fg2,
  },
  litersInput: { fontSize: 24, fontWeight: '700', textAlign: 'center', color: colors.fg1 },

  fuelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  fuelOpt: {
    flexGrow: 1, paddingVertical: 11, paddingHorizontal: 10, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, alignItems: 'center',
  },
  fuelOptSel: { borderColor: colors.amber, backgroundColor: colors.warningBg },
  fuelOptText: { fontSize: 13, fontWeight: '500', color: colors.fg2 },
  fuelOptTextSel: { color: colors.fg1 },
  noFuel: { fontSize: 13, color: colors.danger },

  photo: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.fg5, borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    padding: spacing[4], minHeight: 120, overflow: 'hidden',
  },
  photoOk: { borderColor: colors.success, borderStyle: 'solid' },
  photoPreview: { width: '100%', height: 150, borderRadius: radius.md },
  photoLabel: { fontSize: 14, fontWeight: '600', color: colors.fg1, marginTop: 6 },
  photoHint: { fontSize: 11, color: colors.fg3, marginTop: 2 },

  sumRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sumLabel: { fontSize: 13, color: colors.fg3 },
  sumValue: { fontSize: 13, fontWeight: '600', color: colors.fg1 },
  hintText: { fontSize: 13, color: '#5a3a18', lineHeight: 18 },

  footer: {
    flexDirection: 'row', gap: spacing[2], padding: spacing[4],
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
});
