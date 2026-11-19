// 生成"启动安全版" profile patch：从 known-good 字节里删掉末尾 HDM insert 块。
import fs from "node:fs";

const dir = process.argv[2];
const good = `${dir}/known-good-cordis.patch.yml`;
const safe = `${dir}/safe-cordis.patch.yml`;
const buf = fs.readFileSync(good);

// 只认末尾的 hdm 行（兼容 LF/CRLF），按字节截断，避免重新编码中文注释。
const marker = Buffer.from("\n- insert:\n    - id: hdm");
const idx = buf.lastIndexOf(marker);
if (idx >= 0) {
  const out = buf.subarray(0, idx + 1);
  fs.writeFileSync(safe, out);
  console.log("removed HDM insert block; safe bytes:", out.length);
} else {
  fs.copyFileSync(good, safe);
  console.log("HDM insert block not found; copied known-good as safe");
}
