export const IMAGE_PROJECT_PREFIX = 'licketysplit-image-project-';
export const LEGACY_IMAGE_PROJECT_PREFIX = 'openreel-image-project-';

export interface ImageProjectStorage {
  load(projectId: string): string | null;
  save(projectId: string, value: string): void;
  listIds(): string[];
  delete(projectId: string): void;
}

export function createImageProjectStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>): ImageProjectStorage {
  return {
    load(projectId) {
      return storage.getItem(`${IMAGE_PROJECT_PREFIX}${projectId}`)
        ?? storage.getItem(`${LEGACY_IMAGE_PROJECT_PREFIX}${projectId}`);
    },
    save(projectId, value) {
      storage.setItem(`${IMAGE_PROJECT_PREFIX}${projectId}`, value);
    },
    listIds() {
      const ids = new Set<string>();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(IMAGE_PROJECT_PREFIX)) {
          ids.add(key.slice(IMAGE_PROJECT_PREFIX.length));
        } else if (key?.startsWith(LEGACY_IMAGE_PROJECT_PREFIX)) {
          ids.add(key.slice(LEGACY_IMAGE_PROJECT_PREFIX.length));
        }
      }
      return [...ids];
    },
    delete(projectId) {
      storage.removeItem(`${IMAGE_PROJECT_PREFIX}${projectId}`);
      storage.removeItem(`${LEGACY_IMAGE_PROJECT_PREFIX}${projectId}`);
    },
  };
}
