// Settings → Diagnostics and Export diagnostics (#207), in the main process. The window asks for the
// report (recent sync runs and the database's version, from the Core) and for the export, which only
// the main process makes:
//
// - The file comes from the system save picker. The window never names a path.
// - It works while the Core is down (when diagnostics matter most): the export then says the Core
//   didn't answer and carries the rest, the log included.
// - Before it is written, every line is blanked (diagnostics-file.ts), and the Core checks the lines
//   for any token or key it holds; a line holding one is left out whole.
import { writeFileSync } from 'node:fs';
import { leftOut, readLogs } from '@commander/core/src/logs/log-file';
import {
  type CoreDiagnosticsReply,
  type CoreDiagnosticsRequest,
  type CoreStatus,
  coreDiagnosticsReply,
  type Diagnostics,
  type DiagnosticsReport,
  type DiagnosticsResponse,
  diagnosticsRequest,
} from '@commander/domain';
import { blankExport, diagnosticsFile, EXPORTED_LOG_LINES } from './diagnostics-file';

type CoreRequest = CoreDiagnosticsRequest['request'];
type CoreResponse = CoreDiagnosticsReply['response'];

const TIMEOUT_MS = 10_000;

/** The export's suggested file name, in local time: commander-diagnostics-2026-10-06-1402.md. */
export function exportFileName(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `commander-diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.md`;
}

export function createDiagnosticsChannel(options: {
  send(message: CoreDiagnosticsRequest): void;
  // Runs a request to the Core only while it runs (core-supervisor.ts): at once with a reason when not.
  whileCoreRuns<R>(run: () => Promise<R>): Promise<R | { ok: false; error: string }>;
  // The logs folder (log-file.ts).
  logsDir: string;
  // Versions, the display server and the password store.
  about(): Promise<Diagnostics>;
  coreStatus(): CoreStatus | null;
  // Shows the system save picker with the suggested name; the path chosen, or null when cancelled.
  chooseFile(suggested: string): Promise<string | null>;
  now?: () => number;
  // Where an export is told (the log).
  log?: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (response: CoreResponse | null) => void; timer: NodeJS.Timeout }
  >();

  // Asks the Core; null when it is down or didn't answer in time.
  async function ask(request: CoreRequest): Promise<CoreResponse | null> {
    const answer = await options.whileCoreRuns(
      () =>
        new Promise<CoreResponse | null>((resolve) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve(null);
          }, TIMEOUT_MS);
          pending.set(id, { resolve, timer });
          options.send({ type: 'diagnostics-request', id, request });
        }),
    );
    return answer && 'op' in answer ? answer : null;
  }

  async function report(): Promise<DiagnosticsReport | null> {
    const answer = await ask({ op: 'report' });
    return answer?.op === 'report' ? answer.report : null;
  }

  // The export's text, blanked, with any line holding a token or key the Core knows left out.
  async function checked(text: string): Promise<string> {
    const lines = blankExport(text);
    const answer = await ask({ op: 'check', lines });
    const held = new Set(answer?.op === 'check' ? answer.held : []);
    return lines.map((line, index) => (held.has(index) ? leftOut(line) : line)).join('\n');
  }

  return {
    // A request from the window.
    async request(raw: unknown): Promise<DiagnosticsResponse> {
      const parsed = diagnosticsRequest.safeParse(raw);
      if (!parsed.success)
        return { ok: false, error: `Rejected diagnostics request: ${parsed.error.message}`, report: null };
      if (parsed.data.op === 'report') return { ok: true, report: await report() };

      const path = await options.chooseFile(exportFileName(now()));
      if (!path) return { ok: true, report: null, exported: null };
      const [about, current] = await Promise.all([options.about(), report()]);
      const text = diagnosticsFile({
        at: now(),
        about,
        core: options.coreStatus(),
        report: current,
        logs: readLogs(options.logsDir, { limit: EXPORTED_LOG_LINES }),
      });
      try {
        writeFileSync(path, await checked(text), { mode: 0o600 });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.log?.(`Export diagnostics couldn’t write its file: ${reason}`);
        return { ok: false, error: `Commander couldn’t write the file: ${reason}`, report: current };
      }
      options.log?.('Exported diagnostics');
      return { ok: true, report: current, exported: path };
    },

    // A message from the Core. Returns true when it was a diagnostics reply, handled here.
    settle(raw: unknown): boolean {
      const parsed = coreDiagnosticsReply.safeParse(raw);
      if (!parsed.success) return false;
      const waiting = pending.get(parsed.data.id);
      if (waiting) {
        pending.delete(parsed.data.id);
        clearTimeout(waiting.timer);
        waiting.resolve(parsed.data.response);
      }
      return true;
    },
  };
}
