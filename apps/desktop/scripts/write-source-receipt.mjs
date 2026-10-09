#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {promises as fs} from 'node:fs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=no'))throw new Error('Commit tracked source changes before packaging');
const ffmpeg=await fs.readFile('apps/desktop/resources/bin/darwin-arm64/ffmpeg');const receipt={schemaVersion:1,repository:'heymrmom/LicketySplit',sourceCommit:git('rev-parse','HEAD'),ffmpegSourceSha256:createHash('sha256').update(ffmpeg).digest('hex')};
await fs.mkdir('apps/desktop/resources',{recursive:true});await fs.writeFile('apps/desktop/resources/BUILD_SOURCE.json',JSON.stringify(receipt,null,2)+'\n');
