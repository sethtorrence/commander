import { type ActivityEntry, channelPlace, type OutgoingChange, REPLY_FIELD } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import type { ReactNode } from 'react';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { ItemBadge, ItemProject, waitingSuggestion } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { Eyebrow, PanePart } from '../todos/detail/parts';
import { TodoLinks } from '../todos/detail/TodoLinks';
import { whenShort } from '../todos/when';
import { action, CouldntSync, Message, Reply } from './ChatView';
import type { ChannelPost } from './channel-posts';
import { OutLink } from './MessageText';
import { type ChatLink, describeChatEntry } from './teams-chats';
import type { MessageFocus } from './use-teams';

/*
  A Channel post opened beside the list (#111): Open in Teams, Project and Back along the top; where
  it was posted, its subject, the post and its replies (as a Chat's messages: text only, untrusted
  Source content shown by MessageText, ADR 0004); replies written here on their way to Teams; the
  reply box, which posts to the post's replies; and the side panel with its Project, Links and
  activity log.
*/

const isWebAddress = (url: string | null): url is string => !!url && /^https?:\/\//i.test(url);

export function PostView({
  post,
  me,
  focus,
  accountName,
  links,
  history,
  outgoing,
  waiting,
  onFile,
  onClose,
  onOpenLink,
  onRetry,
  reply,
}: {
  post: ChannelPost;
  /** The User's Teams user id in the post's Account. */
  me: string | null;
  focus: MessageFocus | null;
  accountName: string | null;
  links: ChatLink[];
  history: ActivityEntry[];
  outgoing: OutgoingChange[];
  waiting: string | null;
  onFile: () => void;
  onClose: () => void;
  onOpenLink: (link: ChatLink) => void;
  onRetry: () => void;
  /** The reply box. */
  reply: ReactNode;
}) {
  const { projects, archived, projectOf } = useProjects();
  const project = projectOf(post.filing);
  const { detail } = post;
  const webUrl = isWebAddress(detail.webUrl) ? detail.webUrl : null;
  const focused = (id: string) => (focus?.messageId === id ? focus : null);
  return (
    <section
      tabIndex={-1}
      aria-label="Channel post"
      className="min-w-0 border-l border-line focus-visible:outline-none"
    >
      <div className="sticky top-(--body) flex max-h-[calc(100vh-var(--body))] flex-col">
        <div className="z-2 flex h-11 min-w-0 flex-none items-stretch overflow-x-auto border-b border-line bg-sheet [scrollbar-width:none]">
          {webUrl && (
            <OutLink href={webUrl} className={cn(action, 'bg-ink text-sheet hover:bg-ink hover:opacity-90')}>
              Open in Teams <span aria-hidden="true">↗</span>
            </OutLink>
          )}
          <button type="button" onClick={onFile} className={action}>
            <Kbd>B</Kbd>
            Project
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={cn(action, 'border-r-0 border-l')}>
            <Kbd>Esc</Kbd>
            Back to the list
          </button>
        </div>
        <div className="grid min-h-80 flex-1 grid-cols-[minmax(0,1fr)_clamp(160px,38%,280px)]">
          <div className="min-w-0 overflow-auto px-[22px] pt-[18px] pb-24 [scrollbar-width:thin]">
            <Eyebrow>
              {channelPlace(detail)} · Teams{accountName && ` · ${accountName}`}
            </Eyebrow>
            <h2 className="mt-2 mb-1.5 font-sans text-[26px] leading-[1.15] font-bold tracking-[-0.015em] text-ink font-stretch-(--stretch-wide) [overflow-wrap:anywhere]">
              {post.title}
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {waitingSuggestion(post) && <ItemProject item={post} />}
              <ItemWarning item={post} variant="pane" />
              <AskAres item={post} variant="pane" />
            </div>
            <section aria-label="Post" className="mt-[18px]">
              <ol className="m-0 list-none border border-line p-0">
                <Message message={detail.post} me={me} webUrl={webUrl} focus={focused(detail.post.id)} />
              </ol>
            </section>
            <section aria-label="Replies" className="mt-[18px]">
              <Eyebrow className="mb-2 flex items-center gap-2.5">
                {detail.replies.length === 1 ? '1 reply' : `${detail.replies.length} replies`}
                <span className="h-px flex-1 bg-line" />
              </Eyebrow>
              {detail.replies.length ? (
                <ol className="m-0 list-none border border-line p-0">
                  {detail.replies.map((message) => (
                    <Message
                      key={message.id}
                      message={message}
                      me={me}
                      webUrl={webUrl}
                      focus={focused(message.id)}
                    />
                  ))}
                </ol>
              ) : (
                <p className="hatch m-0 border border-line px-2.5 py-2 text-note text-faint">
                  No replies yet.
                </p>
              )}
            </section>
            {detail.pending?.length ? (
              <section aria-label="On its way to Teams" className="mt-[18px]">
                <Eyebrow className="mb-2 flex items-center gap-2.5">
                  On its way to Teams
                  <span className="h-px flex-1 bg-line" />
                </Eyebrow>
                <ol className="m-0 list-none border border-line p-0">
                  {detail.pending.map((each) => (
                    <Reply
                      key={each.clientId}
                      reply={each}
                      change={outgoing.find((change) => change.field === `${REPLY_FIELD}${each.clientId}`)}
                      waiting={waiting}
                      onRetry={onRetry}
                    />
                  ))}
                </ol>
              </section>
            ) : null}
            {outgoing
              .filter((change) => change.status === 'failed' && !change.field.startsWith(REPLY_FIELD))
              .map((change) => (
                <CouldntSync key={change.field} change={change} onRetry={onRetry} />
              ))}
            {reply}
          </div>
          <aside
            aria-label="About this post"
            className="min-w-0 overflow-auto border-l border-line2 px-4 pt-[18px] pb-24 [scrollbar-width:thin]"
          >
            <Eyebrow>Project</Eyebrow>
            <button
              type="button"
              onClick={onFile}
              className="mt-2 flex w-full cursor-pointer items-center gap-[9px] border border-line bg-transparent px-2.5 py-1.5 text-left text-note text-text hover:bg-raise"
            >
              <ItemBadge filing={post.filing} suggestion={waitingSuggestion(post)} />
              {project ? project.name : 'Unfiled'}
            </button>
            <TodoLinks links={links} onOpen={onOpenLink} />
            <PanePart label="Activity" count={history.length}>
              <ol className="m-0 list-none border border-line p-0">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
                  >
                    <span className="text-text">
                      {describeChatEntry(entry, history, [...projects, ...archived], outgoing)}
                    </span>
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      className="font-mono text-label-lg leading-[18px] whitespace-nowrap text-muted tabular-nums"
                    >
                      {whenShort(entry.at)}
                    </time>
                  </li>
                ))}
              </ol>
            </PanePart>
          </aside>
        </div>
      </div>
    </section>
  );
}
