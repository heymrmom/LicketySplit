import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeProjectFile } from "@licketysplit/core/storage/project-serializer";
import { createEmptyProject } from "../stores/project/project-helpers";
import { useProjectStore } from "../stores/project-store";
import { DESKTOP_FORMATS, startNewProject } from "../desktop/start/desktop-project-actions";
import { projectManager } from "./project-manager";

const files = new Map<string, string>();
const priorPath = "/tmp/previous-project.oreel";
const newPath = "/tmp/new-project.licketysplit";

function resetProjectFileState(): void {
  const internals = projectManager as unknown as {
    currentFileHandle: unknown;
    projectFileHandles: Map<string, unknown>;
  };
  internals.currentFileHandle = null;
  internals.projectFileHandles.clear();
}

beforeEach(() => {
  files.clear();
  resetProjectFileState();
  const fs = {
    showSaveDialog: vi.fn(async () => newPath),
    showOpenDialog: vi.fn(async () => priorPath),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      files.set(filePath, data);
    }),
    readFile: vi.fn(async (filePath: string) => files.get(filePath) ?? ""),
  };
  Object.assign(window, { licketysplit: { platform: "desktop", fs } });
});

afterEach(() => {
  delete window.licketysplit;
  resetProjectFileState();
  vi.restoreAllMocks();
});

describe("ProjectManager project-scoped save handles", () => {
  it("saves a new project to its own .licketysplit path and keeps the opened legacy file intact", async () => {
    const legacy = { ...createEmptyProject("Legacy edit"), id: "legacy-project-for-save-handle-test" };
    const originalBytes = serializeProjectFile(legacy);
    files.set(priorPath, originalBytes);

    const opened = await projectManager.openProject();
    expect(opened?.id).toBe(legacy.id);
    useProjectStore.getState().loadProject(opened!);
    expect(projectManager.getCurrentFileHandle()).toMatchObject({ kind: "native", path: priorPath });

    const unchangedLegacyBytes = files.get(priorPath);
    startNewProject(DESKTOP_FORMATS[1]);
    const blank = useProjectStore.getState().getFullProject();
    expect(projectManager.getCurrentFileHandle()).toBeNull();
    expect(projectManager.hasUnsavedChanges({ ...blank, lastSavedAt: blank.modifiedAt + 1 } as typeof blank & { lastSavedAt: number })).toBe(true);

    const fs = window.licketysplit!.fs;
    vi.mocked(fs.showSaveDialog).mockResolvedValueOnce(null);
    await expect(projectManager.saveProject(blank)).resolves.toBe(false);
    expect(files.get(priorPath)).toBe(unchangedLegacyBytes);
    expect(fs.writeFile).not.toHaveBeenCalled();

    await expect(projectManager.saveProject(blank)).resolves.toBe(true);
    expect(fs.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "Horizontal.licketysplit",
      filters: [{ name: "LicketySplit Project", extensions: ["licketysplit"] }],
    });
    expect(fs.writeFile).toHaveBeenCalledWith(newPath, expect.any(String));
    expect(files.get(priorPath)).toBe(unchangedLegacyBytes);
    expect(JSON.parse(files.get(newPath)!).project).toMatchObject({ id: blank.id, name: blank.name });

    useProjectStore.getState().loadProject(opened!);
    const editedLegacy = { ...opened!, name: "Legacy edit saved", modifiedAt: opened!.modifiedAt + 1 };
    await expect(projectManager.saveProject(editedLegacy)).resolves.toBe(true);
    expect(fs.writeFile).toHaveBeenLastCalledWith(priorPath, expect.any(String));
    expect(projectManager.getCurrentFileHandle()).toMatchObject({ kind: "native", path: priorPath });
    expect(JSON.parse(files.get(priorPath)!).project.name).toBe("Legacy edit saved");
  });

  it("does not save an unrelated project through a still-active previous handle", async () => {
    const projectA = { ...createEmptyProject("Project A"), id: "project-a-handle-boundary" };
    const projectB = { ...createEmptyProject("Project B"), id: "project-b-handle-boundary" };
    const pathA = "/tmp/project-a.oreel";
    const pathB = "/tmp/project-b.licketysplit";
    const originalA = serializeProjectFile(projectA);
    files.set(pathA, originalA);
    projectManager.adoptVerifiedNativeFile(projectA.id, pathA);

    const fs = window.licketysplit!.fs;
    vi.mocked(fs.showSaveDialog).mockResolvedValueOnce(null);
    await expect(projectManager.saveProject(projectB)).resolves.toBe(false);
    expect(files.get(pathA)).toBe(originalA);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: "Project B.licketysplit",
      filters: [{ name: "LicketySplit Project", extensions: ["licketysplit"] }],
    });

    vi.mocked(fs.showSaveDialog).mockResolvedValueOnce(pathB).mockResolvedValueOnce(pathB);
    await expect(projectManager.saveProject(projectB)).resolves.toBe(true);
    await expect(projectManager.saveProject({ ...projectB, name: "Project B updated" })).resolves.toBe(true);
    expect(fs.showSaveDialog).toHaveBeenCalledTimes(2);
    expect(fs.writeFile).toHaveBeenNthCalledWith(1, pathB, expect.any(String));
    expect(fs.writeFile).toHaveBeenNthCalledWith(2, pathB, expect.any(String));
    expect(files.get(pathA)).toBe(originalA);
    expect(JSON.parse(files.get(pathB)!).project.name).toBe("Project B updated");
  });
});
