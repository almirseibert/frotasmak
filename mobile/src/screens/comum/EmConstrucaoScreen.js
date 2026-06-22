import React from 'react';
import { View } from 'react-native';
import { EmptyState } from '../../components/ui';
import { colors } from '../../theme/tokens';

// Placeholder padrão para módulos das próximas seções do roteiro de implantação.
export default function EmConstrucaoScreen({ route }) {
  const titulo = route?.params?.titulo || 'Em construção';
  return (
    <View style={{ flex: 1, backgroundColor: colors.appBg, justifyContent: 'center' }}>
      <EmptyState
        icon="hammer-wrench"
        title={titulo}
        subtitle="Este módulo está na fila do roteiro de implantação e chega em breve."
      />
    </View>
  );
}
