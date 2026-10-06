import type { ComposeBody } from '@commander/domain';
import { toast } from '@commander/ui';
import { useEffect, useRef, useState } from 'react';
import type { ComposeClient } from './compose';
import { RichEditor } from './RichEditor';

/*
  An email Account's signature (#138), in Settings → Accounts: one per Account, stored in Commander
  (Graph can't read Outlook's), with the composer's simple formatting. It goes below new mail, replies
  and forwards, where it can be edited for that message. Saved after a pause in typing.
*/

export const SIGNATURE_PAUSE_MS = 800;

export function SignatureSetting({ client, account }: { client: ComposeClient; account: string }) {
  const [signature, setSignature] = useState<ComposeBody | null>(null);
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<ComposeBody>([]);

  useEffect(() => {
    let alive = true;
    client.signature(account).then(
      (found) => alive && setSignature(found),
      () => alive && setSignature([]),
    );
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [client, account]);

  const save = async () => {
    timer.current = null;
    try {
      await client.saveSignature(account, latest.current);
      setStatus('Saved');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };

  if (!signature) return null;
  return (
    <div data-testid="signature" className="mt-3 border border-line2">
      <div className="flex items-center justify-between border-b border-line2 px-3 py-1.5 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted">
        <span>Signature</span>
        <span role="status" className="text-faint">
          {status}
        </span>
      </div>
      <RichEditor
        initial={signature}
        label={`Signature for ${account}`}
        className="[&_[role=textbox]]:min-h-[72px]"
        onChange={(body) => {
          latest.current = body;
          setStatus('');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(), SIGNATURE_PAUSE_MS);
        }}
      />
    </div>
  );
}
