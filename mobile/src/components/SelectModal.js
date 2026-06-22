// Seletor em modal com busca — substitui <select> do web em telas touch.
import React, { useState, useMemo } from 'react';
import {
  Modal, View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme/tokens';

export default function SelectModal({
  visible, title, items, labelKey = 'label', subLabelKey, onSelect, onClose,
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      [item[labelKey], subLabelKey ? item[subLabelKey] : null]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q))
    );
  }, [items, query, labelKey, subLabelKey]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={s.closeBtn}>
            <Icon name="close" size={22} color={colors.fg2} />
          </TouchableOpacity>
        </View>

        <View style={s.searchWrap}>
          <Icon name="magnify" size={18} color={colors.fg4} />
          <TextInput
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar…"
            placeholderTextColor={colors.fg5}
            autoFocus
          />
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item, idx) => String(item.id ?? idx)}
          contentContainerStyle={{ padding: spacing[4], paddingTop: spacing[2], gap: spacing[2] }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.item}
              activeOpacity={0.7}
              onPress={() => { onSelect(item); setQuery(''); }}
            >
              <Text style={s.itemLabel}>{item[labelKey]}</Text>
              {subLabelKey && item[subLabelKey] ? (
                <Text style={s.itemSub}>{item[subLabelKey]}</Text>
              ) : null}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={s.emptyText}>Nada encontrado para “{query}”.</Text>
          }
        />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.appBg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[4], paddingBottom: spacing[2], backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: '700', color: colors.fg1 },
  closeBtn: { padding: 4 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong,
    borderRadius: radius.md, paddingHorizontal: spacing[3],
    margin: spacing[4], marginBottom: 0,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.fg2 },
  item: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing[3],
  },
  itemLabel: { fontSize: 14, fontWeight: '500', color: colors.fg1 },
  itemSub: { fontSize: 12, color: colors.fg3, marginTop: 1 },
  emptyText: { textAlign: 'center', color: colors.fg4, fontSize: 13, marginTop: spacing[6] },
});
