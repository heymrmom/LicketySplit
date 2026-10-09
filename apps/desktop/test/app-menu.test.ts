import { describe, it, expect } from "vitest";
import { buildMenuTemplate } from "../src/main/app-menu";

describe("buildMenuTemplate", () => {
  it("includes the app menu first on mac and not on others", () => {
    const mac = buildMenuTemplate("darwin");
    expect(mac[0].label).toBe("OpenReel");
    const win = buildMenuTemplate("win32");
    expect(win[0].label).toBe("File");
  });
  it("has File/Edit/View/Window/Help groups", () => {
    const labels = buildMenuTemplate("win32").map((m) => m.label);
    for (const l of ["File", "Edit", "View", "Window", "Help"]) expect(labels).toContain(l);
  });
  it("File>New uses CmdOrCtrl+N", () => {
    const file = buildMenuTemplate("win32").find((m) => m.label === "File");
    const item = file?.submenu?.find((s) => s.label === "New Project");
    expect(item?.accelerator).toBe("CmdOrCtrl+N");
  });
  it("leaves customizable editor shortcuts to the renderer while keeping native New and Open", () => {
    const file = buildMenuTemplate("darwin").find((m) => m.label === "File");
    expect(file?.submenu?.find((item) => item.actionId === "newProject")?.accelerator).toBe("CmdOrCtrl+N");
    expect(file?.submenu?.find((item) => item.actionId === "open")?.accelerator).toBe("CmdOrCtrl+O");
    expect(file?.submenu?.find((item) => item.actionId === "export")?.accelerator).toBeUndefined();
    const edit = buildMenuTemplate("darwin").find((m) => m.label === "Edit");
    for (const actionId of ["undo", "redo", "cut", "copy", "paste"]) {
      const item = edit?.submenu?.find((entry) => entry.actionId === actionId);
      expect(item?.accelerator).toBeUndefined();
      expect(item?.role).toBeUndefined();
    }
  });
  it("exposes settings with the platform shortcut", () => {
    const macApp = buildMenuTemplate("darwin")[0];
    expect(macApp.submenu?.find((item) => item.actionId === "settings")?.accelerator)
      .toBe("Cmd+,");

    const windowsEdit = buildMenuTemplate("win32").find(
      (menu) => menu.label === "Edit",
    );
    expect(
      windowsEdit?.submenu?.find((item) => item.actionId === "settings")
        ?.accelerator,
    ).toBe("Ctrl+,");
  });
});
