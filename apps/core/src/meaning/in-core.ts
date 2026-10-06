import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Embeddings, EmbedRequest } from '@commander/models';
import type { ItemStore } from '../item-store';
import { downloadModel, modelDownloaded } from './download';
import { workerEmbedder } from './embedder';
import { FAKE_MODEL, fakeEmbedder } from './fake';
import { type Meaning, setUpMeaning } from './index';
import { GRANITE_97M } from './model';

/*
  Search by meaning as the Core runs it: the real model's files in `models/` in Commander's data
  folder, downloaded from Hugging Face (the pinned revision) and run in the worker thread built next
  to the Core. The end-to-end tests ask for the stand-in (`--embeddings=fake`): its "download" only
  pretends, with progress, so they never fetch the real model.
*/

const FAKE_STEPS = 4;
const FAKE_STEP_MS = 150;

export function meaningInCore({
  store,
  dataDir,
  fake,
  workerPath,
  embed,
}: {
  store: Pick<ItemStore, 'meaning' | 'models'>;
  dataDir: string;
  fake: boolean;
  workerPath: string;
  embed: (request: EmbedRequest) => Promise<Embeddings>;
}): Meaning {
  if (fake) {
    const marker = join(dataDir, 'models', 'stand-in', 'ready');
    const totalBytes = 10 * 1024 * 1024;
    return setUpMeaning({
      store,
      model: FAKE_MODEL,
      downloaded: () => existsSync(marker),
      download: async ({ onProgress }) => {
        for (let step = 1; step <= FAKE_STEPS; step++) {
          await new Promise((resolve) => setTimeout(resolve, FAKE_STEP_MS));
          onProgress({ receivedBytes: (totalBytes * step) / FAKE_STEPS, totalBytes });
        }
        mkdirSync(join(dataDir, 'models', 'stand-in'), { recursive: true });
        writeFileSync(marker, '');
      },
      load: async () => fakeEmbedder(),
      embed,
      timing: { pendingDelayMs: 200, pauseMs: 0 },
    });
  }
  const model = GRANITE_97M;
  const dir = join(dataDir, 'models', 'granite-embedding-97m-multilingual-r2');
  return setUpMeaning({
    store,
    model,
    downloaded: () => modelDownloaded(dir, model.files),
    download: ({ onProgress, signal }) =>
      downloadModel({ baseUrl: model.baseUrl, files: model.files, dir, onProgress, signal }),
    load: () => workerEmbedder(workerPath, dir, model),
    embed,
  });
}
