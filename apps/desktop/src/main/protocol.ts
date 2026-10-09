import { protocol, net } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEME = "app";
const NEW_HOST = "licketysplit";
const LEGACY_HOST = "openreel";

export type AppSchemeResourceDecision = {
  status: number;
  filePath?: string;
  resourcePolicy?: "same-origin" | "cross-origin";
};

function rawPathFromUrl(value: string): string | null {
  const match = /^app:\/\/[^/?#]+([^?#]*)/i.exec(value);
  return match ? (match[1] || "/") : null;
}

function safePath(value: string): { pathname?: string; status: 400 | 403 } {
  const rawPath = rawPathFromUrl(value);
  if (rawPath === null) return { status: 400 };
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); }
  catch { return { status: 400 }; }
  if (decoded.includes("\\") || decoded.includes("\0")) return { status: 403 };
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return { status: 403 };
  return { pathname: decoded, status: 400 };
}

function resolveInside(root: string, pathname: string): string | null {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, `.${pathname}`);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return null;
  return resolved;
}

/** Pure route policy so both hosts and the old-host allowlist are testable without Electron. */
export function resolveAppSchemeResource(requestUrl: string, rendererRoot: string): AppSchemeResourceDecision {
  let url: URL;
  try { url = new URL(requestUrl); }
  catch { return { status: 400 }; }
  if (url.protocol !== `${SCHEME}:` || url.username || url.password || url.port) return { status: 404 };
  const safe = safePath(requestUrl);
  if (!safe.pathname) return { status: safe.status };
  const pathname = safe.pathname;

  if (url.hostname === NEW_HOST) {
    const route = pathname === "/" || pathname === "" || pathname === "/motion" || !path.posix.extname(pathname)
      ? "/index.html"
      : pathname;
    const filePath = resolveInside(rendererRoot, route);
    return filePath ? { status: 200, filePath, resourcePolicy: "same-origin" } : { status: 403 };
  }

  if (url.hostname === LEGACY_HOST) {
    const page = pathname === "/migration.html";
    const script = /^\/migration-assets\/[A-Za-z0-9._-]+\.js$/.test(pathname);
    if (!page && !script) return { status: 404 };
    const filePath = resolveInside(path.join(rendererRoot, "legacy-migration"), pathname);
    return filePath ? { status: 200, filePath, resourcePolicy: "cross-origin" } : { status: 403 };
  }

  return { status: 404 };
}

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {scheme:"licketysplit-media", privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}},
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function handleAppScheme(rendererRoot: string): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const decision = resolveAppSchemeResource(request.url, rendererRoot);
    if (!decision.filePath || !decision.resourcePolicy) return new Response("Not found", { status: decision.status });

    let response: Response;
    try { response = await net.fetch(pathToFileURL(decision.filePath).toString()); }
    catch { return new Response("Not found", { status: 404 }); }
    if (!response.ok) return new Response("Not found", { status: 404 });

    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", decision.resourcePolicy);
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

export const APP_ORIGIN = `${SCHEME}://${NEW_HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;
export const LEGACY_MIGRATION_PAGE = `${SCHEME}://${LEGACY_HOST}/migration.html`;
