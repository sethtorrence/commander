import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Kbd,
  toast,
} from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import type { ItemChanges } from '../../item-store/changes';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { EmptySheet, SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { sectionFor } from '../todos/links';
import { SummariseButton, SummaryPanel, WaitingNote } from './ChatAres';
import { ChatFilterBar } from './ChatFilterBar';
import { ChatRow } from './ChatRow';
import { ChatView } from './ChatView';
import { ReplySuggestionCard, TodoSuggestionCard } from './ChatWork';
import { type ChatSummariser, useChatSummary } from './chat-summary';
import { type ChatWorkClient, useChatWork } from './chat-work';
import type { Chat } from './chats';
import { inReplyBox, ReplyBox } from './ReplyBox';
import { type ChatLink, checkLine, type TeamsAccountsClient, type TeamsChats } from './teams-chats';
import { useTeams } from './use-teams';

// Enter opens the selected Chat, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [<Kbd key="esc">Esc</Kbd>, 'Back'],
  [<Kbd key="b">B</Kbd>, 'Project'],
  [<Kbd key="send">Ctrl ↵</Kbd>, 'Send reply'],
  [<Kbd key="u">Ctrl U</Kbd>, 'Unread'],
  [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
];

/** The Section's main keys at a glance, beside its title. All of them are in the `?` cheat sheet. */
function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}

