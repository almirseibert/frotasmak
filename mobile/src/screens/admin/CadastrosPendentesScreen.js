import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, RefreshControl, Alert, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../api/client';
import { EmptyState, Loading, PrimaryButton } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

export default function CadastrosPendentesScreen() {
  const [rows, setRows] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getRegistrationRequests();
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows((prev) => prev || []);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const aprovar = (req) => {
    Alert.alert(
      `Aprovar ${req.name || req.email}`,
      'O usuário entra como operador, com acesso ao app de abastecimento.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Aprovar',
          onPress: async () => {
            setBusyId(req.id);
            try {
              await api.approveRegistration({
                userId: req.id,
                role: 'operador',
                canAccessRefueling: true,
              });
              await load();
            } catch (e) {
              Alert.alert('Erro', e.message || 'Não foi possível aprovar.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  };

  const rejeitar = (req) => {
    Alert.alert(`Rejeitar ${req.name || req.email}`, 'A solicitação será excluída.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Rejeitar',
        style: 'destructive',
        onPress: async () => {
          setBusyId(req.id);
          try {
            await api.rejectRegistration(req.id);
            await load();
          } catch (e) {
            Alert.alert('Erro', e.message || 'Não foi possível rejeitar.');
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  if (rows === null) return <Loading />;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.appBg }}
      data={rows}
      keyExtractor={(item) => String(item.id)}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[2], flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={
        <EmptyState
          icon="account-check"
          title="Nenhum cadastro pendente"
          subtitle="Novas solicitações de acesso aparecem aqui."
        />
      }
      renderItem={({ item }) => {
        const quando = item.created_at
          ? new Date(item.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '';
        return (
          <View style={s.item}>
            <Text style={s.name}>{item.name || '—'}</Text>
            <Text style={s.meta}>{item.email}</Text>
            {quando ? <Text style={s.metaDim}>Solicitado em {quando}</Text> : null}
            <View style={s.actions}>
              <PrimaryButton
                label="Aprovar" icon="check"
                style={{ flex: 1, minHeight: 40, paddingVertical: 8 }}
                loading={busyId === item.id}
                onPress={() => aprovar(item)}
              />
              <PrimaryButton
                label="Rejeitar" icon="close" variant="danger"
                style={{ flex: 1, minHeight: 40, paddingVertical: 8 }}
                disabled={busyId === item.id}
                onPress={() => rejeitar(item)}
              />
            </View>
          </View>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  item: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  name: { fontSize: 15, fontWeight: '600', color: colors.fg1 },
  meta: { fontSize: 13, color: colors.fg3, marginTop: 1 },
  metaDim: { fontSize: 11, color: colors.fg4, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[3] },
});
