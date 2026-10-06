import { type SearchByMeaningStatus, searchByMeaningOn, type searchByMeaningStates } from '@commander/domain';
import type { EmbeddingProviderAdapter, Embeddings, EmbedRequest } from '@commander/models';
import type { ItemStore, QueryVector } from '../item-store';
import type { DownloadProgress } from './download';
import type { Embedder } from './embedder';
import { downloadBytes, type EmbeddingModel } from './model';

/*
  Search by meaning in the Core (#73). The embedding model runs on this machine: nothing is ever sent
  anywhere, and the only connection is the one-time download of its files.

  - Getting the model: on first use (search by meaning is on unless the User turns it off in
    Settings → Ares), its files are downloaded into Commander's data folder with progress, resumably
    and checked (download.ts), then loaded in a worker thread (embedder.ts). A failed download is
    tried again later, or at once when switched on again.
  - Until it is ready, search is by words alone: nothing waits for it. Word results come from the
    Item store's search at once; the palette then asks again with meaning (`queryVector`).
  - Keeping embeddings current: once ready, every Item and memory is embedded in the background, a
    few at a time with a pause between, most recently changed first, and again whenever one is saved
    with new words (the Item store says so). Embedding gives way to the palette: while the User is
    searching, the backfill waits. When the machine is idle, a catch-up pass fills any gaps.
  - Every embedding goes through the model client's `embed`, so each call is on the Usage page.
*/

type State = (typeof searchByMeaningStates)[number];

export type MeaningTiming = {
  // Between batches of the backfill.
  pauseMs: number;
  // After a save, before embedding what it changed (saves come in bursts).
  pendingDelayMs: number;
  // Before trying a failed download or load again.
  retryMs: number;
  // The longest a query waits for its embedding before search goes on with words alone.
  queryTimeoutMs: number;
  // After the User searched, the backfill waits this long, so their next query isn't queued behind it.
  quietAfterQueryMs: number;
};

const DEFAULT_TIMING: MeaningTiming = {
  pauseMs: 150,
  pendingDelayMs: 2000,
  retryMs: 15 * 60_000,
  queryTimeoutMs: 2000,
  quietAfterQueryMs: 1500,
};

// How many Items are asked for at once, and how many go to the model in one call.
// Four at a time keeps the model's working memory small (eight long texts at once take ~750 MB
// more); a page is embedded shortest first, so texts of a size share a batch and pad less.
const PENDING_PAGE = 64;
const BATCH = 4;

// Words that are an identifier (ENG-418, acme/api#12) say nothing a model can mean.
const IDENTIFIER = /[\p{L}\p{N}_.-]*#\d+|\b\p{L}{1,10}-\d+\b/gu;
const MEANINGFUL_WORD = /\p{L}{3,}/u;

/** Whether what was typed is worth embedding: at least one real word of three letters or more. */
export const worthMeaning = (text: string) => MEANINGFUL_WORD.test(text.replace(IDENTIFIER, ' '));

export type MeaningOptions = {
  store: Pick<ItemStore, 'meaning' | 'models'>;
  model: EmbeddingModel;
  // Whether every file is already there.
  downloaded: () => boolean;
  download: (options: {
    onProgress: (progress: DownloadProgress) => void;
    signal: AbortSignal;
  }) => Promise<void>;
  load: () => Promise<Embedder>;
  // The model client's embed (which logs each call).
  embed: (request: EmbedRequest) => Promise<Embeddings>;
  timing?: Partial<MeaningTiming>;
  log?: (message: string) => void;
};

