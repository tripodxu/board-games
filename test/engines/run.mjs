/* test/engines/run.mjs — 纯 Node 引擎自检与金样差分入口（不依赖任何测试框架）
 *
 * 用法：
 *   node test/engines/run.mjs              # 跑全部用例
 *   node test/engines/run.mjs 差分          # 只跑名字含「差分」的用例
 *   node test/engines/run.mjs --list       # 只列用例名
 *
 * 退出码：0 = 全绿，1 = 有失败（npm script / CI 直接可用）。
 */
import { runSuites, report, ALL_MODULES } from './runner.mjs';

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const filter = argv.filter((a) => a[0] !== '-')[0] || '';

const res = await runSuites({ modules: ALL_MODULES, filter, listOnly });
process.exit(report(res, '引擎自检 + 战术/版本 + 金样差分', listOnly));
