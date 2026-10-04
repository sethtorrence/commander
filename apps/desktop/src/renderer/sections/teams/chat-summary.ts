import type { ChatSummary, SummaryRange } from '@commander/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdatesClient } from '../../updates/updates';

/*
  Summarise in the Chat view (#109): Ares summarises the open Chat over a range of its messages,
  since the User last read it (the default), today or this week. The request goes to the Core's
  Summarise Skill through the Updates bridge; the summary is Ares's words, shown through AresText.
*/

export interface ChatSummariser {
  summarise(itemId: string, range: SummaryRange): Promise<ChatSummary>;
}

export function chatSummariserIn(updates: UpdatesClient): ChatSummariser {
  return { summarise: (itemId, range) => updates({ op: 'summarise-chat', itemId, range }) };
}

export interface ChatSummaryState {
  /** Whether the summary panel is open for the Chat. */
  open: boolean;
  range: SummaryRange;
  /** The summary for the range, once Ares has made it. */
  summary: ChatSummary | null;
  busy: boolean;
  problem: string | null;
  /** Summarises the Chat (again) over the range shown: at first, "since I last read". */
  summarise(): void;
  /** Shows another range's summary, making it if Ares hasn't yet. */
  show(range: SummaryRange): void;
  close(): void;
}

/**
 * The open Chat's summaries, one per range, made when asked for and kept while the Chat stays open
 * (switching back to a range shows it again). Another Chat starts afresh.
 */
export function useChatSummary(
  summariser: ChatSummariser | undefined,
  chatId: string | null,
): ChatSummaryState {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<SummaryRange>('since-read');
  const [made, setMade] = useState<Partial<Record<SummaryRange, ChatSummary>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef(chatId);

  useEffect(() => {
    current.current = chatId;
    setOpen(false);
    setRange('since-read');
    setMade({});
    setBusy(false);
    setProblem(null);
  }, [chatId]);

  const make = useCallback(
    (next: SummaryRange) => {
      if (!summariser || !chatId) return;
      setOpen(true);
      setRange(next);
      setProblem(null);
      setBusy(true);
      summariser.summarise(chatId, next).then(
        (summary) => {
          if (current.current !== chatId) return;
          setMade((was) => ({ ...was, [next]: summary }));
          setBusy(false);
        },
        (error) => {
          if (current.current !== chatId) return;
          setProblem(error instanceof Error ? error.message : String(error));
          setBusy(false);
        },
      );
    },
    [summariser, chatId],
  );

  const summarise = useCallback(() => make(range), [make, range]);
  const show = useCallback(
    (next: SummaryRange) => {
      if (made[next]) {
        setRange(next);
        setProblem(null);
      } else make(next);
    },
    [made, make],
  );

  return {
    open,
    range,
    summary: made[range] ?? null,
    busy,
    problem,
    summarise,
    show,
    close: useCallback(() => setOpen(false), []),
  };
}
