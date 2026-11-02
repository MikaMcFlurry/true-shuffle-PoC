from pathlib import Path
import urllib.request,hashlib,json,concurrent.futures,subprocess
root=Path('/workspace/ts-review-93241/dist/client');base='https://true-shuffle.mikahertler-72c.workers.dev/'
files=[p for p in root.rglob('*') if p.is_file() and p.name!='_headers']
def check(p):
 rel=str(p.relative_to(root));data=subprocess.check_output(['curl','-fsS','--max-time','25',base+(rel if rel!='index.html' else '')]);return {'path':rel,'match':data==p.read_bytes(),'sha256':hashlib.sha256(data).hexdigest()}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:r=list(ex.map(check,files))
Path('/tmp/ts932-public-assets.json').write_text(json.dumps(r,indent=2));print({'count':len(r),'match':sum(x['match'] for x in r),'failures':[x['path'] for x in r if not x['match']]})
