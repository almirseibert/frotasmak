import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Card, PrimaryButton } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

export default function AguardandoAprovacaoScreen({ navigation, route }) {
  const { name, email } = route.params || {};

  return (
    <View style={s.container}>
      <View style={s.iconBox}>
        <Icon name="timer-sand" size={36} color={colors.warning} />
      </View>
      <Text style={s.title}>Cadastro em análise</Text>
      <Text style={s.subtitle}>
        Recebemos sua solicitação. Um administrador vai liberar seu acesso em
        breve — tente entrar novamente mais tarde.
      </Text>

      {(name || email) ? (
        <Card style={{ width: '100%', marginTop: spacing[5] }}>
          <Text style={s.cardLabel}>Dados enviados</Text>
          {name ? (
            <View style={s.cardRow}>
              <Text style={s.cardKey}>Nome</Text>
              <Text style={s.cardVal}>{name}</Text>
            </View>
          ) : null}
          {email ? (
            <View style={s.cardRow}>
              <Text style={s.cardKey}>E-mail</Text>
              <Text style={s.cardVal}>{email}</Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      <View style={{ width: '100%', marginTop: spacing[6], gap: spacing[2] }}>
        <PrimaryButton
          label="Voltar ao login"
          variant="outline"
          icon="arrow-left"
          onPress={() => navigation.popToTop()}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: colors.appBg, alignItems: 'center',
    justifyContent: 'center', padding: spacing[6],
  },
  iconBox: {
    width: 76, height: 76, borderRadius: 22, backgroundColor: colors.warningBg,
    borderWidth: 1, borderColor: colors.warningBorder,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing[4],
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.fg1 },
  subtitle: {
    fontSize: 13, color: colors.fg3, textAlign: 'center',
    lineHeight: 20, marginTop: spacing[2],
  },
  cardLabel: {
    fontSize: 10, color: colors.fg4, textTransform: 'uppercase',
    letterSpacing: 0.5, fontWeight: '600', marginBottom: 6,
  },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  cardKey: { fontSize: 13, color: colors.fg3 },
  cardVal: { fontSize: 13, color: colors.fg1, fontWeight: '500' },
});