/** Excluding a Chat, after the User confirms: what it does, and how to undo it. */
function ExcludeDialog({
  chat,
  onConfirm,
  onCancel,
}: {
  chat: Chat | null;
  onConfirm: (chat: Chat) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={chat !== null} onOpenChange={(open) => !open && onCancel()}>
      {chat && (
        <DialogContent aria-describedby={undefined}>
          <DialogHeader partNumber="TMS">
            <DialogTitle>Exclude this Chat?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogHeading>{chat.title}</DialogHeading>
            <DialogDescription>
              Commander deletes its copy of the Chat and stops syncing it. Notes and Todos keep their Links to
              it, shown as gone. Nothing changes in Teams. Include it again in Settings → Teams.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={() => onConfirm(chat)}>
              Exclude
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * The Teams Section's sheet, after the prototype's Section pattern: the sheet header, the Project
 * filter, the Teams filters (Chat type, Unread only) with the status line, then the Chat list and,
 * once a Chat is opened, the Chat view. Opening the Section asks every Teams Account for a light sync.
 */
export function TeamsSheet({
  chats: client,
  accounts,
  changes,
  summariser,
  work,
}: {
  chats: TeamsChats;
  accounts: TeamsAccountsClient;
  changes?: ItemChanges;
  /** Ares's Summarise (#109); without it, the Chat view offers none. */
  summariser?: ChatSummariser;
  /** Ares's suggested Todos and replies, and Draft (#110); without it, the Chat view shows none. */
  work?: ChatWorkClient;
}) {
  const { filter, include } = useProjectFilter();
  const { projects, openPage } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const now = useNow(60_000);
  const state = useTeams({ chats: client, accounts, changes, include });
  const { selected, open, setOpen } = state;
  const badges = useBadgePicker(state.apply, state.undo);
  const openSection = useOpenSection();
  const [excluding, setExcluding] = useState<Chat | null>(null);
  // Each Chat's unsent reply, kept while moving between Chats.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const several = state.accounts.length > 1;
  const summary = useChatSummary(summariser, open ? (selected?.id ?? null) : null);
  const chatWork = useChatWork(work, open ? (selected?.id ?? null) : null);

  // "Not waiting on you": a correction, undone from the toast or with Ctrl+Z.
  const notWaiting = async (chat: Chat) => {
    const entry = await state.apply(() => client.clearWaiting(chat.id));
    if (entry)
      toast(`Not waiting on you: ${chat.title}`, {
        action: { label: 'Undo', onClick: () => void state.undo(entry.id) },
      });
  };

  useTabCount(state.loaded ? state.unreadCount : null);
  useRefreshWhenOpened(state.refresh, state.reload);

  const file = () =>
    selected &&
    badges.open({
      id: selected.id,
      title: selected.title,
      filing: selected.filing,
      filingSuggestion: selected.filingSuggestion,
    });

  const openLink = ({ other }: ChatLink) => {
    if (other.kind === 'project') return openPage?.(other.id);
    if (other.deletedAt !== null) return;
    const section = sectionFor(other.kind);
    if (section && section !== 'teams') openSection(section);
    else if (other.kind === 'chat') state.reveal(other.id);
  };

  const draftOf = (chat: Chat | null) => (chat ? (drafts[chat.id] ?? '') : '');
  const setDraft = (chatId: string, text: string) => setDrafts((now) => ({ ...now, [chatId]: text }));

  const sendReply = async () => {
    const chat = selected;
    const text = draftOf(chat).trim();
    if (!chat || !text) return;
    if (await state.reply(chat, text)) setDraft(chat.id, '');
  };

  // Ares's work (#110). Everything the Chat says: what his words about it may link to.
  const sourcesOf = (chat: Chat) => [chat.title, ...chat.detail.messages.map((message) => message.text)];

  const addTodo = async (proposalId: number, title: string) => {
    if (await chatWork.accept(proposalId)) toast(`Todo added: ${title}`);
  };

  // Send: the suggested reply goes as the User's, through the outgoing queue.
  const sendSuggestedReply = async (chat: Chat, proposalId: number) => {
    if (await chatWork.accept(proposalId)) toast(`Reply on its way to ${chat.title}`);
  };

  // Edit: the draft goes in the reply box, for the User to change and send as any reply.
  const editSuggestedReply = (chat: Chat, proposalId: number, text: string) => {
    setDraft(chat.id, text);
    void chatWork.dismiss(proposalId);
  };

  // Draft: Ares's draft fills the reply box; what was in it comes back with Undo.
  const askForDraft = async () => {
    const drafted = await chatWork.draft();
    if (!drafted) return;
    const before = drafts[drafted.chatId] ?? '';
    setDraft(drafted.chatId, drafted.text);
    if (before.trim())
      toast('Ares’s draft replaced what you had written', {
        action: { label: 'Undo', onClick: () => setDraft(drafted.chatId, before) },
      });
  };

  // Mark as unread (or read again, while it is unread), undoable from the toast or with Ctrl+Z.
  const canToggleRead = (chat: Chat | null): chat is Chat =>
    !!chat && (chat.detail.unreadCount > 0 || state.canMarkUnread(chat));
  const toggleRead = async () => {
    if (!canToggleRead(selected)) return;
    const chat = selected;
    const read = chat.detail.unreadCount > 0;
    const entry = await state.setRead(chat, read);
    if (!entry) return;
    toast(read ? `Marked read: ${chat.title}` : `Marked unread: ${chat.title}`, {
      action: { label: 'Undo', onClick: () => void state.undo(entry.id) },
    });
  };

  const openChat = (itemId: string) => {
    state.select(itemId);
    setOpen(true);
  };

  useShortcuts([
    { keys: 'j', label: 'Next chat', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous chat', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open the chat', when: () => !onPressable(), run: () => setOpen(true) },
    {
      keys: 'Escape',
      label: 'Back to the chat list',
      when: () => open && !excluding,
      run: () => setOpen(false),
    },
    { keys: 'b', label: 'File under a Project', run: () => file() },
    {
      keys: 'Ctrl+Enter',
      label: 'Send the reply',
      inFields: true,
      when: () => open && inReplyBox(document.activeElement),
      run: () => void sendReply(),
    },
    {
      keys: 'Ctrl+u',
      label: 'Mark the chat as unread (or read)',
      when: () => canToggleRead(selected),
      run: () => void toggleRead(),
    },
    { keys: 'Ctrl+z', label: 'Undo', run: () => state.undo() },
  ]);
  // From the palette: open a Chat it found, whatever the filters were hiding; from the Dashboard, at
  // the message that put it there.
  useReveal('teams', (itemId, messageId) => state.reveal(itemId, messageId));

  const status = checkLine(state.accounts, now);
  const checking = state.accounts.some((account) => account.sync?.activity === 'syncing');
  const accountName = (chat: Chat | null) =>
    several && chat?.account
      ? (state.accounts.find((account) => account.id === chat.account)?.name ?? null)
      : null;

  return (
    <SectionSheet
      span="full"
      subtitle={
        <>
          <b>{state.counts.unread} unread</b> {state.counts.unread === 1 ? 'chat' : 'chats'}
          {filter !== 'everything' && ` ${filtered ? `in ${filtered.name}` : 'Unfiled'}`} · mentions and
          unread first
        </>
      }
      aside={<Keys />}
      className="flex flex-col"
    >
      <SectionProjectFilter items={state.forProjectFilter} />
      <ChatFilterBar
        filters={state.filters}
        counts={state.counts}
        onFilters={state.setFilters}
        status={{ ...status, checking }}
      />
      {state.loaded && state.accounts.length === 0 && state.total === 0 ? (
        <EmptySheet>No Teams Account connected yet. Connect one in Settings → Accounts (,).</EmptySheet>
      ) : (
        <PickBadgeProvider value={badges.open}>
          <div className={cn('flex-1', open && 'grid grid-cols-[minmax(0,5fr)_minmax(0,11fr)]')}>
            <div className="min-w-0 pb-30">
              <div className="sticky top-(--body) z-2 flex h-[30px] items-center justify-between border-b border-line bg-sheet pr-4 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink">
                <span className="whitespace-nowrap">
                  Chats · {String(state.chats.length).padStart(2, '0')}
                </span>
                {!open && <span className="font-medium text-faint">Mentions, unread, then newest · J K</span>}
              </div>
              {state.chats.length ? (
                <ul className="m-0 list-none p-0">
                  {state.chats.map((chat, index) => (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      number={index + 1}
                      me={state.meIn(chat)}
                      selected={chat.id === selected?.id}
                      onOpen={() => openChat(chat.id)}
                    />
                  ))}
                </ul>
              ) : (
                state.loaded && (
                  <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
                    {state.filters.unreadOnly ? 'No unread chats here.' : 'No chats here.'}
                  </p>
                )
              )}
            </div>
            {open && (
              <ChatView
                chat={selected}
                me={selected ? state.meIn(selected) : null}
                focus={state.focus}
                accountName={accountName(selected)}
                links={state.links}
                history={state.history}
                now={now.getTime()}
                onFile={file}
                onMute={() =>
                  selected && void state.changeSetting(selected, selected.muted ? 'unmute' : 'mute')
                }
                onExclude={() => setExcluding(selected)}
                onClose={() => setOpen(false)}
                onOpenLink={openLink}
                outgoing={selected ? state.outgoingFor(selected) : []}
                waiting={selected ? state.waitingFor(selected) : null}
                onRetry={() => selected && state.retry(selected)}
                onToggleRead={canToggleRead(selected) ? () => void toggleRead() : null}
                reply={
                  selected && (
                    <>
                      {chatWork.reply && (
                        <ReplySuggestionCard
                          suggestion={chatWork.reply}
                          sources={sourcesOf(selected)}
                          onSend={() =>
                            chatWork.reply && void sendSuggestedReply(selected, chatWork.reply.proposalId)
                          }
                          onEdit={() =>
                            chatWork.reply &&
                            editSuggestedReply(selected, chatWork.reply.proposalId, chatWork.reply.reply.text)
                          }
                          onDismiss={() => chatWork.reply && void chatWork.dismiss(chatWork.reply.proposalId)}
                        />
                      )}
                      <ReplyBox
                        to={selected.title}
                        draft={draftOf(selected)}
                        onDraft={(text) => setDraft(selected.id, text)}
                        onSend={() => void sendReply()}
                        onAskAres={work ? () => void askForDraft() : undefined}
                        drafting={chatWork.drafting}
                      />
                    </>
                  )
                }
                afterMessage={(message) =>
                  selected &&
                  chatWork.todosByMessage
                    .get(message.id)
                    ?.map((suggestion) => (
                      <TodoSuggestionCard
                        key={suggestion.proposalId}
                        suggestion={suggestion}
                        sources={sourcesOf(selected)}
                        onAdd={() => void addTodo(suggestion.proposalId, suggestion.title)}
                        onDismiss={() => void chatWork.dismiss(suggestion.proposalId)}
                      />
                    ))
                }
                actions={summariser && <SummariseButton state={summary} />}
                ares={
                  selected && (
                    <>
                      <WaitingNote chat={selected} onNotWaiting={() => void notWaiting(selected)} />
                      <SummaryPanel state={summary} />
                    </>
                  )
                }
              />
            )}
          </div>
        </PickBadgeProvider>
      )}
      {badges.picker}
      <ExcludeDialog
        chat={excluding}
        onCancel={() => setExcluding(null)}
        onConfirm={(chat) => {
          setExcluding(null);
          void state.changeSetting(chat, 'exclude');
        }}
      />
    </SectionSheet>
  );
}

// Opening the Section asks every Teams Account for a light sync (the sync engine's refresh); the
// Chats are read again whenever it comes into view.
function useRefreshWhenOpened(refresh: () => void, reload: () => void) {
  const { active } = useSection();
  const wasActive = useRef(false);
  useEffect(() => {
    if (active && !wasActive.current) {
      refresh();
      reload();
    }
    wasActive.current = active;
  }, [active, refresh, reload]);
  const onFocus = useCallback(() => reload(), [reload]);
  useEffect(() => {
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);
}
