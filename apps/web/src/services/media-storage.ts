import { bindNativeMediaSources, StorageEngine } from "@licketysplit/core";
import type { Project, MediaItem, MediaRecord, MediaMetadata } from "@licketysplit/core";

const storage = new StorageEngine();
const desktop=()=>typeof window!=='undefined'&&window.licketysplit?.platform==='desktop';
function clearStaleMediaPreviews(item:MediaItem):MediaItem{
  return {...item,thumbnailUrl:item.thumbnailUrl?.startsWith('blob:')?null:item.thumbnailUrl,waveformData:null,filmstripThumbnails:undefined};
}
async function restoreNativeRecord(record:MediaRecord|null):Promise<MediaRecord|null>{
  if(!record?.nativeOriginalUri||!desktop())return record;
  const uri=await window.licketysplit!.lickety!.originalUri(record.id);
  if(!uri)throw new Error('Original unavailable; relink the original recording');
  let blob=new Blob([]);if(record.nativeMediaType==='image')blob=await fetch(uri).then(response=>{if(!response.ok)throw new Error('Original image unavailable; relink it');return response.blob();});bindNativeMediaSources(blob,Promise.resolve(uri),Promise.resolve(uri));return {...record,blob};
}


/** Same-machine reopen restores pointers, without reading video/audio source bytes. */
export async function restoreNativeMediaReferences(project:Project):Promise<Project>{
  if(!desktop()||!window.licketysplit?.lickety?.originalUri)return project;
  const items=await Promise.all(project.mediaLibrary.items.map(async item=>{
    try{const uri=await window.licketysplit!.lickety!.originalUri(item.id);if(!uri)return {...clearStaleMediaPreviews(item),blob:null,isPlaceholder:true};let blob:Blob=new Blob([]);if(item.type==='image')blob=await fetch(uri).then(response=>{if(!response.ok)throw new Error('Original unavailable');return response.blob();});bindNativeMediaSources(blob,Promise.resolve(uri),Promise.resolve(uri));return {...clearStaleMediaPreviews(item),blob,isPlaceholder:false};}
    catch{return {...clearStaleMediaPreviews(item),blob:null,isPlaceholder:true};}
  }));return {...project,mediaLibrary:{...project.mediaLibrary,items}};
}

export async function saveMediaBlob(
  projectId: string,
  mediaId: string,
  blob: Blob,
  metadata: MediaMetadata,
): Promise<void> {
  if(desktop()&&window.licketysplit?.lickety?.referenceFile){
    const bridge=window.licketysplit.lickety;
    let reference=typeof File!=='undefined'&&blob instanceof File?await bridge.referenceFile(mediaId,blob):null;
    if(!reference){const {getBridge,materializeToTemp,getMaterializedOriginal}=await import('@licketysplit/core/media/native-media-bridge');const native=getBridge();if(!native)throw new Error('Native original persistence is unavailable');reference=await bridge.referencePath(mediaId,getMaterializedOriginal(blob)??await materializeToTemp(native,blob));}
    bindNativeMediaSources(blob,Promise.resolve(reference.originalUri),Promise.resolve(reference.originalUri));
    await storage.saveMedia({id:mediaId,projectId,blob:null,metadata,nativeOriginalUri:reference.originalUri,nativeMediaType:blob.type.startsWith('image/')?'image':metadata.hasVideo||(metadata.width>0&&metadata.duration>0)?'video':'audio'});return;
  }
  const record: MediaRecord = {
    id: mediaId,
    projectId,
    blob,
    metadata,
  };

  await storage.saveMedia(record);
}

export async function loadMediaBlob(mediaId: string): Promise<Blob | null> {
  const record = await restoreNativeRecord(await storage.loadMedia(mediaId));
  return record?.blob || null;
}

export async function loadMediaRecord(
  mediaId: string,
): Promise<MediaRecord | null> {
  return restoreNativeRecord(await storage.loadMedia(mediaId));
}

export async function loadProjectMedia(
  projectId: string,
): Promise<MediaRecord[]> {
  const records=await storage.getMediaByProject(projectId);
  return Promise.all(records.map(async record=>{try{return (await restoreNativeRecord(record))!;}catch{return {...record,blob:null};}}));
}

export async function deleteMediaBlob(mediaId: string): Promise<void> {
  await storage.deleteMedia(mediaId);
}

export async function deleteProjectMedia(projectId: string): Promise<void> {
  const records = await storage.getMediaByProject(projectId);
  for (const record of records) {
    await storage.deleteMedia(record.id);
  }
}

export async function saveFileHandle(name: string, size: number, handle: FileSystemFileHandle): Promise<void> {
  await storage.saveFileHandle(name, size, handle);
}

export async function loadFileHandle(name: string, size: number): Promise<FileSystemFileHandle | null> {
  return storage.loadFileHandle(name, size);
}

export async function saveDirectoryHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await storage.saveDirectoryHandle(projectId, handle);
}

export async function loadDirectoryHandle(projectId: string): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  return storage.loadDirectoryHandle(projectId);
}

export async function getStorageStats(): Promise<{
  used: number;
  quota: number;
  mediaCount: number;
}> {
  const usage = await storage.getStorageUsage();
  return {
    used: usage.used,
    quota: usage.quota,
    mediaCount: usage.mediaItems,
  };
}

export async function clearAllStorage(): Promise<void> {
  await storage.clearAllData();

  const databasesToDelete = ["licketysplit-autosave", "licketysplit-projects", "licketysplit-templates"];
  await Promise.allSettled(
    databasesToDelete.map(
      (dbName) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(dbName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => resolve();
        }),
    ),
  );
}
