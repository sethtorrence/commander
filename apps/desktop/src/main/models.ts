// Wires Settings → Ares into the app. The window saves the model API key here (keyring only) and
// sends everything else on to the Core; the Core borrows the key over its private port when it
// makes a call, so the key never passes through the window and is never written in plain text.
import { ipc, type ModelProvider } from '@commander/domain';
import { ipcMain } from 'electron';
import type { CoreSupervisor } from './core-supervisor';
import { answerModelKeyRequest, createModelKeys } from './model-keys';
import { createModelsChannel } from './models-channel';
import type { Secrets } from './secrets';

// Returns the Core message handler: true when a message from the Core was for the models side.
// Requests reach the Core only while it runs (#200).
export function setUpModels(
  secrets: Secrets,
  core: Pick<CoreSupervisor, 'send' | 'whileRunning'>,
): (raw: unknown) => boolean {
  const keys = createModelKeys(secrets);
  const channel = createModelsChannel((message) => core.send(message));

  ipcMain.handle(ipc.models, (_event, request: unknown) => core.whileRunning(() => channel.request(request)));
  ipcMain.handle(ipc.modelKeyStatus, (_event, provider: ModelProvider) => keys.status(provider));
  ipcMain.handle(ipc.saveModelKey, (_event, provider: ModelProvider, key: unknown) =>
    keys.save(provider, key),
  );
  ipcMain.handle(ipc.clearModelKey, (_event, provider: ModelProvider) => keys.clear(provider));

  return (raw) => {
    if (channel.settle(raw)) return true;
    const answer = answerModelKeyRequest(secrets, raw);
    if (!answer) return false;
    void answer.then((reply) => core.send(reply));
    return true;
  };
}
