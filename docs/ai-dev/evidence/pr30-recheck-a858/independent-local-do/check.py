import json,urllib.request,urllib.error
from pathlib import Path
B='http://127.0.0.1:19590'
def get(p):
 try:r=urllib.request.urlopen(B+p)
 except urllib.error.HTTPError as e:r=e
 return r.status,json.load(r)
rows=[]
for kind,point in [('profile','counter'),('profile','after-profile'),('events','mid-events'),('events','counter'),('events','after-events'),('totals','counter')]:
 p=f'/{kind}-{point}'
 assert get(p+'?op=init')[0]==200
 code,f=get(p+'?op=fault&at='+point)
 assert code==500 and f['hit'] and not f['result']['ok']
 assert f['after']['view']==f['before']['view']
 before=dict(json.loads(f['before']['stored']));after=dict(json.loads(f['after']['stored']))
 changed=[t for t in before if before[t]!=after[t]]
 if kind!='totals':assert changed==[]
 else:assert changed==['hist_stage']
 _,re=get(p+'?op=restart');assert re['after']['view']==f['before']['view']
 _,sent=get(p+'?op=send');assert sent['result']['ok']
 assert sent['after']['view']['commit']==f['before']['view']['commit']+1
 _,again=get(p+'?op=send');assert again['after']['view']['commit']==sent['after']['view']['commit']
 if kind!='profile':assert not again['result']['ok']
 _,end=get(p+'?op=restart');assert end['after']['view']['commit']==sent['after']['view']['commit']
 rows.append({'kind':kind,'fault':point,'status':'PASS_published_state','fault_http':code,'changed_tables':changed,'before_commit':f['before']['view']['commit'],'after_retry_commit':sent['after']['view']['commit'],'published_songs':sent['after']['view']['dataset']['songs'],'published_pages':len(dict(json.loads(sent['after']['stored']))['hist_pages'])})
Path('/tmp/pr30-a858-do/results.json').write_text(json.dumps(rows,indent=2))
print(json.dumps(rows,indent=2))
