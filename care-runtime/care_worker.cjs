"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {promisify} = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const root = path.resolve(__dirname, "../..");

async function calculate(job, runtime = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fishduel-care-"));
  try {
    const input = path.join(dir, "job.json"), output = path.join(dir, "result.json");
    await fs.writeFile(input, JSON.stringify(job), {mode:0o600});
    const projectArgs = runtime.pack ? ["--main-pack",runtime.pack] : ["--path",root];
    await execFile(runtime.binary || process.env.GODOT_BIN, ["--headless",...projectArgs,"--log-file",path.join(dir,"engine.log"),
      "-s","res://tools/web/care_referee.gd","--",input,output], {timeout:30000,windowsHide:true,
      env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, HOME:dir, APPDATA:dir, LOCALAPPDATA:dir, XDG_DATA_HOME:dir}});
    return JSON.parse(await fs.readFile(output,"utf8"));
  } finally {
    await fs.rm(dir, {recursive:true,force:true});
  }
}

// Call inside one transaction. The lock elects one worker for the current job.
async function processOne(db, inspect = calculate, owner = null) {
  const first = async (sql,args) => (await db.query(sql,args)).rows[0];
  if (!(await first("select pg_try_advisory_xact_lock(26718041) as locked")).locked) {
    if (owner) throw new Error("settlement_busy");
    return false;
  }
  const old = await first(`select l.* from fishduel_care.legacy_save l left join fishduel_care.wallet w using(owner)
    where w.owner is null and l.import_error is null and ($1::uuid is null or l.owner=$1) order by l.owner limit 1`,[owner]);
  if (old) {
    const src = await inspect({action:"inspect",payload:old.payload});
    if (!src.valid) {
      await db.query("update fishduel_care.legacy_save set import_error='invalid_save' where owner=$1",[old.owner]);
      console.error("Frozen save requires operator review. Original retained.");
    } else {
      await db.query("select fishduel_care.import_legacy($1,$2,$3,$4,$5,$6)",
        [old.owner,old.revision,src.coins,src.fish,JSON.stringify(src.bait),src.cleared]);
    }
    return true;
  }
  const job = await first("select * from fishduel_care.cup_job where state='ready' and ($1::uuid is null or owner=$1) order by entered_at limit 1 for update",[owner]);
  if (job) {
    const result = await inspect({action:"cup",fish:job.fish_id,stage:job.event,seed:job.seed,affection:job.affection,payload:job.payload});
    if (result.valid && result.won) await db.query("select fishduel_care.credit_cup_win($1,$2,$3)",[job.owner,job.ticket,job.event]);
    await db.query("update fishduel_care.cup_job set state=$1,payload=null where ticket=$2",[result.valid?"done":"invalid",job.ticket]);
    return true;
  }
  const save = await first(`select s.* from public.fishduel_save s left join fishduel_care.roster_sync r on r.owner=s.player
    where ($1::uuid is null or s.player=$1) and r.revision is distinct from s.revision and not exists(select 1 from fishduel_care.legacy_save l
      where l.owner=s.player and l.import_error is not null) order by s.revision limit 1`,[owner]);
  if (!save) return false;
  const state = save.payload ? await inspect({action:"inspect",payload:save.payload}) : {valid:true,fish:[]};
  if (state.valid) {
    await db.query("insert into fishduel_care.wallet values($1,0) on conflict do nothing",[save.player]);
    await db.query("update fishduel_care.fish set active=false where owner=$1 and active and not(fish_id=any($2::text[]))",
      [save.player,state.fish]);
    await db.query(`insert into fishduel_care.fish(owner,fish_id) select $1,unnest($2::text[])
      on conflict(owner,fish_id) do update set active=true`,[save.player,state.fish]);
  }
  await db.query(`insert into fishduel_care.roster_sync values($1,$2)
    on conflict(owner) do update set revision=excluded.revision`,[save.player,save.revision]);
  return true;
}

async function run() {
  const {Client} = require("pg");
  if (!process.env.CARE_DATABASE_URL || !process.env.GODOT_BIN) throw new Error("Set CARE_DATABASE_URL and GODOT_BIN.");
  for (;;) {
    const client = new Client({connectionString:process.env.CARE_DATABASE_URL});
    try {
      await client.connect();
      for (;;) {
        await client.query("begin");
        const more = await processOne(client);
        await client.query("commit");
        if (!more) break;
      }
    } catch (error) {
      // Closing the connection rolls back interrupted work. Never log player payloads.
      console.error("Care transaction interrupted", error.code || error.name);
      if (process.argv.includes("--once")) throw error;
    } finally {
      await client.end();
    }
    if (process.argv.includes("--once")) return;
    await new Promise(resolve => setTimeout(resolve,3000));
  }
}
module.exports = {processOne, calculate};
if (require.main === module) run().catch(() => {process.exitCode=1;});
