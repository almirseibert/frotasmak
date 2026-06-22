import React from 'react';
import { View, Text, ScrollView, Alert, StyleSheet } from 'react-native';
import { useAuth } from '../../auth/AuthContext';
import { Card, ListRow, SectionTitle, PrimaryButton } from '../../components/ui';
import { colors, spacing } from '../../theme/tokens';

export default function PerfilScreen({ navigation }) {
  const { user, role, logout } = useAuth();

  const confirmLogout = () => {
    Alert.alert('Sair', 'Deseja encerrar a sessão?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
    >
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>
              {(user?.name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{user?.name}</Text>
            <Text style={s.meta}>{user?.email}</Text>
            <Text style={s.metaRole}>{role}</Text>
          </View>
        </View>
      </Card>

      <SectionTitle>Conta</SectionTitle>
      <ListRow
        icon="key"
        title="Trocar senha"
        onPress={() => navigation.navigate('TrocarSenha')}
      />

      <View style={{ marginTop: spacing[4] }}>
        <PrimaryButton label="Sair" icon="logout" variant="danger" onPress={confirmLogout} />
      </View>

      <Text style={s.version}>MAK Frotas mobile · v0.1.0</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  avatar: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: colors.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.fgInverse, fontSize: 18, fontWeight: '600' },
  name: { fontSize: 16, fontWeight: '700', color: colors.fg1 },
  meta: { fontSize: 12, color: colors.fg3 },
  metaRole: { fontSize: 11, color: colors.fg4, textTransform: 'capitalize', marginTop: 1 },
  version: { fontSize: 11, color: colors.fg5, textAlign: 'center', marginTop: spacing[4] },
});
