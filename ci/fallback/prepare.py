"""Linux-only verification runner. Never edits the pinned product source."""
import difflib, hashlib, io, json, os, shutil, subprocess, sys, tarfile, zipfile
from pathlib import Path
CONTROL=Path(__file__).resolve().parent
PAYLOAD=Path(sys.argv[1]).resolve()
ROOT=Path(sys.argv[2]).resolve()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
inputs=json.loads((CONTROL/'inputs.json').read_text())
assert subprocess.check_output(['git','-C',str(PAYLOAD),'rev-parse','HEAD'],text=True).strip()==inputs['payloadCommit']
for name,h in inputs['files'].items():assert sha(CONTROL/name)==h,name
def verify(directory,manifest):
 for e in manifest:assert sha(directory/e['path'])==e['sha256'],e['path']
source=json.loads((CONTROL/'fixtures/source-manifest.json').read_text())
verify(PAYLOAD,source['files'])
assert len(source['files'])==1005
ROOT.mkdir(parents=True,exist_ok=False)
for d in ['tests','logs','cache','retarget-diffs','runtime/tmp','frozen-artifacts','rebuilt-artifacts']:(ROOT/d).mkdir(parents=True,exist_ok=True)
(ROOT/'source').symlink_to(PAYLOAD,target_is_directory=True)
(ROOT/'node_modules').symlink_to(PAYLOAD/'node_modules',target_is_directory=True)
def archive(ref,dest):
 dest.mkdir()
 data=subprocess.check_output(['git','-C',str(PAYLOAD),'archive',ref])
 with tarfile.open(fileobj=io.BytesIO(data)) as t:t.extractall(dest,filter='data')
 (dest/'node_modules').symlink_to(PAYLOAD/'node_modules',target_is_directory=True)
archive(inputs['payloadCommit'],ROOT/'original-b201-source')
for e in source['files']:
 if e['b201']=='added':
  target=ROOT/'original-b201-source'/e['path']
  assert target.resolve().is_relative_to((ROOT/'original-b201-source').resolve())
  target.unlink()
(ROOT/'original-b201-source/package.json').write_bytes(subprocess.check_output(['git','-C',str(PAYLOAD),'show','a858098dc278492870ad04699e9d5c33cb1c43a0:package.json']))
verify(ROOT/'original-b201-source',json.loads((CONTROL/'fixtures/b201-source-manifest.json').read_text(encoding='utf-8-sig')))
archive('8d62138184be9397ea22d55170928a4edbbc0725',ROOT/'legacy-production-8d')
(ROOT/'artifacts').symlink_to(ROOT/'rebuilt-artifacts',target_is_directory=True)
old='__FALLBACK_ROOT__'
changes=[]
for p in sorted((CONTROL/'templates').rglob('*')):
 if not p.is_file():continue
 before=p.read_text();after=before.replace(old,str(ROOT))
 if p.name=='fallback-ui.test.ts':
  a='if (p?.pid) execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });'
  b='if (p?.pid) { try { process.kill(-p.pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }'
  assert after.count(a)==1
  after=after.replace(a,b).replace('shell: true','shell: false, detached: true')
  after=after.replace('const STATE = `${FB}/tests/workerd/state`;','const STATE = `${FB}/tests/workerd/state-${process.env.FB_RUN ?? "frozen"}`;')
  after=after.replace('const SHOTS = `${FB}/tests/workerd/shots`;','const SHOTS = `${FB}/tests/workerd/shots-${process.env.FB_RUN ?? "frozen"}`;')
 dest=ROOT/'tests'/p.relative_to(CONTROL/'templates');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(after)
 diff=''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile=str(p),tofile=str(dest)))
 (ROOT/'retarget-diffs'/p.name).write_text(diff)
 changes.append({'file':p.relative_to(CONTROL/'templates').as_posix(),'input':sha(p),'output':sha(dest)})
config={'root':str(PAYLOAD),'cacheDir':str(ROOT/'cache/vite'),'test':{'include':[str(ROOT/'tests/**/*.test.ts')],'environment':'node','testTimeout':30000,'fileParallelism':False,'reporters':['verbose',['json',{'outputFile':str(ROOT/'logs/last-tests.json')}]]}}
(ROOT/'tests/vitest.config.mjs').write_text('export default '+json.dumps(config,indent=2)+';\n')
(ROOT/'setup.json').write_text(json.dumps({'payloadCommit':inputs['payloadCommit'],'sourceFilesVerified':1005,'templates':changes,'platform':sys.platform,'root':str(ROOT)},indent=2)+'\n')
print(json.dumps({'root':str(ROOT),'payloadCommit':inputs['payloadCommit'],'sourceFilesVerified':1005,'platform':sys.platform}))
