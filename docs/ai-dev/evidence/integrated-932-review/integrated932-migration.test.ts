import {expect,it} from '/workspace/ts-integrated932-backend/node_modules/vitest/dist/index.js';
import {onboarded} from '/workspace/ts-integrated932-backend/test/hub/harness';
import {migrate} from '/workspace/ts-integrated932-backend/src/worker/hub/schema';
it('migration 5 to 6 is additive, retains existing tables, and can restart',async()=>{
 const h=await onboarded({tracks:40});
 const dump=()=>JSON.stringify(['plays','memory','stations','pages','playback_sessions'].map(t=>h.sql.all(`SELECT * FROM ${t} ORDER BY 1`)));
 const before=dump();
 h.sql.run('DROP TABLE listen_pages'); h.sql.run("UPDATE kv SET v='5' WHERE k='schema_version'");
 migrate(h.sql); expect(dump()).toBe(before);
 expect(h.sql.first<{v:string}>("SELECT v FROM kv WHERE k='schema_version'")?.v).toBe('6');
 h.restart(); expect(dump()).toBe(before);
});
