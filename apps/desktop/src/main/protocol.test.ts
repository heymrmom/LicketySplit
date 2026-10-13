import { describe, expect, it } from "vitest";
import { resolveAppSchemeResource } from "./protocol";

const root = "/app/renderer";

describe("app scheme resource policy", () => {
  it("serves the main app only from the new host and keeps deep links on that host", () => {
    expect(resolveAppSchemeResource("app://licketysplit/", root)).toMatchObject({
      status: 200,
      filePath: "/app/renderer/index.html",
      resourcePolicy: "same-origin",
    });
    expect(resolveAppSchemeResource("app://licketysplit/editor/project-1", root)).toMatchObject({
      status: 200,
      filePath: "/app/renderer/index.html",
      resourcePolicy: "same-origin",
    });
  });

  it("serves only the migration page and its dedicated script on the legacy host", () => {
    expect(resolveAppSchemeResource("app://openreel/migration.html", root)).toMatchObject({
      status: 200,
      filePath: "/app/renderer/legacy-migration/migration.html",
      resourcePolicy: "cross-origin",
    });
    expect(resolveAppSchemeResource("app://openreel/migration-assets/index-a1b2.js", root)).toMatchObject({
      status: 200,
      filePath: "/app/renderer/legacy-migration/migration-assets/index-a1b2.js",
      resourcePolicy: "cross-origin",
    });
    expect(resolveAppSchemeResource("app://openreel/", root).status).toBe(404);
    expect(resolveAppSchemeResource("app://openreel/index.html", root).status).toBe(404);
    expect(resolveAppSchemeResource("app://openreel/src/main.tsx", root).status).toBe(404);
  });

  it("rejects unknown hosts, ports, malformed paths, and traversal", () => {
    expect(resolveAppSchemeResource("app://other/index.html", root).status).toBe(404);
    expect(resolveAppSchemeResource("app://licketysplit:8080/index.html", root).status).toBe(404);
    expect(resolveAppSchemeResource("app://openreel/migration-assets/../../index.html", root).status).toBe(403);
    expect(resolveAppSchemeResource("app://openreel/%E0%A4%A", root).status).toBe(400);
  });
});
