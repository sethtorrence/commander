import type { MarkdownCopyRequest, MarkdownCopyStatus } from '@commander/domain';
import { Button, Led } from '@commander/ui';
import { useCallback, useEffect, useState } from 'react';
import { Readout, ReadoutRow, SettingRow } from '../../settings/parts';

const STATE_LABELS: Record<MarkdownCopyStatus['state'], string> = {
  off: 'Off',
  writing: 'Writing…',
  ok: 'Up to date',
  failed: 'Not writing',
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Settings → Notes → Markdown copy folder: where the Core writes a read-only `YYYY-MM-DD.md` of each
 * day. The folder comes from the system picker (shown by the main process); a failing folder shows a
 * notice here, and never holds up editing.
 */
export function MarkdownCopySetting() {
  const [status, setStatus] = useState<MarkdownCopyStatus | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async (request: MarkdownCopyRequest) => {
    setBusy(true);
    try {
      const response = await window.commander.markdownCopy(request);
      if (response.status) setStatus(response.status);
      setRefused(response.ok ? null : response.error);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void ask({ op: 'status' });
    return window.commander.onCoreMessage((message) => {
      if (message.type === 'markdown-copy-status') setStatus(message.status);
    });
  }, [ask]);

  const folder = status?.folder ?? null;
  return (
    <SettingRow
      label="Markdown copy folder"
      description="A read-only copy of each day as YYYY-MM-DD.md, for Obsidian, grep and backups. Commander writes only those files and their images, never reads or deletes anything else there, and overwrites edits made to them."
    >
      <div data-testid="markdown-copy" className="max-w-[560px]">
        <Readout>
          <ReadoutRow label="Folder">
            <code
              data-testid="markdown-copy-folder"
              className="font-mono break-all normal-case tracking-normal"
            >
              {status ? (folder ?? 'None chosen') : '…'}
            </code>
          </ReadoutRow>
          <ReadoutRow label="Copy" live={status?.state === 'failed'}>
            {status && (
              <Led
                size="sm"
                state={status.state === 'failed' ? 'on' : status.state === 'off' ? 'off' : 'muted'}
              />
            )}
            <span data-testid="markdown-copy-state" className="normal-case tracking-normal">
              {status ? STATE_LABELS[status.state] : '…'}
              {status?.state === 'ok' && status.lastWrittenAt ? ` · ${time(status.lastWrittenAt)}` : ''}
            </span>
          </ReadoutRow>
        </Readout>
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || !status} onClick={() => void ask({ op: 'choose-folder' })}>
            {folder ? 'Change folder…' : 'Choose folder…'}
          </Button>
          {folder && (
            <Button disabled={busy} onClick={() => void ask({ op: 'turn-off' })}>
              Turn off
            </Button>
          )}
        </div>
        {refused && (
          <p
            data-testid="markdown-copy-refused"
            role="alert"
            className="m-0 mt-3 border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
          >
            {refused}
          </p>
        )}
        {status?.state === 'failed' && status.problem && (
          <p
            data-testid="markdown-copy-problem"
            role="alert"
            className="m-0 mt-3 border-l-2 border-signal py-0.5 pl-3.5 text-note leading-[19px] text-ink"
          >
            The Markdown copy isn’t being written. {status.problem} Editing carries on as usual, and Commander
            keeps trying.
          </p>
        )}
      </div>
    </SettingRow>
  );
}
