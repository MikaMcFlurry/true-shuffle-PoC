import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'cloudflare:workers':'/tmp/profile22-workers-stub.ts'}},test:{include:['test/hub/next22-independent.test.ts','test/hub/listening-profile.test.ts','test/worker/genre-userhub.test.ts'],environment:'node',testTimeout:20000,silent:'passed-only'}});
