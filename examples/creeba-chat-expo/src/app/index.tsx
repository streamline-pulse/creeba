import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatMessage } from '@/sync/types';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useCreeba } from '@/sync/useCreeba';

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { identity, messages, peers, status, send, setName } = useCreeba();

  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    if (identity) setNameDraft(identity.name);
  }, [identity]);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length]);

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    send(body);
    setDraft('');
  };

  const commitName = () => {
    const name = nameDraft.trim();
    if (name && name !== identity?.name) setName(name);
  };

  const renderItem = ({ item }: { item: ChatMessage }) => {
    const mine = item.userId === identity?.userId;
    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: mine ? colors.backgroundSelected : colors.backgroundElement,
            },
          ]}>
          {!mine && (
            <Text style={[styles.author, { color: colors.textSecondary }]}>{item.name}</Text>
          )}
          <Text style={[styles.body, { color: colors.text }]}>{item.body}</Text>
          <Text style={[styles.time, { color: colors.textSecondary }]}>{formatTime(item.ts)}</Text>
        </View>
      </View>
    );
  };

  const online = status.ready && peers.length > 0;
  const statusLabel = !status.ready
    ? 'connexion…'
    : peers.length > 0
      ? `${peers.length} pair${peers.length > 1 ? 's' : ''}`
      : 'en attente de pairs';

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <ThemedText type="title" style={styles.title}>
              Creeba
            </ThemedText>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: online ? '#22C55E' : status.ready ? '#F59E0B' : '#9CA3AF' },
                ]}
              />
              <Text style={[styles.statusText, { color: colors.textSecondary }]}>
                {statusLabel}
              </Text>
            </View>
          </View>
          <TextInput
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={commitName}
            onSubmitEditing={commitName}
            placeholder="Ton nom"
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.nameInput,
              { backgroundColor: colors.backgroundElement, color: colors.text },
            ]}
            returnKeyType="done"
          />
        </View>

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                Aucun message. Dis bonjour 👋
              </Text>
            }
          />

          <View
            style={[
              styles.inputRow,
              {
                borderTopColor: colors.backgroundElement,
                paddingBottom: insets.bottom + Spacing.two,
              },
            ]}>

            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Message…"
              placeholderTextColor={colors.textSecondary}
              style={[
                styles.input,
                { backgroundColor: colors.backgroundElement, color: colors.text },
              ]}
              multiline
              onSubmitEditing={onSend}
              returnKeyType="send"
              blurOnSubmit
            />
            <Pressable
              onPress={onSend}
              disabled={!draft.trim()}
              style={({ pressed }) => [
                styles.sendButton,
                {
                  backgroundColor: colors.text,
                  opacity: !draft.trim() ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}>
              <Text style={[styles.sendLabel, { color: colors.background }]}>Envoyer</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: Spacing.three,
  },
  headerLeft: { gap: Spacing.half },
  title: { fontSize: 26 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13 },
  nameInput: {
    minWidth: 120,
    maxWidth: 180,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    fontSize: 15,
  },
  listContent: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: Spacing.two,
    flexGrow: 1,
  },
  empty: { textAlign: 'center', marginTop: Spacing.five, fontSize: 15 },
  row: { flexDirection: 'row' },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    gap: 2,
  },
  author: { fontSize: 12, fontWeight: '600' },
  body: { fontSize: 16 },
  time: { fontSize: 11, alignSelf: 'flex-end' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    fontSize: 16,
    fontFamily: Fonts.sans,
  },
  sendButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    borderRadius: Spacing.three,
  },
  sendLabel: { fontWeight: '600', fontSize: 15 },
});
