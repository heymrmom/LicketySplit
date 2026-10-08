export type JobState = 'queued'|'preparing'|'uploading'|'submitted'|'processing'|'completed'|'cancelled'|'failed'|'submission-unknown';
export interface ResourceProfile { lowMemory: boolean; maxHeavyJobs: 1; maxVideoDecoders: 4; maxChunkBytes: number; proxyMaxLongEdge: 960; proxyMaxShortEdge: 540; }
export interface AssetIdentity { assetId: string; mediaId: string; sha256: string; byteLength: number; }
export interface RegisteredAsset { identity: AssetIdentity; originalUri: string; durationMs: number; }
export interface ProxyReceipt { assetId: string; sourceSha256: string; proxyUri: string; width: number; height: number; sourceStartPTS: number; proxyStartPTS: number; durationMs: number; version: 1; }
export interface DialogueSpan { clipId: string; mediaId: string; assetId: string; trackId: string; timelineStartMs: number; timelineEndMs: number; sourceInMs: number; channel: number; participantId?: string; }
export interface AnalysisSnapshot { schemaVersion: 1; projectId: string; revisionHash: string; durationMs: number; frameRate: number; assets: AssetIdentity[]; dialogue: DialogueSpan[]; }
export interface PreparedAudio { handleId: string; snapshotHash: string; sha256: string; sampleRate: 16000; channels: 1|2; durationMs: number; }
export interface TranscriptWord { id: string; text: string; startMs: number; endMs: number; confidence: number; channel?: number; speaker?: string; sourceWordId?: string; }
export interface TranscriptDocument { schemaVersion: 1; snapshotHash: string; preparedAudioSha256: string; provider: 'assemblyai'; providerJobId: string; words: TranscriptWord[]; derivedFromSnapshotHash?: string; }
export interface TimelineWord { occurrenceId: string; sourceWordId: string; text: string; startMs: number; endMs: number; }
export interface NarrativeExcerpt { id: string; firstWordId: string; lastWordId: string; reason: string; }
export interface NarrativeProposal { schemaVersion: 1; snapshotHash: string; excerpts: NarrativeExcerpt[]; protectedAfterWordIds: string[]; reviewNotes: string[]; }
export interface TimelineRange { id: string; inMs: number; outMs: number; }
export interface NarrativeResult { project: import('../types/project').Project; words: TimelineWord[]; ranges: TimelineRange[]; }
export interface GapEvidence { leftWordId: string; rightWordId: string; startMs: number; endMs: number; rms: number[]; speechRms: number; confidence: number; }
export interface PauseCut { startMs: number; endMs: number; reason: string; }
export interface Cue { id: string; kind: 'onscreen'|'description'|'speech-cut'|'broll'|'short'; startMs: number; endMs: number; evidence: string; action: string; }
export interface PublishingPackage { schemaVersion: 1; snapshotHash: string; titles: string[]; youtubeDescription: string; chapters: {startMs:number;title:string}[]; tags: string[]; spotifyNotes: string; thumbnailIdeas: string[]; pinnedComments: string[]; }
export interface SemanticShort { candidateId: string; firstWordId: string; lastWordId: string; hookOptions: string[]; recommendedHook: string; rationale: string; captions: {youtube:string;facebook:string;instagram:string;tiktok:string}; tags: string[]; }
export interface LicketyProjectState { schemaVersion: 1; snapshot?: AnalysisSnapshot; transcript?: TranscriptDocument; narrative?: NarrativeProposal; words?: TimelineWord[]; cues?: Cue[]; publishing?: PublishingPackage; }
