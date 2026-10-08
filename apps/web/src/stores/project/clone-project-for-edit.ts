import { cloneProjectForWorkflow, type Project } from "@openreel/core";

/**
 * Timeline/motion edits need independent mutable project data, but media items
 * are immutable sources. Retain their Blob/handle identities so edits neither
 * invalidate preview proxies nor copy waveform data and browser file handles.
 */
export function cloneProjectForEdit(project: Project): Project {
  return cloneProjectForWorkflow(project);
}
