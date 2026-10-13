import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  IpcMainInvokeEvent,
  MessageChannelMain,
  MessagePortMain,
  WebContents,
} from "electron";
import { APP_ORIGIN, LEGACY_MIGRATION_PAGE } from "./protocol";
import {
  IDENTITY_MIGRATION_CHANNELS,
  IDENTITY_MIGRATION_PROTOCOL_VERSION,
  LEGACY_APP_ORIGIN,
} from "../shared/identity-migration";

export { IDENTITY_MIGRATION_CHANNELS } from "../shared/identity-migration";

const LOAD_TIMEOUT_MS = 30_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEW_APP_ORIGIN = APP_ORIGIN;
const legacyPage = new URL(LEGACY_MIGRATION_PAGE);
if (`${legacyPage.protocol}//${legacyPage.host}` !== LEGACY_APP_ORIGIN) throw new Error("The identity migration origin does not match the legacy protocol origin.");

type Port = Pick<MessagePortMain, "close">;
type InPageNavigationListener = (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void;
type ReaderWindow = Pick<BrowserWindow, "loadURL" | "close" | "isDestroyed" | "once" | "removeListener"> & {
  webContents: Pick<WebContents, "getURL" | "isDestroyed" | "postMessage" | "on" | "once" | "removeListener" | "setWindowOpenHandler">;
};

function addInPageNavigationListener(webContents: WebContents, listener: InPageNavigationListener): void {
  const on = webContents.on as unknown as (event: "did-navigate-in-page", listener: InPageNavigationListener) => WebContents;
  on.call(webContents, "did-navigate-in-page", listener);
}

function removeInPageNavigationListener(webContents: WebContents, listener: InPageNavigationListener): void {
  const removeListener = webContents.removeListener as unknown as (event: "did-navigate-in-page", listener: InPageNavigationListener) => WebContents;
  removeListener.call(webContents, "did-navigate-in-page", listener);
}

export type IdentityMigrationBridgeRuntime = {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  createReaderWindow: (options: BrowserWindowConstructorOptions) => ReaderWindow;
  createMessageChannel: () => Pick<MessageChannelMain, "port1" | "port2">;
  sourcePreloadPath: string;
  loadTimeoutMs?: number;
};

type Session = {
  caller: WebContents;
  reader: ReaderWindow;
  nonce: string;
  port1: Port;
  port2: Port;
  disposed: boolean;
  started: boolean;
  rejectStart?: (error: Error) => void;
  onCallerDestroyed: () => void;
  onCallerNavigation: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void;
  onCallerRenderProcessGone: (event: unknown, details: unknown) => void;
  onReaderDestroyed: () => void;
  onReaderClosed: () => void;
  onWillNavigate: (event: { preventDefault(): void }, url: string) => void;
  onWillRedirect: (event: { preventDefault(): void }, url: string) => void;
  onDidNavigateInPage: (_event: unknown, url: string, _isInPlace: boolean, isMainFrame: boolean) => void;
};

function parseNonce(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !UUID_V4.test(value)) {
    throw new Error("A valid UUID migration nonce is required.");
  }
  return value;
}

function isTrustedCaller(event: IpcMainInvokeEvent): boolean {
  try {
    const frame = event.senderFrame;
    const url = frame ? new URL(frame.url) : undefined;
    return frame !== null
      && frame === event.sender.mainFrame
      && url !== undefined
      && !url.username
      && !url.password
      && !url.port
      && `${url.protocol}//${url.host}` === NEW_APP_ORIGIN;
  } catch {
    return false;
  }
}

