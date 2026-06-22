// Comboio mobile — tela do operador: níveis dos tanques, botão "Abastecer
// veículo" (distribuição/saída) e histórico. Espelha ComboioMobilePage do web.
// A entrada (carregar o comboio no posto) é feita pelo setor de frotas, não aqui.
import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import api from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useRealtime } from '../../realtime/SocketContext';
import SelectModal from '../../components/SelectModal';
import { Card, EmptyState, Loading, SectionTitle } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';

const FUEL_LABELS = { dieselS10: 'Diesel S10', dieselComum: 'Diesel Comum' };

const parseFuelLevels = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};

function FuelBar({ label, liters, capacity, color }) {
  const pct = capacity > 0 ? Math.min((liters / capacity) * 100, 100) : 0;
  return (
    <View style={{ marginBottom: spacing[2] }}>
      <View style={s.fuelTop}>
        <Text style={s.fuelLabel}>{label}</Text>
        <Text style={s.fuelValue}>
          {liters.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} / {capacity.toLocaleString('pt-BR')} L
        </Text>
      </View>
      <View style={s.fuelTrack}>
        <View style={[s.fuelFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const formatTxDate = (d) => {
  if (!d) return '';
  try {
    const dt = new Date(d);
    return `${dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return ''; }
};

export default function ComboioScreen({ navigation }) {
  const { user, role } = useAuth();
  const { syncTick } = useRealtime();
  const [vehicles, setVehicles] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [comboioId, setComboioId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [picker, setPicker] = useState(false);

  const isAdminLike = ['admin', 'gerencia', 'abastecimento', 'editor'].includes(role);

  const load = useCallback(async () => {
    const [v, txns, emps] = await Promise.all([
      api.getVehicles().catch(() => []),
      api.getComboioTransactions().catch(() => []),
      api.getEmployees().catch(() => []),
    ]);
    const veics = Array.isArray(v) ? v : [];
    setVehicles(veics);
    setTransactions(Array.isArray(txns) ? txns : []);

    // Auto-detecta o comboio vinculado ao operador (igual ao web):
    // employee.alocacaoAtual.description lista os registros internos alocados.
    const comboios = veics.filter((x) => x.isComboioVehicle);
    setComboioId((prev) => {
      if (prev && comboios.some((c) => c.id === prev)) return prev;
      const emp = (Array.isArray(emps) ? emps : []).find(
        (e) => e.id === user?.employeeId || e.nome === user?.name
      );
      const regs = emp?.alocacaoAtual?.isAllocated
        ? String(emp.alocacaoAtual.description || '').split(',').map((x) => x.trim()).filter(Boolean)
        : [];
      const meus = comboios.filter((c) => regs.includes(c.registroInterno));
      if (meus.length) return meus[0].id;
      if (comboios.length === 1) return comboios[0].id;
      return null; // admin escolhe na lista
    });
    setLoading(false);
  }, [user]);

  useFocusEffect(useCallback(() => { load(); }, [load, syncTick]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const comboios = useMemo(() => vehicles.filter((v) => v.isComboioVehicle), [vehicles]);
  const comboio = useMemo(() => comboios.find((c) => c.id === comboioId) || null, [comboios, comboioId]);
  const fuelLevels = parseFuelLevels(comboio?.fuelLevels);
  const capacity = Number(comboio?.fuelCapacity) || 2000;

  const myTxns = useMemo(
    () =>
      transactions
        .filter((t) => t.comboioVehicleId === comboioId)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 30),
    [transactions, comboioId]
  );

  const comboioItems = comboios.map((c) => ({
    ...c,
    _label: c.registroInterno || c.placa || `Comboio ${c.id}`,
    _sub: c.modelo || '',
  }));

  if (loading) return <Loading />;

  if (comboios.length === 0) {
    return <EmptyState icon="tanker-truck" title="Nenhum comboio cadastrado" subtitle="Cadastre um veículo-comboio no sistema web." />;
  }

  if (!comboio) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.appBg, padding: spacing[4], gap: spacing[3] }}>
        <SectionTitle>Selecione o comboio</SectionTitle>
        {comboioItems.map((c) => (
          <TouchableOpacity key={c.id} activeOpacity={0.7} onPress={() => setComboioId(c.id)}>
            <Card style={s.pickRow}>
              <Icon name="tanker-truck" size={22} color={colors.amber} />
              <View style={{ flex: 1 }}>
                <Text style={s.pickTitle}>{c._label}</Text>
                {c._sub ? <Text style={s.pickSub}>{c._sub}</Text> : null}
              </View>
              <Icon name="chevron-right" size={18} color={colors.fg4} />
            </Card>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing[10] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header escuro com tanques */}
        <View style={s.header}>
          <View style={s.headerTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.hello}>Comboio {comboio.registroInterno}</Text>
              <Text style={s.helloSub}>{comboio.modelo || 'Distribuição de combustível'}</Text>
            </View>
            {comboios.length > 1 && (
              <TouchableOpacity style={s.switchBtn} onPress={() => setPicker(true)}>
                <Icon name="swap-horizontal" size={20} color={colors.shellTextHi} />
              </TouchableOpacity>
            )}
          </View>

          <View style={{ marginTop: spacing[3] }}>
            <FuelBar label={FUEL_LABELS.dieselS10} liters={Number(fuelLevels.dieselS10) || 0} capacity={capacity} color="#3b82f6" />
            <FuelBar label={FUEL_LABELS.dieselComum} liters={Number(fuelLevels.dieselComum) || 0} capacity={capacity} color="#22c55e" />
          </View>
        </View>

        {/* Botão principal */}
        <View style={{ paddingHorizontal: spacing[4], marginTop: -spacing[4] }}>
          <TouchableOpacity
            style={s.cta}
            activeOpacity={0.85}
            onPress={() => navigation.navigate('DistribuicaoComboio', { comboioId: comboio.id })}
          >
            <Icon name="fuel" size={26} color={colors.fg1} />
            <Text style={s.ctaText}>ABASTECER VEÍCULO</Text>
          </TouchableOpacity>
        </View>

        {/* Histórico */}
        <View style={{ padding: spacing[4], gap: spacing[2] }}>
          <SectionTitle>Transações recentes</SectionTitle>
          {myTxns.length === 0 ? (
            <EmptyState icon="history" title="Nenhuma transação" subtitle="Os abastecimentos feitos por este comboio aparecem aqui." />
          ) : (
            myTxns.map((t) => {
              const isEntrada = t.type === 'entrada';
              const litros = parseFloat(t.liters || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
              return (
                <Card key={t.id} style={s.txRow}>
                  <View style={[s.txIcon, { backgroundColor: isEntrada ? '#e0f2fe' : '#fef3c7' }]}>
                    <Icon name={isEntrada ? 'arrow-up-bold' : 'arrow-down-bold'} size={16} color={isEntrada ? '#0369a1' : '#a16207'} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={s.txTopRow}>
                      <Text style={s.txTitle} numberOfLines={1}>
                        {isEntrada ? (t.partnerName || 'Entrada') : (t.receivingVehicleName || 'Saída')}
                      </Text>
                      <Text style={s.txLiters}>{litros} L</Text>
                    </View>
                    <View style={s.txMeta}>
                      <Text style={[s.txTag, t.fuelType === 'dieselS10' ? s.tagBlue : s.tagGreen]}>
                        {t.fuelType === 'dieselS10' ? 'S10' : 'Comum'}
                      </Text>
                      <Text style={s.txDate}>{formatTxDate(t.date)}</Text>
                    </View>
                  </View>
                </Card>
              );
            })
          )}
        </View>
      </ScrollView>

      <SelectModal
        visible={picker}
        title="Trocar comboio"
        items={comboioItems}
        labelKey="_label"
        subLabelKey="_sub"
        onSelect={(item) => { setComboioId(item.id); setPicker(false); }}
        onClose={() => setPicker(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: colors.shellBg, paddingHorizontal: spacing[4],
    paddingTop: spacing[5], paddingBottom: spacing[6] + spacing[4],
  },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  hello: { fontSize: 18, fontWeight: '700', color: colors.shellTextHi },
  helloSub: { fontSize: 13, color: colors.shellText, marginTop: 1 },
  switchBtn: { padding: 8, backgroundColor: colors.shellSurface, borderRadius: radius.full },

  fuelTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  fuelLabel: { fontSize: 12, fontWeight: '700', color: colors.shellTextHi },
  fuelValue: { fontSize: 12, color: colors.shellText, fontVariant: ['tabular-nums'] },
  fuelTrack: { height: 10, borderRadius: radius.full, backgroundColor: colors.shellSurface, overflow: 'hidden' },
  fuelFill: { height: '100%', borderRadius: radius.full },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.gold, borderRadius: radius.xl, paddingVertical: 18,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  ctaText: { fontSize: 15, fontWeight: '800', color: colors.fg1, letterSpacing: 0.5 },

  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pickTitle: { fontSize: 14, fontWeight: '600', color: colors.fg1 },
  pickSub: { fontSize: 12, color: colors.fg3, marginTop: 1 },

  txRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  txIcon: { width: 32, height: 32, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  txTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  txTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.fg1 },
  txLiters: { fontSize: 13, fontWeight: '700', color: colors.fg1, fontVariant: ['tabular-nums'] },
  txMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  txTag: { fontSize: 10, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, overflow: 'hidden' },
  tagBlue: { backgroundColor: '#e0f2fe', color: '#0369a1' },
  tagGreen: { backgroundColor: '#dcfce7', color: '#15803d' },
  txDate: { fontSize: 11, color: colors.fg4 },
});
