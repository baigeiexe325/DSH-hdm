// 修复 package.json 描述里的乱码（只改 description 字段，保持其余格式与字段不变）。
import fs from "node:fs";

const p = process.argv[2];
const raw = fs.readFileSync(p, "utf8");
const json = JSON.parse(raw);
json.description =
  "HDM — Human-like Declarative Memory for DeepSeek Harness: file-based long-term memory with sequential snapshots, keyness retrieval, diary, IAM, character profiles and immortal memories.";
fs.writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`);
console.log("description fixed");
