// 把 content/flows.json 里的 KV 模拟脚本跑一遍，检查每一步的实际结果
// 与脚本里的说明是否一致。模拟器是 kvcache/radix_cache.py 与 scheduler/cache.py
// 的移植，所以这里实际是在核对「说明文字」与「真实算法」是否吻合。
//
// 用法：npm run check:scenario

import { readFileSync } from "node:fs";
import { CacheSim } from "../.tmp/simulator.mjs";

const contentPath = new URL("../../content/flows.json", import.meta.url);
const content = JSON.parse(readFileSync(contentPath, "utf8"));
const scenario = content.kv_scenario;

const sim = new CacheSim({ ...scenario.params });
sim.prime(scenario.ops);

let abnormal = 0;
scenario.ops.forEach((op, i) => {
  const r = sim.runOp(op);
  const snap = sim.snapshot();
  const flag = r.error ? "错误" : r.divergence ? "分歧" : "通过";
  if (r.error || r.divergence) abnormal++;
  console.log(
    `${String(i + 1).padStart(2)} ${flag} ${op.op.padEnd(11)} 空闲 ${String(snap.freePages).padStart(2)} 页  可淘汰 ${String(snap.evictable).padStart(2)}  受保护 ${String(snap.protectedT).padStart(2)}`
  );
  console.log(`     ${r.message ?? ""}`);
  if (r.divergence) console.log(`     说明与算法不一致：${r.divergence}`);
  if (r.error) console.log(`     算法报错：${r.error}`);
});

const fin = sim.snapshot();
console.log(`\n共 ${scenario.ops.length} 步，异常 ${abnormal} 步`);
console.log(`完整性：${fin.integrity ?? "(未检查)"}`);
if (abnormal > 0) {
  console.error("\n模拟脚本与算法存在分歧，需修正 content/flows.json");
  process.exit(1);
}
