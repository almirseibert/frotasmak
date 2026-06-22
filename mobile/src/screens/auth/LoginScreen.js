import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import { PrimaryButton } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

export default function LoginScreen({ navigation }) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!identifier.trim() || !password) {
      setError('Informe usuário e senha.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await login(identifier.trim(), password);
      // RootNavigator troca a árvore automaticamente quando user é setado
    } catch (e) {
      if (e.status === 403) {
        // Cadastro pendente de aprovação
        navigation.navigate('AguardandoAprovacao', { email: identifier.trim() });
      } else {
        setError(e.message || 'Falha no login. Verifique suas credenciais.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <View style={s.logoBox}>
          <View style={s.logoMark}>
            <Text style={s.logoMarkText}>M</Text>
          </View>
          <Text style={s.logoName}>MAK FROTAS</Text>
          <Text style={s.logoTag}>operação · campo</Text>
        </View>

        <View style={{ gap: spacing[3] }}>
          <View>
            <Text style={s.label}>Usuário ou e-mail</Text>
            <TextInput
              style={s.input}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="seu.usuario"
              placeholderTextColor={colors.fg5}
            />
          </View>
          <View>
            <Text style={s.label}>Senha</Text>
            <View style={s.passwordWrap}>
              <TextInput
                style={[s.input, { flex: 1, borderWidth: 0 }]}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.fg5}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={s.eyeBtn}>
                <Icon name={showPassword ? 'eye-off' : 'eye'} size={20} color={colors.fg4} />
              </TouchableOpacity>
            </View>
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}

          <PrimaryButton label="Entrar" icon="login" onPress={handleLogin} loading={loading} />
        </View>

        <View style={s.footer}>
          <Text style={s.footerHint}>Primeiro acesso?</Text>
          <TouchableOpacity onPress={() => navigation.navigate('SolicitarCadastro')}>
            <Text style={s.footerLink}>Solicitar cadastro</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flexGrow: 1, padding: spacing[6], justifyContent: 'center' },
  logoBox: { alignItems: 'center', marginBottom: spacing[8] },
  logoMark: {
    width: 64, height: 64, borderRadius: 20, backgroundColor: colors.amber,
    alignItems: 'center', justifyContent: 'center',
  },
  logoMarkText: { color: colors.fgInverse, fontSize: 28, fontWeight: '700' },
  logoName: { fontSize: 20, fontWeight: '700', color: colors.fg1, letterSpacing: 1, marginTop: spacing[3] },
  logoTag: { fontSize: 12, color: colors.fg3, marginTop: 2 },

  label: {
    fontSize: 11, color: colors.fg4, textTransform: 'uppercase',
    letterSpacing: 0.5, fontWeight: '600', marginBottom: 4,
  },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: 12,
    fontSize: 15, color: colors.fg2,
  },
  passwordWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md,
  },
  eyeBtn: { padding: 10 },
  error: { color: colors.danger, fontSize: 13 },

  footer: {
    marginTop: spacing[10], alignItems: 'center', gap: 4,
    borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing[4],
  },
  footerHint: { fontSize: 12, color: colors.fg4 },
  footerLink: { fontSize: 14, color: colors.amber, fontWeight: '600' },
});
