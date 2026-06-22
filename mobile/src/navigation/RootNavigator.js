import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';

import { useAuth } from '../auth/AuthContext';
import { getTabsForRole } from './roleTabs';
import { colors } from '../theme/tokens';
import { Loading } from '../components/ui';

import LoginScreen from '../screens/auth/LoginScreen';
import SolicitarCadastroScreen from '../screens/auth/SolicitarCadastroScreen';
import AguardandoAprovacaoScreen from '../screens/auth/AguardandoAprovacaoScreen';

import OperadorHomeScreen from '../screens/operador/OperadorHomeScreen';
import MinhasSolicitacoesScreen from '../screens/operador/MinhasSolicitacoesScreen';
import NovaSolicitacaoScreen from '../screens/operador/NovaSolicitacaoScreen';
import DetalheSolicitacaoScreen from '../screens/operador/DetalheSolicitacaoScreen';

import AdminHomeScreen from '../screens/admin/AdminHomeScreen';
import FilaSolicitacoesScreen from '../screens/admin/FilaSolicitacoesScreen';
import CadastrosPendentesScreen from '../screens/admin/CadastrosPendentesScreen';
import AnaliseSolicitacaoScreen from '../screens/admin/AnaliseSolicitacaoScreen';
import FrotaScreen from '../screens/frota/FrotaScreen';
import DetalheVeiculoScreen from '../screens/frota/DetalheVeiculoScreen';
import SupervisorHomeScreen from '../screens/supervisor/SupervisorHomeScreen';
import DetalheObraScreen from '../screens/supervisor/DetalheObraScreen';
import ComboioScreen from '../screens/comboio/ComboioScreen';
import DistribuicaoComboioScreen from '../screens/comboio/DistribuicaoComboioScreen';
import { useRealtime } from '../realtime/SocketContext';

import PerfilScreen from '../screens/comum/PerfilScreen';
import TrocarSenhaScreen from '../screens/comum/TrocarSenhaScreen';
import MaisScreen from '../screens/comum/MaisScreen';
import EmConstrucaoScreen from '../screens/comum/EmConstrucaoScreen';
import RelatoriosScreen from '../screens/relatorios/RelatoriosScreen';
import AbastecimentosScreen from '../screens/operacoes/AbastecimentosScreen';
import ObrasScreen from '../screens/obras/ObrasScreen';
import FuncionariosScreen from '../screens/cadastros/FuncionariosScreen';
import FornecedoresScreen from '../screens/cadastros/FornecedoresScreen';
import DespesasScreen from '../screens/operacoes/DespesasScreen';
import HorasScreen from '../screens/operacoes/HorasScreen';
import CentralOperacionalScreen from '../screens/operacoes/CentralOperacionalScreen';
import RevisoesScreen from '../screens/oficina/RevisoesScreen';
import PneusScreen from '../screens/oficina/PneusScreen';
import OrdensScreen from '../screens/oficina/OrdensScreen';
import EstoqueScreen from '../screens/cadastros/EstoqueScreen';
import MultasScreen from '../screens/cadastros/MultasScreen';
import SigaSulScreen from '../screens/gps/SigaSulScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const TAB_SCREENS = {
  OperadorHome: { component: OperadorHomeScreen, title: 'Início' },
  MinhasSolicitacoes: { component: MinhasSolicitacoesScreen, title: 'Solicitações' },
  AdminHome: { component: AdminHomeScreen, title: 'Início' },
  SupervisorHome: { component: SupervisorHomeScreen, title: 'Gestão de obras' },
  FilaSolicitacoes: { component: FilaSolicitacoesScreen, title: 'Solicitações' },
  Frota: { component: FrotaScreen, title: 'Frota' },
  Comboio: { component: ComboioScreen, title: 'Comboio' },
  Relatorios: { component: RelatoriosScreen, title: 'Relatórios' },
  Mais: { component: MaisScreen, title: 'Mais' },
  Perfil: { component: PerfilScreen, title: 'Perfil' },
};

function Tabs() {
  const { role } = useAuth();
  const { pendentes } = useRealtime();
  const tabs = getTabsForRole(role);

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.fg1, fontSize: 17, fontWeight: '700' },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.amber,
        tabBarInactiveTintColor: colors.fg4,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
      }}
    >
      {tabs.map((tab) => {
        const def = TAB_SCREENS[tab.screen] || { component: EmConstrucaoScreen, title: tab.label };
        return (
          <Tab.Screen
            key={tab.name}
            name={tab.name}
            component={def.component}
            options={{
              title: def.title,
              tabBarLabel: tab.label,
              tabBarIcon: ({ color, size }) => (
                <Icon name={tab.icon} size={size ?? 22} color={color} />
              ),
              tabBarBadge:
                tab.screen === 'FilaSolicitacoes' && pendentes > 0 ? pendentes : undefined,
              tabBarBadgeStyle: { backgroundColor: colors.danger, fontSize: 10 },
              headerShown:
                tab.screen !== 'OperadorHome' &&
                tab.screen !== 'AdminHome' &&
                tab.screen !== 'SupervisorHome' &&
                tab.screen !== 'Comboio',
            }}
          />
        );
      })}
    </Tab.Navigator>
  );
}

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.appBg,
    card: colors.surface,
    text: colors.fg1,
    primary: colors.amber,
    border: colors.border,
  },
};

