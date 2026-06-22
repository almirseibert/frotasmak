import React, { useState } from 'react';
import { View, Text, TextInput, Alert, StyleSheet, ScrollView } from 'react-native';
import api from '../../api/client';
import { PrimaryButton } from '../../components/ui';
import { colors, radius, spacing } from '../../theme/tokens';

export default function TrocarSenhaScreen({ navigation }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!currentPassword || !newPassword) {
      setError('Preencha todos os campos.');
      return;
    }
    if (newPassword.length < 6) {
      setError('A nova senha deve ter no mínimo 6 caracteres.');
      return;
    }
    if (newPassword !== confirm) {
      setError('A confirmação não confere com a nova senha.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      Alert.alert('Pronto', 'Senha alterada com sucesso.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      setError(e.message || 'Erro ao trocar a senha.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.appBg }}
      contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
      keyboardShouldPersistTaps="handled"
    >
      <View>
        <Text style={s.label}>Senha atual</Text>
        <TextInput style={s.input} value={currentPassword} onChangeText={setCurrent} secureTextEntry />
      </View>
      <View>
        <Text style={s.label}>Nova senha</Text>
        <TextInput style={s.input} value={newPassword} onChangeText={setNew} secureTextEntry />
      </View>
      <View>
        <Text style={s.label}>Confirmar nova senha</Text>
        <TextInput style={s.input} value={confirm} onChangeText={setConfirm} secureTextEntry />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <PrimaryButton label="Salvar nova senha" icon="check" onPress={handleSubmit} loading={loading} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
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
