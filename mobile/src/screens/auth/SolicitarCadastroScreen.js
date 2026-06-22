import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../../api/client';
import { PrimaryButton } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

export default function SolicitarCadastroScreen({ navigation }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim() || !email.trim() || !password) {
      setError('Todos os campos são obrigatórios.');
      return;
    }
    if (password.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api.register({ name: name.trim(), email: email.trim(), password });
      navigation.replace('AguardandoAprovacao', { name: name.trim(), email: email.trim() });
    } catch (e) {
      setError(e.message || 'Erro ao enviar solicitação.');
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
        <Text style={s.title}>Solicitar cadastro</Text>
        <Text style={s.subtitle}>
          Seu acesso será liberado por um administrador após a análise.
        </Text>

        <View style={{ gap: spacing[3], marginTop: spacing[5] }}>
          <View>
            <Text style={s.label}>Nome completo</Text>
            <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Seu nome" placeholderTextColor={colors.fg5} />
          </View>
          <View>
            <Text style={s.label}>E-mail</Text>
            <TextInput
              style={s.input} value={email} onChangeText={setEmail}
              autoCapitalize="none" keyboardType="email-address"
              placeholder="voce@empresa.com" placeholderTextColor={colors.fg5}
            />
          </View>
          <View>
            <Text style={s.label}>Senha</Text>
            <TextInput
              style={s.input} value={password} onChangeText={setPassword}
              secureTextEntry placeholder="Mínimo 6 caracteres" placeholderTextColor={colors.fg5}
            />
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}

          <PrimaryButton label="Enviar solicitação" icon="send" onPress={handleSubmit} loading={loading} />
          <PrimaryButton label="Voltar ao login" variant="outline" onPress={() => navigation.goBack()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flexGrow: 1, padding: spacing[6], justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: colors.fg1 },
  subtitle: { fontSize: 13, color: colors.fg3, marginTop: 4, lineHeight: 19 },
  label: {
    fontSize: 11, color: colors.fg4, textTransform: 'uppercase',
    letterSpacing: 0.5, fontWeight: '600', marginBottom: 4,
  },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: 12,
    fontSize: 15, color: colors.fg2,
  },
  error: { color: colors.danger, fontSize: 13 },
});
