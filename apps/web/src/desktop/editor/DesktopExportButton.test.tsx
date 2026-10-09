import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";

const exportMock = vi.hoisted(() => ({ useExportRunner: vi.fn() }));
vi.mock("../../services/export-runner", async () => {
  const actual = await vi.importActual<typeof import("../../services/export-runner")>("../../services/export-runner");
  return { ...actual, useExportRunner: exportMock.useExportRunner };
});
vi.mock("../../components/editor/ExportDialog", () => ({
  ExportDialog: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div role="dialog" aria-label="Export video settings" /> : null,
}));

import { DesktopExportButton } from "./DesktopExportButton";

describe("DesktopExportButton", () => {
  beforeEach(() => {
    const project = createEmptyProject("Export routing");
    useProjectStore.setState({ hasOpenProject: true, project });
    exportMock.useExportRunner.mockReturnValue({
      state: { isExporting: false, progress: 0, error: null, complete: false },
      runExport: vi.fn(), showSavePicker: vi.fn(), beginExport: vi.fn(), finishExportSoon: vi.fn(), failExport: vi.fn(), cancel: vi.fn(), resetError: vi.fn(),
    });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("opens the real export settings dialog for the desktop menu export action", () => {
    render(<DesktopExportButton />);
    expect(screen.queryByRole("dialog", { name: "Export video settings" })).toBeNull();
    act(() => window.dispatchEvent(new Event("licketysplit:menu:export")));
    expect(screen.getByRole("dialog", { name: "Export video settings" })).toBeTruthy();
  });
});
