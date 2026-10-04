import type {
  AutonomyRequest,
  AutonomyResponse,
  AutonomyResults,
  CoreMessage,
  EmailReaderRequest,
  EmailReaderResponse,
  GitHubDiscussionRequest,
  GitHubDiscussionResponse,
  GitHubWatchRequest,
  GitHubWatchResponse,
  ItemStoreRequest,
  ItemStoreResponse,
  ItemStoreResults,
  MarkdownCopyRequest,
  MarkdownCopyResponse,
  ModelProvider,
  ModelsRequest,
  ModelsResponse,
  UpdatesRequest,
  UpdatesResponse,
  UpdatesResults,
} from '@commander/domain';
// The ipc subpath keeps zod (and the schemas) out of the sandboxed preload bundle.
import {
  type AccountsRequest,
  type AccountsResponse,
  type AccountsState,
  type Diagnostics,
  ipc,
  type ModelKeyStatus,
  type OpenItem,
  type SaveModelKeyResult,
  type SecretStorageStatus,
  type WindowControl,
  type WindowFrame,
} from '@commander/domain/ipc';
import { contextBridge, ipcRenderer } from 'electron';

// What the window must save before Commander quits (see onSaveBeforeQuit).
const savers = new Set<() => Promise<void>>();
ipcRenderer.on(ipc.saveBeforeQuit, async (_event, id: number) => {
  await Promise.allSettled([...savers].map((save) => save()));
  ipcRenderer.send(ipc.savedBeforeQuit, id);
});

