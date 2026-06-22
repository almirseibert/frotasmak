// Componentes base — Pill, Card, KpiCard, ListRow, EmptyState, PrimaryButton
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme/tokens';

export const Pill = ({ label, bg, text, dot }) => (
  <View style={[s.pill, { backgroundColor: bg }]}>
    {dot ? <View style={[s.pillDot, { backgroundColor: dot }]} /> : null}
    <Text style={[s.pillText, { color: text }]}>{label}</Text>
  </View>
);

export const Card = ({ children, style, tone }) => {
  const toneStyle =
    tone === 'warning' ? { backgroundColor: colors.warningBg, borderColor: colors.warningBorder }
    : tone === 'danger' ? { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder }
    : tone === 'success' ? { backgroundColor: colors.successBg, borderColor: colors.successBorder }
    : null;
  return <View style={[s.card, toneStyle, style]}>{children}</View>;
};

export const KpiCard = ({ value, label, color }) => (
  <View style={s.kpi}>
    <Text style={[s.kpiValue, color ? { color } : null]}>{value}</Text>
    <Text style={s.kpiLabel}>{label}</Text>
  </View>
);

export const ListRow = ({ icon, title, subtitle, right, onPress, iconColor }) => (
  <TouchableOpacity style={s.row} onPress={onPress} disabled={!onPress} activeOpacity={0.7}>
    {icon ? (
      <View style={s.rowIcon}>
        <Icon name={icon} size={20} color={iconColor || colors.amber} />
      </View>
    ) : null}
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
      {subtitle ? <Text style={s.rowSub} numberOfLines={2}>{subtitle}</Text> : null}
    </View>
    {right || (onPress ? <Icon name="chevron-right" size={18} color={colors.fg4} /> : null)}
  </TouchableOpacity>
);

export const SectionTitle = ({ children }) => (
  <Text style={s.sectionTitle}>{children}</Text>
);

export const EmptyState = ({ icon = 'inbox', title, subtitle }) => (
  <View style={s.empty}>
    <Icon name={icon} size={40} color={colors.fg5} />
    <Text style={s.emptyTitle}>{title}</Text>
    {subtitle ? <Text style={s.emptySub}>{subtitle}</Text> : null}
  </View>
);

export const PrimaryButton = ({ label, icon, onPress, loading, disabled, variant = 'primary', style }) => {
  const vs =
    variant === 'danger' ? { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.dangerBorder }
    : variant === 'outline' ? { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.amber }
    : { backgroundColor: colors.amber };
  const textColor =
    variant === 'danger' ? colors.danger
    : variant === 'outline' ? colors.amber
    : colors.fgInverse;
  return (
    <TouchableOpacity
      style={[s.btn, vs, (disabled || loading) && { opacity: 0.6 }, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
    >
      {loading ? (
        <ActivityIndicator color={textColor} size="small" />
      ) : (
        <>
          {icon ? <Icon name={icon} size={18} color={textColor} /> : null}
          <Text style={[s.btnText, { color: textColor }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
};

export const Loading = () => (
  <View style={s.loading}>
    <ActivityIndicator size="large" color={colors.amber} />
  </View>
);

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 11, fontWeight: '500' },

  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },

  kpi: {
    flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: spacing[3], minWidth: '45%',
  },
  kpiValue: { fontSize: 20, fontWeight: '700', color: colors.fg1, fontVariant: ['tabular-nums'] },
  kpiLabel: { fontSize: 10, color: colors.fg4, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2, fontWeight: '500' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  rowIcon: {
    width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  rowTitle: { fontSize: 14, fontWeight: '500', color: colors.fg1 },
  rowSub: { fontSize: 12, color: colors.fg3, marginTop: 1 },

  sectionTitle: {
    fontSize: 11, color: colors.fg3, textTransform: 'uppercase',
    letterSpacing: 0.6, fontWeight: '600', marginTop: spacing[2],
  },

  empty: { alignItems: 'center', paddingVertical: spacing[10], gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '500', color: colors.fg2 },
  emptySub: { fontSize: 12, color: colors.fg4, textAlign: 'center', paddingHorizontal: spacing[6] },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.lg, paddingVertical: 13, paddingHorizontal: spacing[4],
    minHeight: 48,
  },
  btnText: { fontSize: 15, fontWeight: '600' },

  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.appBg },
});
