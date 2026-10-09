export const IDENTITY_MIGRATION_CHANNELS = {
  start: "licketysplit:identity-migration:start",
  stop: "licketysplit:identity-migration:stop",
  port: "licketysplit:identity-migration:port",
} as const;

export const IDENTITY_MIGRATION_ENVELOPE = "licketysplit-native-migration-port";
export const IDENTITY_MIGRATION_PROTOCOL_VERSION = 1;
export const NEW_APP_ORIGIN = "app://licketysplit";
export const LEGACY_APP_ORIGIN = "app://openreel";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IdentityMigrationPortRole = "source" | "destination";

export function parseLegacyMigrationNonce(href: string): string | undefined {
  try {
    const url = new URL(href);
    const origin = url.origin && url.origin !== "null" ? url.origin : `${url.protocol}//${url.host}`;
    const nonce = url.searchParams.get("nonce");
    if (origin !== LEGACY_APP_ORIGIN
      || url.username
      || url.password
      || url.port
      || url.pathname !== "/migration.html"
      || !nonce
      || url.search !== `?nonce=${nonce}`
      || url.hash
      || !UUID_V4.test(nonce)) return undefined;
    return nonce;
  } catch {
    return undefined;
  }
}

type ForwardablePort = MessagePort;
type PortEvent = { ports?: readonly MessagePort[] };
type RelayWindow = {
  location: { origin: string; protocol: string; host: string };
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
};

function appOrigin(location: RelayWindow["location"]): string {
  return location.origin && location.origin !== "null"
    ? location.origin
    : `${location.protocol}//${location.host}`;
}

function closePorts(ports: readonly ForwardablePort[] | undefined): void {
  for (const port of ports ?? []) {
    try { port.close(); }
    catch { /* A duplicate or already-transferred endpoint is already unusable. */ }
  }
}

/** Validate and forward a main-process port without exposing it through contextBridge. */
export function forwardIdentityMigrationPort(
  event: PortEvent,
  payload: unknown,
  targetWindow: RelayWindow,
  expectedOrigin: string,
  nonce: string,
  role: IdentityMigrationPortRole,
): boolean {
  const ports = event.ports;
  const message = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const valid = appOrigin(targetWindow.location) === expectedOrigin
    && ports?.length === 1
    && message?.version === IDENTITY_MIGRATION_PROTOCOL_VERSION
    && message?.nonce === nonce;
  if (!valid) {
    closePorts(ports);
    return false;
  }
  try {
    targetWindow.postMessage({
      type: IDENTITY_MIGRATION_ENVELOPE,
      version: IDENTITY_MIGRATION_PROTOCOL_VERSION,
      nonce,
      role,
    }, expectedOrigin, [ports[0]]);
    return true;
  } catch {
    closePorts(ports);
    return false;
  }
}
