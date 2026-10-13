import { it, expect } from 'vitest';
import { getResourceProfile, getDesktopProfilePath } from '../src/main/lickety/resource-policy';
it('bounds an 8 GiB Mac',()=>{expect(getResourceProfile(8*1024**3)).toMatchObject({lowMemory:true,maxHeavyJobs:1,maxVideoDecoders:4,maxChunkBytes:16*1024**2}); expect(getResourceProfile(16*1024**3).lowMemory).toBe(false);});
it('keeps keys and projects separate from legacy and upstream',()=>{expect(getDesktopProfilePath('/Users/test/Library/Application Support')).toBe('/Users/test/Library/Application Support/LicketySplit');expect(getDesktopProfilePath('/support','/tmp/fixture',true)).toBe('/tmp/fixture');expect(getDesktopProfilePath('/support','/tmp/fixture',false)).toBe('/support/LicketySplit');});
