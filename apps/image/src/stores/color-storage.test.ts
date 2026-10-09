import { describe, expect, it, beforeEach } from 'vitest';
import { createImageColorStorage, LEGACY_IMAGE_COLOR_KEY, IMAGE_COLOR_KEY } from './color-storage';

describe('image color storage identity compatibility', () => {
  beforeEach(() => localStorage.clear());

  it('reads the legacy value without migrating or deleting it', () => {
    localStorage.setItem(LEGACY_IMAGE_COLOR_KEY, '{"state":{"savedColors":["#123456"]}}');
    const storage = createImageColorStorage(localStorage);

    expect(storage.getItem(IMAGE_COLOR_KEY)).toContain('#123456');
    expect(localStorage.getItem(LEGACY_IMAGE_COLOR_KEY)).toContain('#123456');
    expect(localStorage.getItem(IMAGE_COLOR_KEY)).toBeNull();
  });

  it('prefers the destination and writes only the new key', () => {
    localStorage.setItem(LEGACY_IMAGE_COLOR_KEY, 'legacy');
    localStorage.setItem(IMAGE_COLOR_KEY, 'current');
    const storage = createImageColorStorage(localStorage);

    expect(storage.getItem(IMAGE_COLOR_KEY)).toBe('current');
    storage.setItem(IMAGE_COLOR_KEY, 'updated');

    expect(localStorage.getItem(IMAGE_COLOR_KEY)).toBe('updated');
    expect(localStorage.getItem(LEGACY_IMAGE_COLOR_KEY)).toBe('legacy');
  });
});
