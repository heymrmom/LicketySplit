import { ipcRenderer, type IpcRendererEvent } from "electron";
import {
  forwardIdentityMigrationPort,
  IDENTITY_MIGRATION_CHANNELS,
  LEGACY_APP_ORIGIN,
  parseLegacyMigrationNonce,
} from "../shared/identity-migration";

const nonce = parseLegacyMigrationNonce(window.location.href);
if (nonce) {
  let received = false;
  const onPort = (event: IpcRendererEvent, payload: unknown): void => {
    if (received) {
      for (const port of event.ports ?? []) { try { port.close(); } catch { /* already detached */ } }
      return;
    }
    if (parseLegacyMigrationNonce(window.location.href) !== nonce) {
      for (const port of event.ports ?? []) { try { port.close(); } catch { /* already detached */ } }
      return;
    }
    const forwarded = forwardIdentityMigrationPort(
      event,
      payload,
      window,
      LEGACY_APP_ORIGIN,
      nonce,
      "source",
    );
    if (forwarded) {
      received = true;
      ipcRenderer.removeListener(IDENTITY_MIGRATION_CHANNELS.port, onPort);
    }
  };
  ipcRenderer.on(IDENTITY_MIGRATION_CHANNELS.port, onPort);
}