export default function RootNavigator() {
  const { user, loading } = useAuth();

  if (loading) return <Loading />;

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { color: colors.fg1, fontSize: 16, fontWeight: '600' },
          headerTintColor: colors.amber,
          headerShadowVisible: false,
        }}
      >
        {!user ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen
              name="SolicitarCadastro"
              component={SolicitarCadastroScreen}
              options={{ title: 'Solicitar cadastro' }}
            />
            <Stack.Screen
              name="AguardandoAprovacao"
              component={AguardandoAprovacaoScreen}
              options={{ headerShown: false }}
            />
          </>
        ) : (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen
              name="NovaSolicitacao"
              component={NovaSolicitacaoScreen}
              options={{ title: 'Nova solicitação' }}
            />
            <Stack.Screen
              name="DetalheSolicitacao"
              component={DetalheSolicitacaoScreen}
              options={({ route }) => ({ title: `Solicitação #${route.params?.id ?? ''}` })}
            />
            <Stack.Screen
              name="DetalheVeiculo"
              component={DetalheVeiculoScreen}
              options={({ route }) => ({ title: route.params?.placa || 'Veículo' })}
            />
            <Stack.Screen
              name="DetalheObra"
              component={DetalheObraScreen}
              options={({ route }) => ({ title: route.params?.nome || 'Obra' })}
            />
            <Stack.Screen
              name="DistribuicaoComboio"
              component={DistribuicaoComboioScreen}
              options={{ title: 'Abastecer veículo' }}
            />
            <Stack.Screen
              name="AnaliseSolicitacao"
              component={AnaliseSolicitacaoScreen}
              options={({ route }) => ({
                title: `Analisar #${route.params?.solicitacao?.id ?? route.params?.id ?? ''}`,
              })}
            />
            <Stack.Screen
              name="CadastrosPendentes"
              component={CadastrosPendentesScreen}
              options={{ title: 'Cadastros pendentes' }}
            />
            <Stack.Screen
              name="Frota"
              component={FrotaScreen}
              options={{ title: 'Frota' }}
            />
            <Stack.Screen name="Relatorios" component={RelatoriosScreen} options={{ title: 'Relatórios' }} />
            <Stack.Screen name="Comboio" component={ComboioScreen} options={{ title: 'Comboio' }} />
            <Stack.Screen
              name="Abastecimentos"
              component={AbastecimentosScreen}
              options={{ title: 'Abastecimentos' }}
            />
            <Stack.Screen
              name="Obras"
              component={ObrasScreen}
              options={{ title: 'Obras' }}
            />
            <Stack.Screen
              name="Funcionarios"
              component={FuncionariosScreen}
              options={{ title: 'Funcionários' }}
            />
            <Stack.Screen
              name="Fornecedores"
              component={FornecedoresScreen}
              options={{ title: 'Fornecedores' }}
            />
            <Stack.Screen name="Despesas" component={DespesasScreen} options={{ title: 'Despesas' }} />
            <Stack.Screen name="Horas" component={HorasScreen} options={{ title: 'Horas' }} />
            <Stack.Screen name="CentralOperacional" component={CentralOperacionalScreen} options={{ title: 'Central operacional' }} />
            <Stack.Screen name="Revisoes" component={RevisoesScreen} options={{ title: 'Revisões' }} />
            <Stack.Screen name="Pneus" component={PneusScreen} options={{ title: 'Pneus' }} />
            <Stack.Screen name="Ordens" component={OrdensScreen} options={{ title: 'Ordens C/S' }} />
            <Stack.Screen name="Estoque" component={EstoqueScreen} options={{ title: 'Estoque' }} />
            <Stack.Screen name="Multas" component={MultasScreen} options={{ title: 'Multas' }} />
            <Stack.Screen name="SigaSul" component={SigaSulScreen} options={{ title: 'SigaSul GPS' }} />
            <Stack.Screen
              name="TrocarSenha"
              component={TrocarSenhaScreen}
              options={{ title: 'Trocar senha' }}
            />
            <Stack.Screen
              name="EmConstrucao"
              component={EmConstrucaoScreen}
              options={({ route }) => ({ title: route.params?.titulo || 'Em construção' })}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
