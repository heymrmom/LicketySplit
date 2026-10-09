import { migrateLegacyStorageInBrowser } from "./desktop/migration/startup";
import { connectLegacyMigrationReader } from "./desktop/migration/transport";
import { acceptIncompleteMigration, readMigrationStatus, type UnavailableMigrationRecords } from "./desktop/migration/status";
import { NEW_APP_ORIGIN } from "./desktop/migration/transport-protocol";
import { migrateLegacyNamespaceInBrowser, readNamespaceMigrationComplete } from "./desktop/migration/namespace";

const STYLES = `
  html,body { min-height:100%; margin:0; background:#16161b; color:#f4f2f8; font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  #identity-migration-gate { box-sizing:border-box; min-height:100vh; display:grid; place-items:center; padding:24px; }
  #identity-migration-gate section { width:min(640px,100%); box-sizing:border-box; padding:32px; border:1px solid #3b3943; border-radius:16px; background:#222128; box-shadow:0 24px 80px #0006; }
  #identity-migration-gate h1 { margin:0 0 12px; font-size:24px; line-height:1.25; }
  #identity-migration-gate p { color:#d0cdd7; }
  #identity-migration-gate ul { padding-left:22px; color:#d0cdd7; }
  #identity-migration-gate .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; }
  #identity-migration-gate button { min-height:44px; padding:10px 16px; border:1px solid #6b6675; border-radius:8px; background:#302e37; color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  #identity-migration-gate button.primary { border-color:#7049d6; background:#7049d6; }
  #identity-migration-gate button:focus-visible { outline:3px solid #c6b7ff; outline-offset:2px; }
  #identity-migration-gate button:disabled { opacity:.55; cursor:wait; }
  #identity-migration-gate [role=status] { min-height:24px; color:#d0cdd7; }
  #identity-migration-gate .error { overflow-wrap:anywhere; color:#ffcfbd; }
  #identity-migration-gate details { margin-top:12px; color:#d0cdd7; font-size:14px; }
  #identity-migration-gate summary { cursor:pointer; font-weight:600; }
  #identity-migration-gate details ul { margin:8px 0 0; }
  #identity-migration-gate details small { display:block; margin-top:2px; color:#aaa6b3; overflow-wrap:anywhere; }
`;

type MigrationGateResult = {
  status: "incomplete";
  unavailable: UnavailableMigrationRecords;
  copiedRecords?: number;
};

function createGate(): { root: HTMLElement; style: HTMLStyleElement; heading: HTMLHeadingElement; message: HTMLParagraphElement; status: HTMLParagraphElement; details: HTMLDetailsElement; detailList: HTMLUListElement; actions: HTMLDivElement } {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.append(style);
  const root = document.createElement("main");
  root.id = "identity-migration-gate";
  root.setAttribute("aria-live", "polite");
  const section = document.createElement("section");
  const heading = document.createElement("h1");
  const message = document.createElement("p");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const details = document.createElement("details");
  details.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  const detailList = document.createElement("ul");
  details.append(summary, detailList);
  const actions = document.createElement("div");
  actions.className = "actions";
  section.append(heading, message, status, details, actions);
  root.append(section);
  document.body.append(root);
  return { root, style, heading, message, status, details, detailList, actions };
}

function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  if (primary) control.className = "primary";
  control.addEventListener("click", onClick);
  return control;
}

function showUnavailableList(details: HTMLDetailsElement, list: HTMLUListElement, unavailable: UnavailableMigrationRecords): void {
  list.replaceChildren();
  const unique = [...new Map(unavailable.map((entry) => [`${entry.databaseName}\0${entry.storeName}`, entry])).values()];
  details.hidden = unique.length === 0;
  for (const entry of unique) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = entry.storeName === "fileHandles"
      ? "Saved media links may need to be reconnected."
      : entry.storeName === "dirHandles"
        ? "Saved folder links may need to be reconnected."
        : "Saved profile items may need attention.";
    const location = document.createElement("small");
    location.textContent = `Storage location: ${entry.databaseName} / ${entry.storeName}`;
    item.append(label, location);
    list.append(item);
  }
}

async function openEditor(
  gate?: ReturnType<typeof createGate>,
  options: { allowIncompleteNamespace?: boolean; reconcileNamespace?: boolean } = {},
): Promise<void> {
  try {
    if (
      location.protocol === "app:" &&
      location.origin === NEW_APP_ORIGIN &&
      !options.allowIncompleteNamespace &&
      (options.reconcileNamespace || !readNamespaceMigrationComplete(localStorage))
    ) {
      if (gate) gate.status.textContent = "Checking saved preferences and project files…";
      const migration = await migrateLegacyNamespaceInBrowser(localStorage, indexedDB);
      if (migration.status === "incomplete") {
        if (!gate) throw new Error("Some saved items could not be verified. Restart the app to review them before editing.");
        showIncomplete(gate, {
          status: "incomplete",
          unavailable: migration.unavailable,
          copiedRecords: migration.localStorage.copied + migration.indexedDB.copied,
        }, false, true);
        return;
      }
    }
    await import("./main");
    gate?.root.remove();
    gate?.style.remove();
  } catch (error) {
    if (gate) showError(gate, error);
    else throw error;
  }
}