function migrationPageUrl(nonce: string): string {
  const url = new URL(LEGACY_MIGRATION_PAGE);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

function isExactMigrationPage(value: string, nonce: string): boolean {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}` === LEGACY_APP_ORIGIN
      && !url.username
      && !url.password
      && !url.port
      && url.pathname === "/migration.html"
      && url.search === `?nonce=${nonce}`
      && url.hash === "";
  } catch {
    return false;
  }
}

function closePort(port: Port): void {
  try { port.close(); }
  catch { /* Transferred ports may already be detached. */ }
}

export function installIdentityMigrationBridge(runtime: IdentityMigrationBridgeRuntime): () => void {
  const sessions = new Map<WebContents, Session>();
  const loadTimeoutMs = runtime.loadTimeoutMs ?? LOAD_TIMEOUT_MS;

  const disposeSession = (session: Session, reason: string): void => {
    if (session.disposed) return;
    session.disposed = true;
    if (sessions.get(session.caller) === session) sessions.delete(session.caller);
    session.caller.removeListener("destroyed", session.onCallerDestroyed);
    session.caller.removeListener("did-start-navigation", session.onCallerNavigation);
    session.caller.removeListener("render-process-gone", session.onCallerRenderProcessGone);
    session.reader.removeListener("closed", session.onReaderClosed);
    session.reader.webContents.removeListener("destroyed", session.onReaderDestroyed);
    session.reader.webContents.removeListener("will-navigate", session.onWillNavigate);
    session.reader.webContents.removeListener("will-redirect", session.onWillRedirect);
    removeInPageNavigationListener(session.reader.webContents as WebContents, session.onDidNavigateInPage);
    closePort(session.port1);
    closePort(session.port2);
    if (!session.reader.isDestroyed()) session.reader.close();
    if (!session.started) session.rejectStart?.(new Error(reason));
    session.rejectStart = undefined;
  };

  const start = async (event: IpcMainInvokeEvent, rawNonce: unknown): Promise<void> => {
    if (!isTrustedCaller(event)) throw new Error("Identity migration is available only from the top-level LicketySplit app window.");
    const nonce = parseNonce(rawNonce);
    if (event.sender.isDestroyed()) throw new Error("The migration caller is already closed.");
    if (sessions.has(event.sender)) throw new Error("This app window already has an identity migration session.");

    const sourceUrl = migrationPageUrl(nonce);
    const reader = runtime.createReaderWindow({
      width: 640,
      height: 480,
      show: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: "#17171c",
      webPreferences: {
        preload: runtime.sourcePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    let channel: Pick<MessageChannelMain, "port1" | "port2">;
    try {
      channel = runtime.createMessageChannel();
    } catch (error) {
      if (!reader.isDestroyed()) reader.close();
      throw new Error(`The legacy migration message channel could not be created: ${error instanceof Error ? error.message : String(error)}.`);
    }
    let session!: Session;
    const onCallerDestroyed = (): void => disposeSession(session, "The migration caller closed before reading the legacy profile.");
    const onCallerNavigation = (_navigationEvent: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) disposeSession(session, "The migration app window navigated or reloaded.");
    };
    const onCallerRenderProcessGone = (): void => disposeSession(session, "The migration app renderer stopped unexpectedly.");
    const onReaderDestroyed = (): void => disposeSession(session, "The legacy migration reader closed before the transfer completed.");
    const onReaderClosed = (): void => disposeSession(session, "The legacy migration reader was closed.");
    const onWillNavigate = (navigationEvent: { preventDefault(): void }, url: string): void => {
      if (url !== sourceUrl) navigationEvent.preventDefault();
    };
    const onWillRedirect = (navigationEvent: { preventDefault(): void }, url: string): void => {
      if (url !== sourceUrl) navigationEvent.preventDefault();
    };
    const onDidNavigateInPage = (_navigationEvent: unknown, url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && url !== sourceUrl) disposeSession(session, "The legacy migration reader navigated away from its verified page.");
    };
    session = {
      caller: event.sender,
      reader,
      nonce,
      port1: channel.port1,
      port2: channel.port2,
      disposed: false,
      started: false,
      onCallerDestroyed,
      onCallerNavigation,
      onCallerRenderProcessGone,
      onReaderDestroyed,
      onReaderClosed,
      onWillNavigate,
      onWillRedirect,
      onDidNavigateInPage,
    };
    sessions.set(event.sender, session);

    reader.once("closed", onReaderClosed);
    reader.webContents.once("destroyed", onReaderDestroyed);
    reader.webContents.on("will-navigate", onWillNavigate);
    reader.webContents.on("will-redirect", onWillRedirect);
    addInPageNavigationListener(reader.webContents as WebContents, onDidNavigateInPage);
    reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    event.sender.once("destroyed", onCallerDestroyed);
    event.sender.on("did-start-navigation", onCallerNavigation);
    event.sender.on("render-process-gone", onCallerRenderProcessGone);

    let rejectStart!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectStart = reject; });
    session.rejectStart = rejectStart;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const loadTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("The legacy migration reader load timed out.")), loadTimeoutMs);
      });
      await Promise.race([reader.loadURL(sourceUrl), loadTimeout, cancelled]);
      if (session.disposed || event.sender.isDestroyed()) throw new Error("The migration caller closed before the transfer completed.");
      if (!isExactMigrationPage(reader.webContents.getURL(), nonce)) {
        throw new Error("The legacy migration reader loaded an unexpected migration page.");
      }

      // The main process transports the endpoints only; migration values stay between renderers.
      reader.webContents.postMessage(IDENTITY_MIGRATION_CHANNELS.port, { version: IDENTITY_MIGRATION_PROTOCOL_VERSION, nonce }, [channel.port2]);
      event.sender.postMessage(IDENTITY_MIGRATION_CHANNELS.port, { version: IDENTITY_MIGRATION_PROTOCOL_VERSION, nonce }, [channel.port1]);
      session.started = true;
      session.rejectStart = undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      disposeSession(session, `The legacy profile reader failed to load: ${detail}. The original profile was left unchanged.`);
      throw new Error(`The legacy profile reader failed to load: ${detail}. The original profile was left unchanged.`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const stop = async (event: IpcMainInvokeEvent, rawNonce: unknown): Promise<void> => {
    if (!isTrustedCaller(event)) throw new Error("Identity migration is available only from the top-level LicketySplit app window.");
    const nonce = parseNonce(rawNonce);
    const session = sessions.get(event.sender);
    if (!session) return;
    if (session.nonce !== nonce) throw new Error("The migration stop nonce does not match this app window's active session.");
    disposeSession(session, "The migration session was stopped.");
  };

  runtime.ipcMain.handle(IDENTITY_MIGRATION_CHANNELS.start, (event, rawNonce) => start(event, rawNonce));
  runtime.ipcMain.handle(IDENTITY_MIGRATION_CHANNELS.stop, (event, rawNonce) => stop(event, rawNonce));

  return () => {
    runtime.ipcMain.removeHandler(IDENTITY_MIGRATION_CHANNELS.start);
    runtime.ipcMain.removeHandler(IDENTITY_MIGRATION_CHANNELS.stop);
    for (const session of [...sessions.values()]) disposeSession(session, "The application is closing.");
  };
}
