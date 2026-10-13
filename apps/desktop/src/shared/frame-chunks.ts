export const MAX_IPC_FRAME_CHUNK = 16 * 1024 * 1024;
export interface FrameChunk {type:'frame-chunk';frameId:number;totalBytes:number;offset:number;ts:number;buffer:ArrayBuffer;}
export function* splitFrame(buffer:ArrayBuffer,frameId:number,ts:number):Generator<FrameChunk>{for(let offset=0;offset<buffer.byteLength;offset+=MAX_IPC_FRAME_CHUNK)yield {type:'frame-chunk',frameId,totalBytes:buffer.byteLength,offset,ts,buffer:buffer.slice(offset,Math.min(buffer.byteLength,offset+MAX_IPC_FRAME_CHUNK))};}
export class FrameAssembler {
 private pending?:{id:number;offset:number;ts:number;bytes:Uint8Array};
 constructor(private expectedBytes:number){}
 accept(msg:FrameChunk):{buffer:ArrayBuffer;ts:number}|undefined {
  if(msg.totalBytes!==this.expectedBytes||msg.buffer.byteLength>MAX_IPC_FRAME_CHUNK||msg.offset<0||msg.buffer.byteLength===0)throw new Error('Invalid bounded frame chunk');
  if(!this.pending){if(msg.offset!==0)throw new Error('Missing initial frame chunk');this.pending={id:msg.frameId,offset:0,ts:msg.ts,bytes:new Uint8Array(msg.totalBytes)};}
  const p=this.pending;if(msg.frameId!==p.id||msg.offset!==p.offset||msg.ts!==p.ts||p.offset+msg.buffer.byteLength>p.bytes.length)throw new Error('Invalid frame chunk order');
  p.bytes.set(new Uint8Array(msg.buffer),p.offset);p.offset+=msg.buffer.byteLength;
  if(p.offset===p.bytes.length){this.pending=undefined;return {buffer:p.bytes.buffer as ArrayBuffer,ts:p.ts};}
 }
}