export type Meaning = {
  start(): void;
  status(): SearchByMeaningStatus;
  // Settings → Ares: on downloads (or retries) and loads; off stops and frees the model.
  setOn(on: boolean): SearchByMeaningStatus;
  // What was typed, embedded, for search by meaning; null while the model isn't ready, for text not
  // worth embedding, or when embedding takes too long. `job` names the call on the Usage page.
  queryVector(text: string, job?: string): Promise<QueryVector | null>;
  // The embedding model for the model client, while it is loaded.
  adapter(): EmbeddingProviderAdapter | null;
  // The machine is idle: embed anything still missing.
  catchUp(): void;
  stop(): Promise<void>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function setUpMeaning(options: MeaningOptions): Meaning {
  const { store, model } = options;
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const log = options.log ?? ((line: string) => console.warn(line));

  const isOn = () => searchByMeaningOn(store.models.settings());
  // On, it is waiting to start (the Core starts it a little after start-up).
  let state: State = isOn() ? 'waiting' : 'off';
  let problem: string | null = null;
  let progress: DownloadProgress = { receivedBytes: 0, totalBytes: downloadBytes(model) };
  let embedder: Embedder | null = null;
  let abort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let indexing = false;
  let again = false;
  let lastQueryAt = 0;
  let stopped = false;
  // Bumped whenever it is switched off or stopped, so work started before stops.
  let generation = 0;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const adapter = (): EmbeddingProviderAdapter | null => {
    const loaded = embedder;
    if (state !== 'ready' || !loaded) return null;
    return { provider: 'local', model: model.id, embed: (texts) => loaded.embed(texts) };
  };

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (state === 'failed') void bringUp();
    }, timing.retryMs);
  }

  // Downloads (if need be) and loads the model, then embeds what is missing.
  async function bringUp() {
    if (stopped || !isOn() || state === 'downloading' || state === 'loading' || state === 'ready') return;
    const mine = generation;
    problem = null;
    try {
      if (!options.downloaded()) {
        state = 'downloading';
        abort = new AbortController();
        await options.download({
          signal: abort.signal,
          onProgress: (now) => {
            progress = now;
          },
        });
        abort = null;
      }
      if (mine !== generation) return;
      state = 'loading';
      const loaded = await options.load();
      if (mine !== generation) {
        await loaded.close();
        return;
      }
      embedder = loaded;
      state = 'ready';
      log(`Search by meaning is ready (${model.name}).`);
      void index();
    } catch (error) {
      abort = null;
      if (mine !== generation) return;
      state = 'failed';
      problem = message(error);
      log(`Search by meaning couldn’t get its model ready: ${problem}`);
      scheduleRetry();
    }
  }

  // Embeds everything waiting, a batch at a time, until nothing is left (or it is switched off).
  async function index() {
    if (indexing) {
      again = true;
      return;
    }
    indexing = true;
    const mine = generation;
    try {
      do {
        again = false;
        for (;;) {
          if (mine !== generation || state !== 'ready') return;
          const work = store.meaning
            .pending(model.id, PENDING_PAGE)
            .sort((a, b) => a.text.length - b.text.length);
          if (!work.length) break;
          for (let i = 0; i < work.length; i += BATCH) {
            // The User is searching: let their queries go first.
            while (Date.now() - lastQueryAt < timing.quietAfterQueryMs && mine === generation) {
              await sleep(timing.quietAfterQueryMs - (Date.now() - lastQueryAt));
            }
            if (mine !== generation || state !== 'ready') return;
            const batch = work.slice(i, i + BATCH);
            const { vectors } = await options.embed({
              job: 'embed-index',
              texts: batch.map((each) => each.text),
            });
            if (mine !== generation) return;
            store.meaning.save(
              model.id,
              batch.map((each, n) => ({ ...each, vector: vectors[n] as Float32Array })),
            );
            await sleep(timing.pauseMs);
          }
        }
      } while (again);
    } catch (error) {
      // The model stopped working (its worker died, say): search goes on by words, and the model is
      // loaded again later (its files are already here).
      if (mine === generation) {
        problem = message(error);
        log(`Search by meaning stopped embedding, and will load its model again later: ${problem}`);
        state = 'failed';
        const broken = embedder;
        embedder = null;
        void broken?.close().catch(() => {});
        scheduleRetry();
      }
    } finally {
      indexing = false;
    }
  }

  // Something new waits to be embedded: soon, once a burst of saves has settled.
  const stopListening = store.meaning.onPending(() => {
    if (state !== 'ready') return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void index();
    }, timing.pendingDelayMs);
  });

  async function takeDown() {
    generation += 1;
    abort?.abort();
    abort = null;
    if (retryTimer) clearTimeout(retryTimer);
    if (pendingTimer) clearTimeout(pendingTimer);
    retryTimer = null;
    pendingTimer = null;
    const loaded = embedder;
    embedder = null;
    await loaded?.close();
  }

  function status(): SearchByMeaningStatus {
    const counts = store.meaning.progress(model.id);
    return {
      on: isOn(),
      state,
      model: { name: model.name, downloadBytes: downloadBytes(model) },
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      embedded: counts.embedded,
      total: counts.total,
      problem,
    };
  }

  return {
    start() {
      if (isOn()) {
        state = 'waiting';
        void bringUp();
      }
    },

    status,

    setOn(on) {
      const settings = store.models.settings();
      if (settings.searchByMeaning !== on) store.models.saveSettings({ ...settings, searchByMeaning: on });
      if (!on) {
        state = 'off';
        problem = null;
        void takeDown();
      } else if (state === 'off' || state === 'failed') {
        state = 'waiting';
        void bringUp();
      }
      return status();
    },

    async queryVector(text, job = 'embed-query') {
      if (state !== 'ready' || !worthMeaning(text)) return null;
      lastQueryAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const embedded = await Promise.race([
          options.embed({ job, texts: [text] }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timing.queryTimeoutMs);
          }),
        ]);
        const vector = embedded?.vectors[0];
        return vector
          ? { model: model.id, vector, minSimilarity: model.minSimilarity, margin: model.margin }
          : null;
      } catch (error) {
        log(`Search by meaning couldn’t embed a query: ${message(error)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    adapter,

    catchUp() {
      if (state === 'ready') void index();
      else if (state === 'failed') void bringUp();
    },

    async stop() {
      stopped = true;
      stopListening();
      await takeDown();
    },
  };
}
