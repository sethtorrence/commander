// Runs the email sanitiser (#134) off the Core's own thread, one message at a time, with a hard time
// limit: email HTML comes from anyone, and no message may stall the Core (syncing, Ares, the Item
// store all run there). A message that takes longer than the limit is given up on (it is read as
// text instead) and its worker thread is terminated; the next message gets a fresh one.
import { Worker } from 'node:worker_threads';
import { emailImageUrl, emailPartUrl } from '@commander/domain';
import { type SanitizedEmail, sanitizeEmailHtml, TooComplex } from './sanitize';

export type SanitiseRequest = { html: string; images: 'shown' | 'held'; quotes: boolean; token: string };
export type SanitiseJob = SanitiseRequest & { id: number };
export type SanitiseOutcome =
  | { id: number; ok: true; result: SanitizedEmail }
  | { id: number; ok: false; tooComplex: boolean; error: string };

/** Sanitises a message for the reader's frame; rejects with TooComplex when it can't in time. */
export type Sanitise = (request: SanitiseRequest) => Promise<SanitizedEmail>;

/** In this thread, with no time limit (tests). */
export const sanitiseHere: Sanitise = async ({ html, images, quotes, token }) =>
  sanitizeEmailHtml(html, {
    images,
    quotes,
    imageUrl: (index) => emailImageUrl(token, index),
    partUrl: (contentId) => emailPartUrl(token, contentId),
  });

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  on(event: 'message', listener: (outcome: SanitiseOutcome) => void): unknown;
  on(event: 'error' | 'exit', listener: (value: unknown) => void): unknown;
};

/** In a worker thread (`createWorker`), one message at a time, each within `timeoutMs`. */
export function sanitiseInWorker(
  createWorker: () => WorkerLike,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): { sanitise: Sanitise; stop(): void } {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();
  let current: { id: number; settle: (outcome: SanitiseOutcome | Error) => void } | null = null;

  const workerOf = (): WorkerLike => {
    if (worker) return worker;
    const started = createWorker();
    started.on('message', (outcome: SanitiseOutcome) => {
      if (worker === started && current && outcome.id === current.id) current.settle(outcome);
    });
    // Only the thread in use fails the message under way (one stopped for being slow is done with).
    const lost = (value: unknown) => {
      if (worker !== started) return;
      worker = null;
      current?.settle(new Error(`The sanitiser stopped: ${String(value)}`));
    };
    started.on('error', lost);
    started.on('exit', lost);
    worker = started;
    return started;
  };

  const run = (request: SanitiseRequest): Promise<SanitizedEmail> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const thread = workerOf();
      const timer = setTimeout(() => {
        // Too slow: stop this thread (the next message starts another).
        if (worker === thread) worker = null;
        void thread.terminate();
        settle(new TooComplex('This message’s HTML took too long to prepare.'));
      }, timeoutMs);
      const settle = (outcome: SanitiseOutcome | Error) => {
        if (current?.id !== id) return;
        current = null;
        clearTimeout(timer);
        if (outcome instanceof Error) reject(outcome);
        else if (outcome.ok) resolve(outcome.result);
        else reject(outcome.tooComplex ? new TooComplex(outcome.error) : new Error(outcome.error));
      };
      current = { id, settle };
      thread.postMessage({ ...request, id } satisfies SanitiseJob);
    });

  return {
    sanitise(request) {
      const job = queue.then(() => run(request));
      queue = job.catch(() => null);
      return job;
    },
    stop() {
      void worker?.terminate();
      worker = null;
    },
  };
}

/** The Core's sanitiser: a worker thread running the bundled sanitise-worker.js. */
export const workerSanitiser = (path: string, timeoutMs?: number) =>
  sanitiseInWorker(() => new Worker(path) as unknown as WorkerLike, { timeoutMs });
