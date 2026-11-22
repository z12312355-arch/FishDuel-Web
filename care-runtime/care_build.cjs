"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {promisify} = require("node:util");
const {gunzip} = require("node:zlib");
const {calculate} = require("./care_calculate.cjs");

async function build() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"fishduel-build-"));
  try {
    const binary = path.join(dir,"godot");
    await fs.writeFile(binary,await promisify(gunzip)(await fs.readFile(path.join(__dirname,"linux.gz"))),{mode:0o700});
    await fs.copyFile(path.join(__dirname,"referee.pck"),binary+".pck");
    const smoke = await calculate({action:"inspect",payload:"AAAAAA=="},{binary});
    if (smoke.valid !== false) throw new Error("Unexpected referee smoke result.");
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
  const assets = JSON.parse(await fs.readFile(path.join(__dirname,"site-files.json"),"utf8"));
  await fs.mkdir("public",{recursive:true});
  for (const name of assets) {
    if (name !== path.basename(name)) throw new Error("Invalid public asset.");
    await fs.copyFile(name,path.join("public",name));
  }
}
build().catch(error=>{
  console.error("Settlement build failed:",error.code || error.name);
  if (error.cmd && error.cmd.includes("--headless")) console.error(String(error.stderr || error.stdout).slice(-3500));
  process.exitCode=1;
});
