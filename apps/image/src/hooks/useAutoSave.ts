import { useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';
import { createImageProjectStorage } from '../persistence/identity-storage';

const AUTO_SAVE_DELAY = 2000;
const projectStorage = () => createImageProjectStorage(localStorage);

export function useAutoSave() {
  const { project, isDirty, markClean } = useProjectStore();
  const lastSavedRef = useRef<string>('');
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!project || !isDirty) return;

    const projectJson = JSON.stringify(project);
    if (projectJson === lastSavedRef.current) return;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      try {
        projectStorage().save(project.id, projectJson);
        lastSavedRef.current = projectJson;
        markClean();
      } catch (error) {
        console.error('Failed to auto-save:', error);
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [project, isDirty, markClean]);
}

export function loadSavedProject(projectId: string) {
  try {
    const json = projectStorage().load(projectId);
    if (json) {
      return JSON.parse(json);
    }
  } catch (error) {
    console.error('Failed to load saved project:', error);
  }
  return null;
}

export function getSavedProjectIds(): string[] {
  return projectStorage().listIds();
}

export function deleteSavedProject(projectId: string): void {
  projectStorage().delete(projectId);
}
