import type { StateStorage } from 'zustand/middleware';

export const IMAGE_COLOR_KEY = 'licketysplit-image-colors';
export const LEGACY_IMAGE_COLOR_KEY = 'openreel-image-colors';

export function createImageColorStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): StateStorage {
  return {
    getItem(name) {
      const current = storage.getItem(name);
      if (current !== null || name !== IMAGE_COLOR_KEY) return current;
      return storage.getItem(LEGACY_IMAGE_COLOR_KEY);
    },
    setItem(name, value) {
      storage.setItem(name === LEGACY_IMAGE_COLOR_KEY ? IMAGE_COLOR_KEY : name, value);
    },
    removeItem(name) {
      storage.removeItem(name);
      if (name === IMAGE_COLOR_KEY) storage.removeItem(LEGACY_IMAGE_COLOR_KEY);
    },
  };
}
