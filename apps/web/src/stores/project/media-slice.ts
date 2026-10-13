import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, MediaItem } from "@licketysplit/core";
import type { ProjectState } from "../project-store";
import { getMediaBridge, initializeMediaBridge } from "../../bridges/media-bridge";
import { saveMediaBlob, deleteMediaBlob } from "../../services/media-storage";
import { toast } from "../notification-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];
type ImportMediaResult = Awaited<ReturnType<ProjectState["importMedia"]>>;
type OriginalFileIdentity = { identity: string; size: number; mtimeMs: number };
const pendingImports = new Map<string, Promise<ImportMediaResult>>();

export type MediaSlice = Pick<
  ProjectState,
  | "importMedia"
  | "deleteMedia"
  | "replaceMediaAsset"
  | "renameMedia"
  | "getMediaItem"
>;

export function createMediaSlice(set: Set, get: Get): MediaSlice {
  const replacementRequests = new Map<string, symbol>();

  return {
    importMedia: async (file: File) => {
      const { project } = get();
      const desktop=typeof window!=="undefined"&&window.licketysplit?.platform==="desktop";
      let sourceIdentity: OriginalFileIdentity | null = null;
      let pendingKey: string | null = null;
      let resolvePending: ((result: ImportMediaResult) => void) | undefined;
      const finish = (result: ImportMediaResult) => { resolvePending?.(result); resolvePending = undefined; return result; };

      try {
        const nativeBridge = desktop ? window.licketysplit?.lickety : undefined;
        sourceIdentity = await nativeBridge?.identifyOriginalFile(file) ?? null;
        if (sourceIdentity) {
          const currentProject = get().project;
          if (currentProject.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
          const sameIdentity = (item: MediaItem) => {
            const identity = item.sourceFile?.identity;
            return identity?.id === sourceIdentity?.identity && identity?.size === sourceIdentity?.size && identity?.mtimeMs === sourceIdentity?.mtimeMs;
          };
          let existingItem = currentProject.mediaLibrary.items.find((item) => !item.isPlaceholder && sameIdentity(item));
          if (!existingItem && nativeBridge?.findOriginalMediaId) {
            const mediaIds = currentProject.mediaLibrary.items.filter((item) => !item.isPlaceholder).map((item) => item.id);
            const existingId = await nativeBridge.findOriginalMediaId(file, mediaIds);
            const afterLookup = get().project;
            if (afterLookup.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
            if (existingId) existingItem = afterLookup.mediaLibrary.items.find((item) => item.id === existingId);
          }
          if (!existingItem && nativeBridge?.identifyOriginalFile) {
            for (const item of currentProject.mediaLibrary.items) {
              if (item.isPlaceholder || item.sourceFile?.identity) continue;
              const candidate = item.blob instanceof File ? item.blob : await item.fileHandle?.getFile().catch(() => undefined);
              if (get().project.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
              if (!candidate) continue;
              const candidateIdentity = await nativeBridge.identifyOriginalFile(candidate);
              const afterLookup = get().project;
              if (afterLookup.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
              if (afterLookup.mediaLibrary.items.some((current) => current.id === item.id) && candidateIdentity?.identity === sourceIdentity.identity && candidateIdentity.size === sourceIdentity.size && candidateIdentity.mtimeMs === sourceIdentity.mtimeMs) {
                existingItem = item;
                break;
              }
            }
          }
          if (existingItem) {
            const latestProject = get().project;
            if (latestProject.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
            if (!latestProject.mediaLibrary.items.some((item) => item.id === existingItem!.id)) existingItem = undefined;
          }
          if (existingItem) {
            const latestProject = get().project;
            const items = latestProject.mediaLibrary.items.map((item) => item.id === existingItem!.id ? {
              ...item,
              sourceFile: { ...item.sourceFile, name: item.sourceFile?.name ?? item.name, size: sourceIdentity!.size, lastModified: item.sourceFile?.lastModified ?? 0, identity: { id: sourceIdentity!.identity, size: sourceIdentity!.size, mtimeMs: sourceIdentity!.mtimeMs } },
            } : item);
            set({ project: { ...latestProject, mediaLibrary: { ...latestProject.mediaLibrary, items }, modifiedAt: Date.now() } });
            return finish({ success: true, actionId: existingItem.id });
          }
          const latestProject = get().project;
          if (latestProject.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS", message: "The project changed while importing media. Import the file again in the current project." } });
          const concurrentExisting = latestProject.mediaLibrary.items.find((item) => !item.isPlaceholder && sameIdentity(item));
          if (concurrentExisting) return finish({ success: true, actionId: concurrentExisting.id });
          pendingKey = `${project.id}:${sourceIdentity.identity}:${sourceIdentity.size}:${sourceIdentity.mtimeMs}`;
          const pending = pendingImports.get(pendingKey);
          if (pending) { pendingKey = null; return pending; }
          const coalesced = new Promise<ImportMediaResult>((resolve) => { resolvePending = resolve; });
          pendingImports.set(pendingKey, coalesced);
        }
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) {
          await initializeMediaBridge();
        }

        const isLargeFile = file.size > 50 * 1024 * 1024;
        const importResult = await mediaBridge.importFile(file, true, desktop||isLargeFile);

        if (!importResult.success || !importResult.media) {
          return finish({
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message: importResult.error || "Failed to import media",
            },
          });
        }

        const processedMedia = importResult.media;

        let thumbnailUrl: string | null = null;
        const filmstripThumbnails: { timestamp: number; url: string }[] = [];

        if (processedMedia.thumbnails && processedMedia.thumbnails.length > 0) {
          for (const thumb of processedMedia.thumbnails) {
            let thumbUrl: string | null = null;

            if (thumb.dataUrl) {
              thumbUrl = thumb.dataUrl;
            } else if (thumb.canvas) {
              try {
                if (thumb.canvas instanceof OffscreenCanvas) {
                  const blob = await thumb.canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.7,
                  });
                  thumbUrl = URL.createObjectURL(blob);
                } else if (thumb.canvas instanceof HTMLCanvasElement) {
                  thumbUrl = thumb.canvas.toDataURL("image/jpeg", 0.7);
                }
              } catch (e) {
                console.warn("Failed to convert thumbnail canvas to URL:", e);
              }
            }

            if (thumbUrl) {
              filmstripThumbnails.push({ timestamp: thumb.timestamp, url: thumbUrl });
            }
          }

          if (filmstripThumbnails.length > 0) {
            thumbnailUrl = filmstripThumbnails[0].url;
          }
        }

        let mediaType: "video" | "audio" | "image";
        if (file.type.startsWith("image/")) {
          mediaType = "image";
        } else if (processedMedia.metadata.hasVideo) {
          mediaType = "video";
        } else if (processedMedia.metadata.hasAudio) {
          mediaType = "audio";
        } else {
          mediaType = "image";
        }

        if (!desktop && mediaType === "video" && !thumbnailUrl) {
          try {
            const thumbs = await mediaBridge.generateThumbnailsForMedia(
              processedMedia.blob ?? file,
              mediaType,
            );
            if (thumbs.length > 0) {
              thumbnailUrl = thumbs[0].dataUrl;
              filmstripThumbnails.push(
                ...thumbs.map((thumb) => ({
                  timestamp: thumb.timestamp,
                  url: thumb.dataUrl,
                })),
              );
            }
          } catch {
            // Background retry below is best-effort.
          }
        }

        const newMediaItem: MediaItem = {
          id: uuidv4(),
          name: file.name,
          type: mediaType,
          fileHandle: null,
          blob: file,
          metadata: {
            duration: processedMedia.metadata.duration || 0,
            width: processedMedia.metadata.width || 0,
            height: processedMedia.metadata.height || 0,
            frameRate: processedMedia.metadata.frameRate || 0,
            codec: processedMedia.metadata.codec || "",
            sampleRate: processedMedia.metadata.sampleRate || 0,
            channels: processedMedia.metadata.channels || 0,
            fileSize: file.size,
            hasVideo: processedMedia.metadata.hasVideo,
            hasAudio: processedMedia.metadata.hasAudio,
            audioTrackCount:processedMedia.metadata.audioTrackCount,
            canDecode:processedMedia.metadata.canDecode,
            canDecodeVideo:processedMedia.metadata.canDecodeVideo,
          },
          thumbnailUrl,
          waveformData: processedMedia.waveformData?.peaks || null,
          filmstripThumbnails:
            filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
            sourceFile: {
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
              ...(sourceIdentity ? { identity: { id: sourceIdentity.identity, size: sourceIdentity.size, mtimeMs: sourceIdentity.mtimeMs } } : {}),
            },
        };

        const currentProject = get().project;
        if (currentProject.id !== project.id) {
          return finish({
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "The project changed while importing media. Import the file again in the current project.",
            },
          });
        }

        if(desktop)await saveMediaBlob(project.id,newMediaItem.id,file,newMediaItem.metadata);
        const projectAfterSave = get().project;
        if (projectAfterSave.id !== project.id) return finish({ success: false, error: { code: "INVALID_PARAMS" as const, message: "The project changed while importing media. Import the file again in the current project." } });

        const updatedProject = {
          ...projectAfterSave,
          mediaLibrary: {
            ...projectAfterSave.mediaLibrary,
            items: [...projectAfterSave.mediaLibrary.items, newMediaItem],
          },
          modifiedAt: Date.now(),
        };

        set({ project: updatedProject });

        if(!desktop)try {
          await saveMediaBlob(
            updatedProject.id,
            newMediaItem.id,
            file,
            newMediaItem.metadata,
          );
        } catch (err) {
          console.error("[ProjectStore] Failed to persist media blob:", err);
          toast.warning(
            "Media could not be saved in browser storage",
            `Keep the original ${file.name} so you can relink it after reloading.`,
          );
        }

        if (!desktop && mediaType === "video" && !thumbnailUrl) {
          setTimeout(async () => {
            try {
              const thumbs = await mediaBridge.generateThumbnailsForMedia(
                newMediaItem.blob ?? file,
                mediaType,
              );
              if (thumbs.length > 0) {
                const currentProject = get().project;
                if (currentProject.id !== updatedProject.id) return;
                const mediaIndex = currentProject.mediaLibrary.items.findIndex(
                  (m) => m.id === newMediaItem.id,
                );
                if (mediaIndex !== -1 && currentProject.mediaLibrary.items[mediaIndex].blob === file) {
                  const updatedItems = [...currentProject.mediaLibrary.items];
                  updatedItems[mediaIndex] = {
                    ...updatedItems[mediaIndex],
                    thumbnailUrl: thumbs[0].dataUrl,
                    filmstripThumbnails: thumbs.map((t) => ({
                      timestamp: t.timestamp,
                      url: t.dataUrl,
                    })),
                  };
                  set({
                    project: {
                      ...currentProject,
                      mediaLibrary: {
                        ...currentProject.mediaLibrary,
                        items: updatedItems,
                      },
                      modifiedAt: Date.now(),
                    },
                  });
                }
              }
            } catch {
              // Background thumbnail generation is best-effort
            }
          }, 100);
        }

        return finish({ success: true, actionId: newMediaItem.id });
      } catch (error) {
        return finish({
          success: false,
          error: {
            code: "DECODE_ERROR" as const,
            message:
              error instanceof Error ? error.message : "Unknown import error",
          },
        });
      } finally {
        if (pendingKey) {
          pendingImports.delete(pendingKey);
          if (resolvePending) resolvePending({ success: false, error: { code: "DECODE_ERROR", message: "Import did not complete." } });
        }
      }
    },

    deleteMedia: async (mediaId: string) => {
      const { project, actionExecutor } = get();
      const action: Action = {
        type: "media/delete",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { mediaId },
      };
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project } });
        deleteMediaBlob(mediaId).catch((err: unknown) =>
          console.warn("[ProjectStore] Failed to delete media blob:", err),
        );
      }
      return result;
    },

    replaceMediaAsset: async (
      mediaId: string,
      file: File,
      sourceFolder?: string,
    ) => {
      const { project } = get();
      const replacementKey = `${project.id}:${mediaId}`;
      const replacementRequest = Symbol();
      replacementRequests.set(replacementKey, replacementRequest);
      const desktop=typeof window!=="undefined"&&window.licketysplit?.platform==="desktop";

      try {
        const sourceIdentity = desktop ? await window.licketysplit?.lickety?.identifyOriginalFile(file) ?? null : null;
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) {
          await initializeMediaBridge();
        }

        const importResult = await mediaBridge.importFile(file, true,desktop);

        if (!importResult.success || !importResult.media) {
          return {
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message: importResult.error || "Failed to import media",
            },
          };
        }

        const processedMedia = importResult.media;

        let thumbnailUrl: string | null = null;
        const filmstripThumbnails: { timestamp: number; url: string }[] = [];

        if (processedMedia.thumbnails && processedMedia.thumbnails.length > 0) {
          for (const thumb of processedMedia.thumbnails) {
            let thumbUrl: string | null = null;

            if (thumb.dataUrl) {
              thumbUrl = thumb.dataUrl;
            } else if (thumb.canvas) {
              try {
                if (thumb.canvas instanceof OffscreenCanvas) {
                  const blob = await thumb.canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.7,
                  });
                  thumbUrl = URL.createObjectURL(blob);
                } else if (thumb.canvas instanceof HTMLCanvasElement) {
                  thumbUrl = thumb.canvas.toDataURL("image/jpeg", 0.7);
                }
              } catch (e) {
                console.warn("Failed to convert thumbnail canvas to URL:", e);
              }
            }

            if (thumbUrl) {
              filmstripThumbnails.push({ timestamp: thumb.timestamp, url: thumbUrl });
            }
          }

          if (filmstripThumbnails.length > 0) {
            thumbnailUrl = filmstripThumbnails[0].url;
          }
        }

        const mediaType = processedMedia.metadata.hasVideo
          ? "video"
          : processedMedia.metadata.hasAudio
            ? "audio"
            : "image";

        if (!desktop && mediaType === "video" && !thumbnailUrl) {
          try {
            const thumbs = await mediaBridge.generateThumbnailsForMedia(
              processedMedia.blob ?? file,
              mediaType,
            );
            if (thumbs.length > 0) {
              thumbnailUrl = thumbs[0].dataUrl;
              filmstripThumbnails.push(
                ...thumbs.map((thumb) => ({
                  timestamp: thumb.timestamp,
                  url: thumb.dataUrl,
                })),
              );
            }
          } catch {
            // Background retry below is best-effort.
          }
        }

        const updatedItem: MediaItem = {
          id: mediaId,
          name: file.name,
          type: mediaType,
          fileHandle: null,
          blob: file,
          metadata: {
            duration: processedMedia.metadata.duration || 0,
            width: processedMedia.metadata.width || 0,
            height: processedMedia.metadata.height || 0,
            frameRate: processedMedia.metadata.frameRate || 0,
            codec: processedMedia.metadata.codec || "",
            sampleRate: processedMedia.metadata.sampleRate || 0,
            channels: processedMedia.metadata.channels || 0,
            fileSize: file.size,
            hasVideo: processedMedia.metadata.hasVideo,
            hasAudio: processedMedia.metadata.hasAudio,
            audioTrackCount:processedMedia.metadata.audioTrackCount,
            canDecode:processedMedia.metadata.canDecode,
            canDecodeVideo:processedMedia.metadata.canDecodeVideo,
          },
          thumbnailUrl,
          waveformData: processedMedia.waveformData?.peaks || null,
          filmstripThumbnails:
            filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
          isPlaceholder: false,
          sourceFile: {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            folder: sourceFolder,
            ...(sourceIdentity ? { identity: { id: sourceIdentity.identity, size: sourceIdentity.size, mtimeMs: sourceIdentity.mtimeMs } } : {}),
          },
        };

        const currentProject = get().project;
        if (
          currentProject.id !== project.id ||
          replacementRequests.get(replacementKey) !== replacementRequest ||
          !currentProject.mediaLibrary.items.some((item) => item.id === mediaId)
        ) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS" as const,
              message: "The media or project changed while replacing the file. Try again in the current project.",
            },
          };
        }

        if(desktop){await saveMediaBlob(currentProject.id,updatedItem.id,file,updatedItem.metadata);if(get().project.id!==project.id||replacementRequests.get(replacementKey)!==replacementRequest)return {success:false,error:{code:'INVALID_PARAMS',message:'The media changed while relinking; try again'}};}
        const updatedItems = get().project.mediaLibrary.items.map((item) =>
          item.id === mediaId ? updatedItem : item,
        );

        const projectAfterReference=get().project;
        set({
          project: {
            ...projectAfterReference,
            mediaLibrary: { ...projectAfterReference.mediaLibrary, items: updatedItems },
            modifiedAt: Date.now(),
          },
        });

        if(!desktop)try {
          await saveMediaBlob(
            currentProject.id,
            updatedItem.id,
            file,
            updatedItem.metadata,
          );
        } catch (error) {
          console.error("[ProjectStore] Failed to persist replacement media:", error);
          toast.warning(
            "Replacement media could not be saved in browser storage",
            `Keep the original ${file.name} so you can relink it after reloading.`,
          );
        }

        if (!desktop && updatedItem.type === "video" && !updatedItem.thumbnailUrl) {
          setTimeout(async () => {
            try {
              const thumbs = await mediaBridge.generateThumbnailsForMedia(
                updatedItem.blob ?? file,
                updatedItem.type,
              );
              if (thumbs.length > 0) {
                const currentProject = get().project;
                if (
                  currentProject.id !== project.id ||
                  currentProject.mediaLibrary.items.find((item) => item.id === mediaId)?.blob !== file
                ) return;
                const updatedItemsWithThumbs =
                  currentProject.mediaLibrary.items.map((item) =>
                    item.id === mediaId
                      ? {
                          ...item,
                          thumbnailUrl: thumbs[0].dataUrl,
                          filmstripThumbnails: thumbs.map((thumb) => ({
                            timestamp: thumb.timestamp,
                            url: thumb.dataUrl,
                          })),
                        }
                      : item,
                  );
                set({
                  project: {
                    ...currentProject,
                    mediaLibrary: { ...currentProject.mediaLibrary, items: updatedItemsWithThumbs },
                    modifiedAt: Date.now(),
                  },
                });
              }
            } catch {
              // Background thumbnail generation is best-effort
            }
          }, 100);
        }

        return { success: true, actionId: uuidv4() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: "DECODE_ERROR" as const,
            message:
              error instanceof Error ? error.message : "Unknown import error",
          },
        };
      } finally {
        if (replacementRequests.get(replacementKey) === replacementRequest) {
          replacementRequests.delete(replacementKey);
        }
      }
    },

    renameMedia: async (mediaId: string, name: string) => {
      const { project, actionExecutor } = get();
      const action: Action = {
        type: "media/rename",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { mediaId, name },
      };
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project } });
      }
      return result;
    },

    getMediaItem: (mediaId: string) =>
      get().project.mediaLibrary.items.find((item) => item.id === mediaId),
  };
}
