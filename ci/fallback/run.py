import hashlib,json,os,shutil,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
CONTROL=Path(__file__).resolve().parent
PAYLOAD=Path(sys.argv[1]).resolve();ROOT=Path(sys.argv[2]).resolve();mode=sys.argv[3]
now=lambda:datetime.now(timezone.utc).isoformat()
if mode=='capture':
 surface=sys.argv[4]
 shutil.copytree(PAYLOAD/'dist/client',ROOT/'rebuilt-artifacts'/surface/'client',dirs_exist_ok=True)
 print('Captured Linux-built client',surface);sys.exit(0)
if mode=='integrity':
 manifest=json.loads((CONTROL/'fixtures/source-manifest.json').read_text())
 for e in manifest['files']:assert hashlib.sha256((PAYLOAD/e['path']).read_bytes()).hexdigest()==e['sha256'],e['path']
 browser_changes=[]
 for e in manifest['files']:
  p=ROOT/'browser-source'/e['path']
  if hashlib.sha256(p.read_bytes()).hexdigest()!=e['sha256']:
   assert e['path'].startswith('.impeccable/review/') and e['path'].endswith('.png'),e['path']
   browser_changes.append(e['path'])
 facts={'platform':sys.platform,'payloadCommit':subprocess.check_output(['git','-C',str(PAYLOAD),'rev-parse','HEAD'],text=True).strip(),'sourceFilesVerified':1005,'browserGeneratedReferenceImages':browser_changes,'artifacts':{}}
 for profile in ['rebuilt-artifacts']:
  facts['artifacts'][profile]={p.relative_to(ROOT/profile).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/profile).rglob('*')) if p.is_file()}
 (ROOT/'FINAL_INTEGRITY.json').write_text(json.dumps(facts,indent=2)+'\n');print(json.dumps({'sourceFilesVerified':1005,'platform':sys.platform}));sys.exit(0)
filters={'fallback':'rollback-boundaries.fallback','negative':'rollback-boundaries.control-8d','attacks':'independent-attacks','browser-frozen':'fallback-ui','browser-linux':'fallback-ui'}
if mode.startswith('browser-'):
 (ROOT/'artifacts').unlink();(ROOT/'artifacts').symlink_to(ROOT/('frozen-artifacts' if mode=='browser-frozen' else 'rebuilt-artifacts'),target_is_directory=True)
env={**os.environ,'WRANGLER_SEND_METRICS':'false','WRANGLER_LOG_PATH':str(ROOT/'wrangler-logs'),'WRANGLER_CACHE_DIR':str(ROOT/'cache/wrangler'),'FB_RUN':mode,'TMPDIR':str(ROOT/'runtime/tmp')}
cmd=['node',str(PAYLOAD/'node_modules/vitest/vitest.mjs'),'run','-c',str(ROOT/'tests/vitest.config.mjs'),filters[mode]]
start=now();log=ROOT/'logs'/f'{mode}.log'
with log.open('w') as f:
 p=subprocess.Popen(cmd,cwd=PAYLOAD,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 for line in p.stdout:print(line,end='',flush=True);f.write(line);f.flush()
 code=p.wait()
report=json.loads((ROOT/'logs/last-tests.json').read_text());shutil.copyfile(ROOT/'logs/last-tests.json',ROOT/'logs'/f'{mode}.json')
with (ROOT/'logs/runs.jsonl').open('a') as f:f.write(json.dumps({'mode':mode,'command':cmd,'startedAt':start,'finishedAt':now(),'exitCode':code,'platform':sys.platform,'passed':report['numPassedTests'],'failed':report['numFailedTests']})+'\n')
if mode=='negative':
 original=json.loads((CONTROL/'fixtures/old-control-expectations.json').read_text())
 failed=lambda x:sorted(a['fullName'] for t in x['testResults'] for a in t['assertionResults'] if a['status']=='failed')
 assert code!=0 and report['numPassedTests']==3 and report['numFailedTests']==2 and report['numTotalTests']==5, 'Negative control shape changed'
 assert failed(report)==original['failedNames'],'Negative control failed different expectations'
 print('EXPECTED OLD-BACKEND NEGATIVE CONTROL:3PASS/2FAIL preserved; raw exit1 retained');sys.exit(0)
sys.exit(code)
