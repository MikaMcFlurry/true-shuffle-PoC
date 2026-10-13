import json,tomllib,urllib.request,os,email,email.policy,hashlib,subprocess,concurrent.futures
from pathlib import Path
p=Path('/tmp/ts-cf-private'); token=tomllib.loads((Path.home()/'.config/.wrangler/config/default.toml').read_text())['oauth_token'];url='https://api.cloudflare.com/client/v4/accounts/72c36b58b6a708fb6ddb61d30d2e2049/workers/scripts/true-shuffle'
r=urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token}),timeout=25);data=r.read();f=p/'pr29-content.data';f.write_bytes(data);os.chmod(f,0o600)
boundary=data.split(b'\r\n',1)[0].strip(b'-').decode();msg=email.message_from_bytes(('Content-Type: multipart/form-data; boundary='+boundary+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data,policy=email.policy.default)
parts=[x.get_payload(decode=True) for x in msg.iter_parts() if x.get_filename()=='index.js' or x.get_param('name',header='content-disposition')=='index.js'];assert len(parts)==1
actual=parts[0];local=Path('/tmp/pr29-worker/index.js').read_bytes();norm=local.replace(b'../ts-review-4b0a/node_modules/',b'node_modules/');proof={'source':'8d62138184be9397ea22d55170928a4edbbc0725','actual_sha256':hashlib.sha256(actual).hexdigest(),'byte_exact':actual==local,'dependency_prefix_only_equal':actual==norm,'normalization':'Only local ../ts-review-4b0a/node_modules/ → node_modules/ path prefix'};Path('/tmp/pr29-worker-proof.json').write_text(json.dumps(proof,indent=2));print(proof)
checks={}
for name in ['settings','namespaces','secrets']:
 checks[name+'_same']=json.loads((p/('watch29-'+name+'.json')).read_text())==json.loads((p/('watch28live-'+name+'.json')).read_text())
v=json.loads((p/'watch29-version.json').read_text())['result']['resources'];old=json.loads((p/'watch28live-version.json').read_text())['result']['resources'];checks['runtime_same']=v['script_runtime']==old['script_runtime'];checks['full_bindings_same']=v['bindings']==old['bindings'];Path('/tmp/pr29-preservation.json').write_text(json.dumps(checks,indent=2));print(checks)
