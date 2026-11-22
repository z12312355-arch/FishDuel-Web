"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {gunzip} = require("node:zlib");
const {promisify} = require("node:util");
const {processOne, calculate} = require("./care_worker.cjs");
const {Client} = require("pg");
let runtime;

async function getRuntime() {
  if (!runtime) runtime = (async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(),"fishduel-engine-"));
    const binary = path.join(folder,"godot");
    const assets = path.join(process.cwd(),"care-runtime");
    await fs.writeFile(binary, await promisify(gunzip)(await fs.readFile(path.join(assets,"linux.gz"))),{mode:0o700});
    await fs.copyFile(path.join(assets,"referee.pck"),binary+".pck");
    return {binary};
  })().catch(error => { runtime = null; throw error; });
  return runtime;
}

module.exports = async function settle(req,res) {
  res.setHeader("Cache-Control","private, no-store");
  if (req.method !== "POST") return res.status(405).end();
  const bearer = req.headers.authorization || "";
  if (!/^Bearer [A-Za-z0-9._-]{20,16000}$/.test(bearer)) return res.status(401).end();
  let db;
  try {
    const cfg = require("../cloud-config.json");
    const response = await fetch(new URL("/auth/v1/user",cfg.url),{
      headers:{authorization:bearer,apikey:cfg.key},signal:AbortSignal.timeout(5000),redirect:"error"
    });
    if (!response.ok) return res.status(response.status===401 || response.status===403 ? 401 : 503).end();
    const user = await response.json();
    // Supabase verified this exact bearer above. Apply the same AMR and
    // provider restrictions as fishduel_google_access.has_google_session().
    const claims = JSON.parse(Buffer.from(bearer.slice(7).split(".")[1],"base64url"));
    if (claims.sub !== user.id || !/^[0-9a-f-]{36}$/i.test(user.id) ||
        !claims.app_metadata?.providers?.includes("google") ||
        !claims.amr?.some(item=>item.method==="oauth")) return res.status(403).end();
    const url = new URL(process.env.CARE_DATABASE_URL);
    if (!/^fishduel_settler(?:\.|$)/.test(url.username) || url.searchParams.get("sslmode") !== "verify-full") throw new Error("configuration");
    db = new Client({connectionString:url.href,connectionTimeoutMillis:5000});
    await db.connect();
    // A player can have one opening balance, one pending match and one roster refresh.
    for (let i=0;i<3;i++) {
      await db.query("begin");
      const worked = await processOne(db,async job=>calculate(job,await getRuntime()),user.id);
      await db.query("commit");
      if (!worked) break;
    }
    return res.status(204).end();
  } catch {
    return res.status(503).end();
  } finally {
    if (db) await db.end().catch(()=>{});
  }
};