async function attemptMigration(gate: ReturnType<typeof createGate>): Promise<MigrationGateResult | undefined> {
  gate.heading.textContent = "Preparing your saved work";
  gate.message.textContent = "Your previous profile stays untouched while its saved settings and project records are checked and copied.";
  gate.status.textContent = "Connecting to the previous profile…";
  gate.details.hidden = true;
  gate.detailList.replaceChildren();
  gate.actions.replaceChildren();

  let source: Awaited<ReturnType<typeof connectLegacyMigrationReader>> | undefined;
  try {
    source = await connectLegacyMigrationReader(crypto.randomUUID());
    const result = await migrateLegacyStorageInBrowser(source, localStorage, indexedDB, {
      onLocalStorageProgress: ({ copied, preserved, total }) => {
        gate.status.textContent = `Copying saved preferences… ${copied + preserved} of ${total}`;
      },
      onIndexedDbProgress: () => {
        gate.status.textContent = "Checking saved work…";
      },
    });
    if (result.status === "complete") {
      gate.status.textContent = "Saved work is ready.";
      return undefined;
    }
    return { ...result, copiedRecords: result.localStorage.copied + result.indexedDB.copied };
  } finally {
    await source?.close();
  }
}

function showIncomplete(
  gate: ReturnType<typeof createGate>,
  result: MigrationGateResult,
  accepted: boolean,
  allowIncompleteNamespace = false,
  reconcileNamespace = false,
): void {
  gate.heading.textContent = "Some saved items need attention";
  gate.message.textContent = accepted
    ? "This profile is open with the items that were checked. Your previous profile is unchanged."
    : result.copiedRecords === 0
      ? "No saved items were verified from the previous profile. Your previous profile is unchanged."
      : "Other projects and settings were copied and checked. Your previous profile is unchanged.";
  gate.status.textContent = accepted
    ? "You can retry the copy, or continue here and reconnect the listed items later."
    : "Retry the copy, or continue to this profile and reconnect the listed items later.";
  showUnavailableList(gate.details, gate.detailList, result.unavailable);
  gate.actions.replaceChildren(
    button("Retry migration", false, () => { void runMigration(gate); }),
    button("Continue and relink later", true, () => {
      try {
        acceptIncompleteMigration(localStorage, result.unavailable);
        void openEditor(gate, { allowIncompleteNamespace, reconcileNamespace });
      } catch (error) {
        showError(gate, error);
      }
    }),
  );
}

function showError(gate: ReturnType<typeof createGate>, error: unknown): void {
  gate.heading.textContent = "Your previous profile is still safe";
  gate.message.textContent = "The copy did not finish, so the editor has not opened. Retry after correcting the issue; the old profile remains available.";
  gate.status.className = "error";
  gate.status.textContent = error instanceof Error ? error.message : String(error);
  gate.details.hidden = true;
  gate.detailList.replaceChildren();
  gate.actions.replaceChildren(button("Retry migration", true, () => { void runMigration(gate); }));
}

async function runMigration(gate: ReturnType<typeof createGate>): Promise<void> {
  for (const control of gate.actions.querySelectorAll("button")) control.disabled = true;
  try {
    const incomplete = await attemptMigration(gate);
    if (incomplete) showIncomplete(gate, incomplete, false, false, true);
    else await openEditor(gate, { reconcileNamespace: true });
  } catch (error) {
    showError(gate, error);
  }
}

async function bootstrap(): Promise<void> {
  if (location.protocol !== "app:" || location.origin !== NEW_APP_ORIGIN) {
    await import("./main");
    return;
  }
  let status: ReturnType<typeof readMigrationStatus>;
  try { status = readMigrationStatus(localStorage); }
  catch (error) {
    const gate = createGate();
    showError(gate, error);
    return;
  }
  if (status?.status === "complete") {
    const gate = createGate();
    await openEditor(gate);
    return;
  }
  const gate = createGate();
  if (status?.status === "accepted-incomplete") {
    if (!readNamespaceMigrationComplete(localStorage)) {
      const migration = await migrateLegacyNamespaceInBrowser(localStorage, indexedDB);
      if (migration.status === "incomplete") {
        const unavailable = [...status.unavailable, ...migration.unavailable];
        showIncomplete(gate, {
          status: "incomplete",
          unavailable: [...new Map(unavailable.map((entry) => [`${entry.databaseName}\0${entry.storeName}`, entry])).values()],
          copiedRecords: migration.localStorage.copied + migration.indexedDB.copied,
        }, true, true);
        return;
      }
    }
    showIncomplete(gate, { status: "incomplete", unavailable: status.unavailable }, true, false, true);
    return;
  }
  gate.heading.textContent = "Preparing your saved work";
  await runMigration(gate);
}

void bootstrap().catch((error) => {
  console.error("Identity migration bootstrap failed:", error);
  const gate = createGate();
  showError(gate, error);
});
