# Use a fresh isolated persist directory for each complete run.
exec(open('/tmp/pr30-a858-do/check.py').read().split('rows=[]')[0])
rows=[]
for kind in ['apply','delete']:
 p=f'/{kind}-after-events';assert get(p+'?op=init')[0]==200
 code,f=get(p+'?op=fault&at=after-events');assert code==500 and f['hit']
 assert f['after']==f['before']
 _,re=get(p+'?op=restart');assert re['after']==f['before']
 _,sent=get(p+'?op=send');assert sent['result']['ok'];assert sent['after']['view']['commit']==f['before']['view']['commit']+1
 _,again=get(p+'?op=send');assert again['after']['view']['commit']==sent['after']['view']['commit']
 _,end=get(p+'?op=restart');assert end['after']['view']==sent['after']['view']
 rows.append({'kind':kind,'fault':'after_commit/deck_dirty','fault_http':code,'all_rows_unchanged':True,'retry_commit':sent['after']['view']['commit'],'status':'PASS'})
Path('/tmp/pr30-a858-do/extra-results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows,indent=2))
