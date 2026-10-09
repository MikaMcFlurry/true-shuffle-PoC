import {it,expect} from '/workspace/ts-integrated932-backend/node_modules/vitest/dist/index.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ScriptTarget,createSourceFile,SyntaxKind} from '/workspace/ts-integrated932-backend/node_modules/typescript/lib/typescript.js';
import {onboarded} from '/workspace/ts-integrated932-backend/test/hub/harness';
import {NativeError} from '/workspace/ts-integrated932-backend/src/worker/controllers/native';
import {SpotifyError} from '/workspace/ts-integrated932-backend/src/worker/spotify/client';
import {HubError} from '/workspace/ts-integrated932-backend/src/worker/hub/hub';
const compiled = transpileModule(readFileSync("src/worker/userhub.ts", "utf8"), {
	compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
function method(name:string){const ast=createSourceFile('userhub.js',compiled,ScriptTarget.ES2022,true); for(const c of ast.statements) if(c.kind===SyntaxKind.ClassDeclaration)for(const m of (c as any).members)if(m.name?.getText(ast)===name)return m.getText(ast);throw new Error(name);}
type Result = { ok: true; value: unknown } | { ok: false; error: { status: number } };
const real = runInNewContext(
	`({${["exclusive", "session", "importListens", "listeningProfile"].map(method).join(",")}})`,
	{ HubError, NativeError, SpotifyError, console },
) as Record<string, (this: unknown, ...args: unknown[]) => Promise<Result>>;


it('revoked session cannot write/read imports and distinct account hubs do not share data',async()=>{
 const a=await onboarded({tracks:40}),b=await onboarded({tracks:40});
 const shell:any={chain:Promise.resolve(),hub:()=>a.hub};
 for(const n of ['exclusive','session'])shell[n]=real[n]!.bind(shell);
 const call=(n:string,...args:unknown[])=>real[n]!.call(shell,...args);
 const epoch=a.hub.sessionEpoch();
 const request={part:0,parts:2,tracks:1,kind:'tracks',data:[['A'.repeat(22),'A','A','']]};
 expect(await call('importListens',epoch-1,request)).toMatchObject({ok:false,error:{status:401}});
 expect(await call('listeningProfile',epoch-1,'UTC')).toMatchObject({ok:false,error:{status:401}});
 const result:any=await call('importListens',epoch,request);expect(result.ok).toBe(true);
 expect(await call('importListens',epoch,{...request,upload:result.value.upload,part:1,kind:'rows',data:[[Math.floor((a.clock.t-86400000)/1000),0,120000,0,1]]})).toMatchObject({ok:true});
 expect(a.hub.listeningProfile('UTC').topSongs[0]?.name).toBe('A');expect(b.hub.listeningProfile('UTC').coverage.importedPlays).toBe(0);
 a.hub.endSessions();expect(await call('listeningProfile',epoch,'UTC')).toMatchObject({ok:false,error:{status:401}});
});