// The only bridge between the renderer and the app.
const commander = {
  onCoreMessage(listener: (message: CoreMessage) => void) {
    const handler = (_event: unknown, message: CoreMessage) => listener(message);
    ipcRenderer.on(ipc.coreMessage, handler);
    return () => {
      ipcRenderer.off(ipc.coreMessage, handler);
    };
  },
  diagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(ipc.diagnostics),
  // Only the status of secret storage crosses to the window; secrets themselves never do.
  secretStorageStatus: (): Promise<SecretStorageStatus> => ipcRenderer.invoke(ipc.secretStorageStatus),
  // The window's only way to read or change Items. Rejects with the reason when the request fails.
  async itemStore<R extends ItemStoreRequest>(request: R): Promise<ItemStoreResults[R['op']]> {
    const response: ItemStoreResponse<R['op']> = await ipcRenderer.invoke(ipc.itemStore, request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
  // Settings → Ares, answered by the Core. Resolves with the response, failures included, so the
  // window can tell an over-cap or refused-key failure apart.
  models: <R extends ModelsRequest>(request: R): Promise<ModelsResponse<R['op']>> =>
    ipcRenderer.invoke(ipc.models, request),
  // A model provider's API key goes to the main process (and the keyring) only; it is never read back.
  modelKeyStatus: (provider: ModelProvider): Promise<ModelKeyStatus> =>
    ipcRenderer.invoke(ipc.modelKeyStatus, provider),
  saveModelKey: (provider: ModelProvider, key: string): Promise<SaveModelKeyResult> =>
    ipcRenderer.invoke(ipc.saveModelKey, provider, key),
  clearModelKey: (provider: ModelProvider): Promise<void> => ipcRenderer.invoke(ipc.clearModelKey, provider),
  // Autonomy settings and Ares's activity: read, accept, dismiss, undo. Rejects with the reason.
  async autonomy<R extends AutonomyRequest>(request: R): Promise<AutonomyResults[R['op']]> {
    const response: AutonomyResponse<R['op']> = await ipcRenderer.invoke(ipc.autonomy, request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
  // Ares's Updates: the quiet count, the Update Skill, Past Updates and acting on a line. Rejects
  // with the reason.
  async updates<R extends UpdatesRequest>(request: R): Promise<UpdatesResults[R['op']]> {
    const response: UpdatesResponse<R['op']> = await ipcRenderer.invoke(ipc.updates, request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
  // The tray's "Ask for an update" was chosen: the window runs the Update Skill.
  onAskForUpdate(listener: () => void) {
    const handler = () => listener();
    ipcRenderer.on(ipc.askForUpdate, handler);
    return () => {
      ipcRenderer.off(ipc.askForUpdate, handler);
    };
  },
  // A meeting's heads-up was clicked: the window shows the event in the Calendar Section.
  onOpenItem(listener: (target: OpenItem) => void) {
    const handler = (_event: unknown, target: OpenItem) => listener(target);
    ipcRenderer.on(ipc.openItem, handler);
    return () => {
      ipcRenderer.off(ipc.openItem, handler);
    };
  },
  // Settings → Notes → Markdown copy folder. The folder comes only from the system picker, which the
  // main process shows; resolves with the refusal's reason, if any.
  markdownCopy: (request: MarkdownCopyRequest): Promise<MarkdownCopyResponse> =>
    ipcRenderer.invoke(ipc.markdownCopy, request),
  // Settings → GitHub: what each GitHub Account can reach and watches. Resolves with the response,
  // failures included (with the last listing, when there is one).
  githubWatch: (request: GitHubWatchRequest): Promise<GitHubWatchResponse> =>
    ipcRenderer.invoke(ipc.githubWatch, request),
  // The GitHub Section: a pull request's or issue's discussion, fetched (or kept) by the Core.
  // Resolves with the response, failures included.
  githubDiscussion: (request: GitHubDiscussionRequest): Promise<GitHubDiscussionResponse> =>
    ipcRenderer.invoke(ipc.githubDiscussion, request),
  // The email reader: prepares a message's HTML for its sandboxed frame, sizes the frame, saves or
  // opens attachments, and changes the image rules. Resolves with the response, failures included.
  emailReader: (request: EmailReaderRequest): Promise<EmailReaderResponse> =>
    ipcRenderer.invoke(ipc.emailReader, request),
  // The real destination of the link hovered in an email's frame ('' when none).
  onEmailLinkHover(listener: (url: string) => void) {
    const handler = (_event: unknown, url: string) => listener(typeof url === 'string' ? url : '');
    ipcRenderer.on(ipc.emailLinkHover, handler);
    return () => {
      ipcRenderer.off(ipc.emailLinkHover, handler);
    };
  },
  startAtLogin: (): Promise<boolean> => ipcRenderer.invoke(ipc.startAtLogin),
  setStartAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(ipc.setStartAtLogin, enabled),
  // Settings → Accounts. Answers carry Account summaries, never a token or key.
  accounts: (request: AccountsRequest): Promise<AccountsResponse> =>
    ipcRenderer.invoke(ipc.accounts, request),
  onAccountsChanged(listener: (state: AccountsState) => void) {
    const handler = (_event: unknown, state: AccountsState) => listener(state);
    ipcRenderer.on(ipc.accountsChanged, handler);
    return () => {
      ipcRenderer.off(ipc.accountsChanged, handler);
    };
  },
  // Runs `save` when Commander quits, before the Core stops, so edits held back (typing saved after a
  // pause) reach the Item store. Returns the function that stops it.
  onSaveBeforeQuit(save: () => Promise<void>) {
    savers.add(save);
    return () => {
      savers.delete(save);
    };
  },
  // Tells the app the first frame is on screen (in the saved theme), so the window can be shown.
  framePainted: (): void => ipcRenderer.send(ipc.framePainted),
  // The header is the title bar: how the frame behaves here, and its minimise, maximise and close.
  windowFrame: (): Promise<WindowFrame> => ipcRenderer.invoke(ipc.windowFrame),
  windowControl: (control: WindowControl): Promise<void> => ipcRenderer.invoke(ipc.windowControl, control),
  onWindowFrame(listener: (frame: WindowFrame) => void) {
    const handler = (_event: unknown, frame: WindowFrame) => listener(frame);
    ipcRenderer.on(ipc.windowFrameChanged, handler);
    return () => {
      ipcRenderer.off(ipc.windowFrameChanged, handler);
    };
  },
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
