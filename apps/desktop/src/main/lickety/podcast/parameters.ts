/** Persisted algorithm contract. Change algorithmVersion whenever any solver,
 * validation or source-time interpretation changes. Feature version is separate
 * so graph/review changes do not invalidate reusable audio fingerprints. */
export const SYNC_PARAMETERS = {
  algorithmVersion:'landmarks-ncc-network-9',featureVersion:'landmarks-ncc-network-3',
  analysisSampleRate:8000,featureFFTSize:512,featureHopSamples:256,featureBlockHops:1024,featureContextHops:128,
  maxCandidates:4,fineWindowMaxSeconds:6,fineWindowMinSeconds:1,maxCorrelationInputSeconds:40,
  fittingFractions:[.06,.30,.54,.78],validationFractions:[.18,.42,.66,.90],minFitWindows:3,minValidationWindows:3,
  minUsableRms:1e-5,minCorrelation:.18,minPeakRatio:1.35,competingPeakExclusionSeconds:.02,
  pairResidualTargetMs:5,graphResidualTargetMs:5,maxAbsolutePairDriftPpm:2000,
  networkFitHuberMs:2.5,networkFitIterations:8,
  boundaryWindowSeconds:6,boundaryFractions:[.19,.39,.63,.81],boundaryInsetSeconds:7,minBoundaryCorrelation:.35,
  boundarySubwindows:3,boundaryPeakExclusionSeconds:.002,boundaryConsistencyMs:2,boundaryChannelCompetition:.85,
  boundaryStrideSeconds:120,regionalWindowSeconds:6,regionalStrideSeconds:12,regionalFitMaxResidualMs:3,regionalValidationTargetMs:5,regionalMinIndependentWindows:3,regionalMaxUnsupportedFitGapSeconds:120,validationHistory:'reserved-both-sides-including-edge-validation',
  recordingRelationships:'confirmed-sample-starts-and-continuous-file-starts',regionalClockBreakMinSeconds:.015,regionalWholeCoverageFraction:.8,regionalWholeEndpointFraction:.1,regionalWholeEndpointMinSeconds:12,
  audioRangeReaderVersion:3,positiveAudioTimestampGaps:'presentation-islands',
  packetSpanToleranceFrames:.25,packetSpanMinToleranceSeconds:.00002,
  presentedPacketPolicy:'exclude-demuxer-discard-confirm-declared-cadence-and-container-terminal-trim',
  mappingVersion:1,timeDomain:'asset-presentation-seconds-including-container-edits'
} as const;
