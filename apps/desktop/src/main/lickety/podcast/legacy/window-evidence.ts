import {fineCorrelation,ANALYSIS_RATE} from '../dsp';

/** A single NCC maximum is not validation. Compare a six-second window and
 * three disjoint two-second sections, including competing peaks just 2ms away.
 * Selection uses signal evidence only, never distance to the desired zero lag.
 */
export function windowEvidence(reference:Float32Array,source:Float32Array,padSeconds=.06,minCorrelation=.35) {
  const full=fineCorrelation(reference,source,.002),section=Math.floor(source.length/3);
  const subwindows=Array.from({length:3},(_,i)=>{
    const first=i*section,last=i===2?source.length:(i+1)*section;
    const m=fineCorrelation(reference.subarray(first,last+reference.length-source.length),source.subarray(first,last),.002);
    return {score:m.score,competingScore:m.competingScore,residualMs:(m.lagSamples-Math.round(padSeconds*ANALYSIS_RATE))*1000/ANALYSIS_RATE,
      usable:m.score>=.18 && m.score>=1.35*m.competingScore && m.rms>=1e-5};
  });
  const residualMs=(full.lagSamples-Math.round(padSeconds*ANALYSIS_RATE))*1000/ANALYSIS_RATE;
  const agreeing=subwindows.filter(s=>s.usable && Math.abs(s.residualMs-residualMs)<=2);
  const contradictory=subwindows.filter(s=>s.usable && s.score>=full.score && Math.abs(s.residualMs-residualMs)>2);
  return {score:full.score,competingScore:full.competingScore,residualMs,subwindows,
    usable:full.score>=minCorrelation && full.score>=1.35*full.competingScore && full.rms>=1e-5 && agreeing.length>=2 && contradictory.length===0};
}
