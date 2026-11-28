"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {gunzip} = require("node:zlib");
const {promisify} = require("node:util");
const {calculate} = require("./care_calculate.cjs");

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
  try {
    const {sign,verify} = await import("./care_signature.mjs");
    const body = req.body;
    if (typeof body !== "string" || body.length > 2300000) return res.status(400).end();
    const secret = process.env.CARE_REFEREE_SECRET;
    if (!await verify(secret,"request",body,req.headers["x-care-signature"])) return res.status(403).end();
    const {nonce,time,job} = JSON.parse(body);
    if (!Number.isSafeInteger(time) || Math.abs(Date.now()-time)>60000 || !["cup","inspect","rank_verify","rank_battle"].includes(job.action)) return res.status(403).end();
    const result = await calculate(job,await getRuntime());
    const reply = JSON.stringify({nonce,result});
    res.setHeader("x-care-signature",await sign(secret,"result",reply));
    return res.status(200).send(reply);
  } catch { return res.status(503).end(); }
};
