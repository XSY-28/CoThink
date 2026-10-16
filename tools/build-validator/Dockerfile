# syntax=docker/dockerfile:1.7
# Operator supplies a verified Node 22+ image reference including @sha256 digest.
# Build from the repository root. This adapter never builds or pulls an image.
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS toolchain
ARG NODE_BASE_IMAGE
ARG EXPECTED_NODE_VERSION
RUN node -e 'if (!/^.+@sha256:[a-f0-9]{64}$/.test(process.env.NODE_BASE_IMAGE || "") || Number(process.versions.node.split(".")[0]) < 22 || process.versions.node !== process.env.EXPECTED_NODE_VERSION) process.exit(1)'
WORKDIR /opt/toolchain
COPY package.json package-lock.json ./
COPY packages/argue/package.json ./packages/argue/package.json
COPY packages/argue-cli/package.json ./packages/argue-cli/package.json
COPY packages/argue-viewer/package.json ./packages/argue-viewer/package.json
COPY packages/cothink/package.json ./packages/cothink/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY examples/todo-stats/tsconfig.json /opt/validator/tsconfig.json
COPY examples/todo-stats/package.json /opt/validator/package.json
COPY examples/todo-stats/src/types.ts /opt/validator/types.ts
COPY examples/todo-stats/src/cli.ts /opt/validator/cli.ts
RUN <<'SCRIPTS'
printf '%s' "$EXPECTED_NODE_VERSION" > /opt/validator/node-version
cat > /opt/validator/supervisor.mjs <<'JS'
// Contains no candidate import. Candidate execution occurs in separate exec children.
setInterval(() => {}, 60000);
JS
cat > /opt/validator/compile.mjs <<'JS'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire('/opt/toolchain/package.json');
const ts=require('typescript');
for (const path of ['normalize','report']) {
  const source=ts.createSourceFile(path+'.ts',readFileSync('/candidate/src/'+path+'.ts','utf8'),ts.ScriptTarget.Latest,true);
  function visit(node) {
    if (ts.isImportDeclaration(node) && (!node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text!=='./types.js')) throw new Error('E_SOURCE_DEPENDENCY');
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) throw new Error('E_SOURCE_DEPENDENCY');
    if (ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression)&&node.expression.text==='require'))) throw new Error('E_SOURCE_DEPENDENCY');
    ts.forEachChild(node,visit);
  }
  visit(source);
}
mkdirSync('/tmp/project/src',{recursive:true});
for(const [from,to] of [['/opt/validator/tsconfig.json','tsconfig.json'],['/opt/validator/package.json','package.json'],['/opt/validator/types.ts','src/types.ts'],['/opt/validator/cli.ts','src/cli.ts'],['/candidate/src/normalize.ts','src/normalize.ts'],['/candidate/src/report.ts','src/report.ts']]) writeFileSync('/tmp/project/'+to,readFileSync(from));
const result=spawnSync(process.execPath,['/opt/toolchain/node_modules/typescript/bin/tsc','-p','/tmp/project/tsconfig.json','--outDir','/tmp/out','--typeRoots','/opt/toolchain/node_modules/@types'],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,env:{PATH:process.env.PATH,HOME:'/cache'}});
if(result.error||result.status!==0) { process.stderr.write(result.stderr||result.stdout||'E_COMPILE'); process.exit(1); }
writeFileSync('/tmp/out/package.json','{"type":"module"}\n');
JS
cat > /opt/validator/invoke.mjs <<'JS'
// This child contains untrusted candidate code. Its stdout is treated only as data.
const request=JSON.parse(process.argv[2]);
function decode(v) { if(v[0]==='undefined') return undefined; if(v[0]==='number') return Number(v[1]); if(v[0]==='scalar') return v[1]; if(v[0]==='array') return v[1].map(decode); if(v[0]==='object') return Object.fromEntries(v[1].map(([k,x])=>[k,decode(x)])); throw new Error('E_BRIDGE_INPUT'); }
try {
 const input=decode(request.input);
 const result=request.operation==='normalize' ? (await import('/tmp/out/src/normalize.js')).normalizeTasks(input) : (await import('/tmp/out/src/report.js')).renderReport(input);
 process.stdout.write(JSON.stringify({ok:true,value:result}));
} catch { process.stdout.write(JSON.stringify({ok:false,error:'E_INPUT'})); }
JS
cat > /opt/validator/worker.mjs <<'JS'
// Fixed worker never imports candidate modules; it captures a separate child process.
import {spawnSync} from 'node:child_process';
const chunks=[]; for await(const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
function decode(v) { if(v[0]==='undefined') return undefined; if(v[0]==='number') return Number(v[1]); if(v[0]==='scalar') return v[1]; if(v[0]==='array') return v[1].map(decode); if(v[0]==='object') return Object.fromEntries(v[1].map(([k,x])=>[k,decode(x)])); throw new Error('E_BRIDGE_INPUT'); }
if(!['normalize','report','cli'].includes(request.operation)) process.exit(2);
let args,input;
if(request.operation==='cli') {
 const bytes=decode(request.input);
 if(!Array.isArray(bytes)||bytes.some(c=>!Array.isArray(c)||c.some(b=>!Number.isInteger(b)||b<0||b>255))) process.exit(2);
 // Preserve the exact byte chunk probe from the trusted oracle.
 const shim="import {Readable} from 'node:stream'; const chunks=JSON.parse(process.argv[1]).map(c=>Buffer.from(c)); Object.defineProperty(process,'stdin',{value:Readable.from(chunks,{objectMode:true})}); await import('/tmp/out/src/cli.js');";
 args=['--input-type=module','-e',shim,JSON.stringify(bytes)];
} else args=['/opt/validator/invoke.mjs',JSON.stringify(request)];
const result=spawnSync(process.execPath,args,{input,encoding:'utf8',timeout:4000,maxBuffer:8*1024*1024,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8'}});
if(result.error||result.signal||result.status===null) process.exit(2);
if(request.operation==='cli') process.stdout.write(JSON.stringify({ok:true,value:{status:result.status,stdout:result.stdout,stderr:result.stderr}}));
else { if(result.status!==0||result.stderr) process.exit(2); process.stdout.write(result.stdout); }
JS
cat > /opt/validator/describe.mjs <<'JS'
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const files=['/opt/validator/node-version','/opt/toolchain/package-lock.json','/opt/toolchain/node_modules/typescript/lib/typescript.js','/opt/toolchain/node_modules/typescript/lib/_tsc.js','/opt/validator/tsconfig.json','/opt/validator/package.json','/opt/validator/types.ts','/opt/validator/cli.ts','/opt/validator/compile.mjs','/opt/validator/worker.mjs','/opt/validator/invoke.mjs','/opt/validator/supervisor.mjs','/opt/validator/describe.mjs',process.execPath];
process.stdout.write(JSON.stringify({profile:'cothink-build-validator-v1',node:process.versions.node,expectedNode:readFileSync('/opt/validator/node-version','utf8'),files:Object.fromEntries(files.map(p=>[p,'sha256:'+createHash('sha256').update(readFileSync(p)).digest('hex')]))}));
JS
chmod -R a-w /opt/validator /opt/toolchain
SCRIPTS
# A fresh config removes inherited image ENV (including Node/Yarn metadata). The
# filesystem is frozen from the operator's digest-pinned base and locked npm ci.
FROM scratch
COPY --from=toolchain / /
ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp LANG=C.UTF-8
USER 65532:65532
ENTRYPOINT ["node"]
CMD ["/opt/validator/supervisor.mjs"]
