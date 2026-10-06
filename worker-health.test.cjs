const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/lrneo-team-points-worker.js', 'utf8');
function harness(partners, read, saved) {
  const logs = []; let writes = 0; let closed = 0;
  const context = { console: { log: x => logs.push(x), warn() {}, error() {} }, process: { exitCode: 0 },
    fetchPartners: async () => partners, fetchUsers: async () => [{ username: 'fixture' }],
    env: (_, fallback) => fallback, clean: x => String(x || '').trim(), cookieHeaderToCookies: () => [],
    openAline: async () => {}, readPartner: read, reportWorkerFailure: async () => {},
    appPost: async (_, payload) => { writes++; assert(payload.results.every(x => x.ok)); return saved; },
    chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => ({}) }), close: async () => { closed++; } }) }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function runUser('), source.lastIndexOf('main().catch')), context);
  return { context, logs, counts: () => ({ writes, closed }) };
}
test('partial run preserves committed counts and reports failure truthfully', async () => {
  let attempts = 0;
  const h = harness([{lr_partner_id:'HU123456'}, {lr_partner_id:'HU654321',derived_user_id:2}],
    async (_, p) => { attempts++; return {...p,ok:p.lr_partner_id==='HU123456',total_points:10}; },
    {complete:false,saved:1,derived_saved:0,missing:1});
  await h.context.main();
  const result = JSON.parse(h.logs.at(-1));
  assert.equal(result.ok,false); assert.equal(result.state,'partial'); assert.equal(result.saved,1);
  assert.equal(result.results[0].found,1); assert.equal(h.context.process.exitCode,1);
  assert.equal(attempts,3); assert.equal(h.counts().closed,1);
});
test('transient target retry and complete derived writes succeed', async () => {
  let attempts=0;
  const h=harness([{lr_partner_id:'HU123456',derived_user_id:2}],async (_,p)=>({...p,ok:++attempts>1,total_points:0}),
    {complete:true,saved:2,derived_saved:1,missing:0});
  await h.context.main(); assert.equal(JSON.parse(h.logs.at(-1)).ok,true); assert.equal(attempts,2);
});
test('genuine zero month for multiple partners is valid', async () => {
  const h=harness([1,2,3].map(id=>({lr_partner_id:'HU12345'+id})),async (_,p)=>({...p,ok:true,total_points:0}),
    {complete:true,saved:3,missing:0});
  await h.context.main(); assert.equal(JSON.parse(h.logs.at(-1)).ok,true); assert.equal(h.counts().writes,1);
});
test('missing derived write cannot be reported complete', async () => {
  const h=harness([{lr_partner_id:'HU123456',derived_user_id:2}],async (_,p)=>({...p,ok:true,total_points:10}),
    {complete:true,saved:1,derived_saved:0});
  await h.context.main(); assert.equal(JSON.parse(h.logs.at(-1)).ok,false);
});
test('main snapshot workflow fails if any user is incomplete', async () => {
  const main=fs.readFileSync(__dirname+'/lrneo-worker.js','utf8'); const logs=[];
  const c={console:{log:x=>logs.push(x),error(){}},env:(_,v)=>v,MODE:'snapshot',ONLY_USERNAME:'',
    fetchUsersFromApp:async()=>[{username:'one'},{username:'two'}],
    refreshSnapshotViaApp:async username=>({ok:username==='one'}),process:{exit:code=>{c.exit=code}},reportWorkerFailure:async()=>{}};
  vm.createContext(c); vm.runInContext(main.slice(main.indexOf('async function main()'),main.indexOf('async function scrapeTeamPoints(')),c);
  await c.main();assert.equal(JSON.parse(logs.at(-1)).ok,false);assert.equal(c.exit,1);
});
