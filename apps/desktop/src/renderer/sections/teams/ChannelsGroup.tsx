import { channelPostAttention, threadOf } from '@commander/domain';
import { cn } from '@commander/ui';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { whenShort } from '../todos/when';
import { Mark } from './ChatRow';
import type { ChannelGroup, ChannelPost } from './channel-posts';
import { unseenCount } from './channel-posts';

/*
  The Teams Section's Channels group (#111), under the Chats: the posts of the channels the User's
  Accounts sync, by team then channel, each channel's posts by latest activity. A post's row: its
  Badge, title, an `@` while a message in it the User hasn't seen mentions them by name, New while
  anything in it from others is unseen (Commander's own mark: Teams keeps no read state for
  channels), and who wrote last, with the reply count. Shown only while some Account syncs Channel
  posts.
*/

const pad = (n: number) => String(n).padStart(2, '0');

function PostRow({
  post,
  me,
  selected,
  onOpen,
}: {
  post: ChannelPost;
  me: string | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const bar = useAccentBar(post.filing);
  const unseen = unseenCount(post, me);
  const mentioned = channelPostAttention(post, me) !== null;
  const thread = threadOf(post.detail).filter((message) => message.from && !message.deleted);
  const latest = thread.reduce<(typeof thread)[number] | null>(
    (newest, message) => (newest === null || message.createdAt >= newest.createdAt ? message : newest),
    null,
  );
  const replies = post.detail.replies.filter((reply) => !reply.deleted).length;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: opened from the keyboard through the list's buttons
    <li
      aria-current={selected || undefined}
      aria-label={post.title}
      data-testid="teams-channel-post"
      data-unseen={unseen > 0 || undefined}
      onClick={onOpen}
      className={cn(
        'relative cursor-default border-b border-line2 py-2.5 pr-4 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      <div className="flex items-center gap-2.5">
        <span className="flex h-5 w-[25px] flex-none items-center">
          <ItemBadge filing={post.filing} suggestion={post.filingSuggestion} />
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className={cn(
            'min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-row leading-5',
            unseen ? 'font-semibold text-ink' : 'font-medium text-text',
          )}
        >
          {post.title}
        </button>
        <span className="flex flex-none items-center gap-1.5">
          {mentioned && (
            <Mark title="A message you haven’t seen mentions you" strong>
              @
            </Mark>
          )}
          {unseen > 0 && <Mark title={`${unseen} you haven’t seen`}>New</Mark>}
          <ItemWarning item={post} />
          <AskAres item={post} />
        </span>
        <span className="ml-auto flex-none font-mono text-label-lg leading-5 tracking-mono text-muted tabular-nums">
          {whenShort(post.detail.lastActivityAt)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2.5 pl-[35px]">
        <span className="min-w-0 flex-1 truncate text-note leading-[18px] text-muted">
          {latest ? (
            <>
              <span className="font-semibold text-text">
                {me !== null && latest.from?.userId === me ? 'You' : latest.from?.name}:
              </span>{' '}
              {latest.text.split('\n').find((line) => line.trim()) ?? ''}
            </>
          ) : (
            <span className="text-faint">Deleted</span>
          )}
        </span>
        <span className="flex-none font-mono text-label leading-none text-muted">
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </span>
      </div>
    </li>
  );
}

export function ChannelsGroup({
  groups,
  meOf,
  selectedId,
  onOpen,
}: {
  groups: ChannelGroup[];
  /** The User's Teams user id in a post's Account. */
  meOf: (post: ChannelPost) => string | null;
  selectedId: string | null;
  onOpen: (post: ChannelPost) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.posts.length, 0);
  return (
    <section aria-label="Channels" data-testid="teams-channels">
      <div className="sticky top-(--body) z-2 flex h-[30px] items-center justify-between border-y border-line bg-sheet pr-4 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink">
        <span className="whitespace-nowrap">Channels · {pad(total)}</span>
        <span className="font-medium text-faint">By team and channel · latest activity</span>
      </div>
      {groups.length ? (
        groups.map((group) => (
          <section key={group.key} aria-label={`${group.team} / ${group.channel}`}>
            <h3 className="m-0 border-b border-line2 bg-raise py-1.5 pr-4 pl-13 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted">
              {group.team} / {group.channel}
            </h3>
            <ul className="m-0 list-none p-0">
              {group.posts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  me={meOf(post)}
                  selected={post.id === selectedId}
                  onOpen={() => onOpen(post)}
                />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="hatch m-0 border-b border-line2 py-2.5 pr-5 pl-13 text-note text-faint">
          No channel posts here yet. New posts come in with the next check of Teams.
        </p>
      )}
    </section>
  );
}
