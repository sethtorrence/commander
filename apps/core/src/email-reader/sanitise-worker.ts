// The email sanitiser's worker thread (#134): sanitises one message at a time for the Core, so a
// message that is slow to sanitise never stalls the Core, and one that takes too long is stopped
// (sanitiser.ts terminates this thread and starts another). Built as its own file next to the
// bundled Core (see electron.vite.config.ts).
import { parentPort } from 'node:worker_threads';
import { emailImageUrl, emailPartUrl } from '@commander/domain';
import type { SanitiseJob, SanitiseOutcome } from './sanitiser';
import { sanitizeEmailHtml, TooComplex } from './sanitize';

parentPort?.on('message', (job: SanitiseJob) => {
  let outcome: SanitiseOutcome;
  try {
    outcome = {
      id: job.id,
      ok: true,
      result: sanitizeEmailHtml(job.html, {
        images: job.images,
        quotes: job.quotes,
        imageUrl: (index) => emailImageUrl(job.token, index),
        partUrl: (contentId) => emailPartUrl(job.token, contentId),
      }),
    };
  } catch (error) {
    outcome = {
      id: job.id,
      ok: false,
      tooComplex: error instanceof TooComplex,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort?.postMessage(outcome);
});
