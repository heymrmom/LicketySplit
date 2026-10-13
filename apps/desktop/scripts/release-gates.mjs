#!/usr/bin/env node
import {promises as fs} from 'node:fs';
export function requireReleaseEvidence(manifest,evidence){
 if(manifest.signing!=='signed-notarized'||!manifest.teamId)throw new Error('Signed and notarized package evidence required');
 if(evidence.sourceCommit!==manifest.sourceCommit||evidence.packageSha256!==manifest.sha256)throw new Error('Acceptance evidence does not match this package');
 if(evidence.physicalMemoryBytes!==8*1024**3||evidence.architecture!=='arm64'||evidence.workflowAccepted!==true)throw new Error('Physical8GiB Apple silicon workflow acceptance required');
 if(evidence.freshDownloadGatekeeperAccepted!==true)throw new Error('Fresh-download Gatekeeper acceptance required');
 return true;
}
if(process.argv[1]?.endsWith('release-gates.mjs')){const [manifest,evidence]=await Promise.all(process.argv.slice(2,4).map(file=>fs.readFile(file,'utf8').then(JSON.parse)));requireReleaseEvidence(manifest,evidence);process.stdout.write('Draft release prerequisites verified\n');}
