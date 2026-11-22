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
    const projectArgs = runtime.binary ? [] : ["--path",root,"--log-file",path.join(dir,"engine.log"),"-s","res://tools/web/care_referee.gd"];
    await execFile(runtime.binary || process.env.GODOT_BIN, ["--headless",...projectArgs,"--",input,output], {timeout:30000,windowsHide:true,
      env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, HOME:dir, APPDATA:dir, LOCALAPPDATA:dir, XDG_DATA_HOME:dir}});
    return JSON.parse(await fs.readFile(output,"utf8"));
  } finally {
    await fs.rm(dir, {recursive:true,force:true});
  }
}

module.exports = {calculate};