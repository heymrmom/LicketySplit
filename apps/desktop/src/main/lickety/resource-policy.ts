import path from 'node:path';
import type { ResourceProfile } from '../../../../../packages/core/src/lickety/types';
export function getResourceProfile(totalBytes: number): ResourceProfile {
 return {lowMemory:totalBytes<=8*1024**3,maxHeavyJobs:1,maxVideoDecoders:4,maxChunkBytes:16*1024**2,proxyMaxLongEdge:960,proxyMaxShortEdge:540};
}
export function getDesktopProfilePath(appData:string, override?:string, isTest=false):string {
 return isTest && override ? path.resolve(override) : path.join(appData,'LicketySplit');
}
