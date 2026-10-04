import type { AgentJobsState, AresStatus, CoreMessage } from '@commander/domain';
import { useEffect, useState } from 'react';

type JobsClient = (request: { op: 'jobs' }) => Promise<AgentJobsState>;
type CoreMessages = (listener: (message: CoreMessage) => void) => () => void;

const IDLE: AresStatus = { working: false, running: [] };

/**
 * Whether Ares is working (one of his jobs running) or idle: asked of the Core once, then kept up to
 * date from its `ares-status` word as jobs start and finish.
 */
export function useAresStatus(
  client: JobsClient | undefined = window.commander?.autonomy,
  onCoreMessage: CoreMessages | undefined = window.commander?.onCoreMessage,
): AresStatus {
  const [status, setStatus] = useState<AresStatus>(IDLE);
  useEffect(() => {
    let heard = false;
    // Only a real change re-renders the frame.
    const update = (next: AresStatus) =>
      setStatus((was) =>
        was.working === next.working && was.running.join('\n') === next.running.join('\n')
          ? was
          : { working: next.working, running: next.running },
      );
    const stop = onCoreMessage?.((message) => {
      if (message.type !== 'ares-status') return;
      heard = true;
      update(message);
    });
    client?.({ op: 'jobs' }).then(
      (state) => {
        if (!heard) update(state.status);
      },
      () => {},
    );
    return stop;
  }, [client, onCoreMessage]);
  return status;
}
