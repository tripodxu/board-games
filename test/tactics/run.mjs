/* test/tactics/run.mjs — 战术实验室用例入口（计划 §6.4：mock 集成对局与 jev-client 用例迁 test/tactics/）
 *
 * 用例主体与 `test/engines/*.test.mjs` 共用一份，这里只收窄到「战术版本闸门 + 十三级接管链 + VCF soundness
 * + Jev 客户端（重试/回退/topK/probe）」两个模块，避免维护两套夹具。
 *
 * 用法：
 *   node test/tactics/run.mjs            # 战术 + Jev 客户端全部用例
 *   node test/tactics/run.mjs vcf         # 只跑名字含 vcf 的用例
 *   node test/tactics/run.mjs --list
 */
import { runSuites, report, TACTICS_MODULES } from '../engines/runner.mjs';

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const filter = argv.filter((a) => a[0] !== '-')[0] || '';

const res = await runSuites({ modules: TACTICS_MODULES, filter, listOnly });
process.exit(report(res, '战术版本闸门 + 接管链 + VCF soundness + Jev 客户端', listOnly));
