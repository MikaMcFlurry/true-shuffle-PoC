import subprocess,json
base='https://true-shuffle.mikahertler-72c.workers.dev'
cases=[('health','GET','/api/health',None),('state','GET','/api/state',None),('devices','GET','/api/devices',None),('history','GET','/api/history',None),('protected_command','POST','/api/player/pause','{}'),('foreign_origin','POST','/api/player/pause','{}'),('native','GET','/api/native/devices',None),('profile','GET','/api/profile',None),('listens_unsigned','POST','/api/history/listens','{}'),('listens_marker','POST','/api/history/listens','{}')]
out=[]
for name,method,path,data in cases:
 args=['curl','-sS','-D','/tmp/ts932-headers','-o','/tmp/ts932-body','-w','%{http_code}','-X',method,base+path]
 if data is not None:args+=['-H','Content-Type: application/json','--data',data]
 if name=='listens_marker':args+=['-H','x-ts: 1']
 if name=='foreign_origin':args+=['-H','Origin: https://untrusted.example']
 code=subprocess.check_output(args).decode();body=open('/tmp/ts932-body').read();out.append({'case':name,'http':code,'body':body[:300]})
open('/tmp/ts932-public-auth.json','w').write(json.dumps(out,indent=2));print(json.dumps(out))
