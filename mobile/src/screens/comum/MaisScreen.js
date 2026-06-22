import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import { MODULE_CATALOG, canAccessPage } from '../../navigation/roleTabs';
import { SectionTitle } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

// Mapa módulo → tela registrada (módulos sem tela própria caem no EmConstrucao)
const MODULE_SCREEN = {
  vehicles: 'Frota',
  comboio: 'Comboio',
  admin_solicitacoes: 'Solicitacoes',
  admin_usuarios: 'CadastrosPendentes',
  reports: 'Relatorios',
  refueling: 'Abastecimentos',
  obras: 'Obras',
  employees: 'Funcionarios',
  partners: 'Fornecedores',
  expenses: 'Despesas',
  billing: 'Horas',
  operacional: 'CentralOperacional',
  revisions: 'Revisoes',
  tires: 'Pneus',
  orders: 'Ordens',
  inventory: 'Estoque',
  fines: 'Multas',
  sigasul: 'SigaSul',
};

export default function MaisScreen({ navigation }) {
  const { role } = useAuth();

  const groups = MODULE_CATALOG.map((g) => ({
    ...g,
    items: g.items.filter(
      (m) => (m.adminOnly ? role === 'admin' : true) && canAccessPage(role, m.id)
    ),
  })).filter((g) => g.items.length > 0);

  const open = (mod) => {
    const screen = MODULE_SCREEN[mod.id];
    if (screen) navigation.navigate(screen);
    else navigation.navigate('EmConstrucao', { titulo: mod.label });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
    >
      {groups.map((group) => (
        <View key={group.group} style={{ gap: spacing[2] }}>
          <SectionTitle>{group.group}</SectionTitle>
          <View style={s.grid}>
            {group.items.map((mod) => (
              <TouchableOpacity key={mod.id} style={s.tile} activeOpacity={0.7} onPress={() => open(mod)}>
                <Icon name={mod.icon} size={24} color={colors.amber} />
                <Text style={s.tileLabel} numberOfLines={2}>{mod.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  tile: {
    width: '31%', minWidth: 100, aspectRatio: 1.15,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: spacing[2],
  },
  tileLabel: { fontSize: 11, fontWeight: '500', color: colors.fg2, textAlign: 'center' },
});
