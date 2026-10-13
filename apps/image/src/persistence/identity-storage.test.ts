import { beforeEach, describe, expect, it } from 'vitest';
import { deleteSavedProject, getSavedProjectIds, loadSavedProject } from '../hooks/useAutoSave';
import {
  createImageProjectStorage,
  LEGACY_IMAGE_PROJECT_PREFIX,
  IMAGE_PROJECT_PREFIX,
} from './identity-storage';

describe('image project storage identity compatibility', () => {
  beforeEach(() => localStorage.clear());

  it('reads legacy data without rewriting or removing the source value', () => {
    localStorage.setItem(`${LEGACY_IMAGE_PROJECT_PREFIX}legacy`, '{"name":"Legacy"}');

    expect(createImageProjectStorage(localStorage).load('legacy')).toBe('{"name":"Legacy"}');
    expect(localStorage.getItem(`${LEGACY_IMAGE_PROJECT_PREFIX}legacy`)).toBe('{"name":"Legacy"}');
    expect(localStorage.getItem(`${IMAGE_PROJECT_PREFIX}legacy`)).toBeNull();
  });

  it('prefers the new value and writes saves only to the new prefix', () => {
    localStorage.setItem(`${LEGACY_IMAGE_PROJECT_PREFIX}same`, 'legacy');
    localStorage.setItem(`${IMAGE_PROJECT_PREFIX}same`, 'current');

    const storage = createImageProjectStorage(localStorage);
    expect(storage.load('same')).toBe('current');
    storage.save('same', 'updated');

    expect(localStorage.getItem(`${IMAGE_PROJECT_PREFIX}same`)).toBe('updated');
    expect(localStorage.getItem(`${LEGACY_IMAGE_PROJECT_PREFIX}same`)).toBe('legacy');
  });

  it('merges and deduplicates project IDs, then explicit deletion removes both copies', () => {
    localStorage.setItem(`${LEGACY_IMAGE_PROJECT_PREFIX}legacy-only`, '{}');
    localStorage.setItem(`${LEGACY_IMAGE_PROJECT_PREFIX}shared`, 'old');
    localStorage.setItem(`${IMAGE_PROJECT_PREFIX}shared`, 'new');

    const storage = createImageProjectStorage(localStorage);
    expect(storage.listIds().sort()).toEqual(['legacy-only', 'shared']);
    storage.delete('shared');

    expect(localStorage.getItem(`${LEGACY_IMAGE_PROJECT_PREFIX}shared`)).toBeNull();
    expect(localStorage.getItem(`${IMAGE_PROJECT_PREFIX}shared`)).toBeNull();
    expect(storage.listIds()).toEqual(['legacy-only']);
  });

  it('keeps the welcome-screen project APIs on the compatibility adapter', () => {
    localStorage.setItem(`${LEGACY_IMAGE_PROJECT_PREFIX}welcome`, '{"id":"welcome"}');

    expect(loadSavedProject('welcome')).toEqual({ id: 'welcome' });
    expect(getSavedProjectIds()).toContain('welcome');
    deleteSavedProject('welcome');

    expect(localStorage.getItem(`${LEGACY_IMAGE_PROJECT_PREFIX}welcome`)).toBeNull();
  });
});
