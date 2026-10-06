/**
 * D1 数据访问层统一出口。
 *
 * 路由只从这里 import：一旦某个模块被替换/拆分（例如 P4 把导入路径单独拆出去），
 * 改一处即可，不用去 grep 每个路由的深路径。
 */

export {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_PAYLOAD_BYTES,
  getGame,
  getGameByUidPrefix,
  insertGame,
  listGameDetails,
  listGames,
  parseGamePayload,
} from './games.ts';
export type {
  Game,
  GameDetail,
  GameDetailPage,
  GameInput,
  GameMove,
  GameMoveInput,
  GamePage,
  GameRef,
  GameRow,
  GameWithMoves,
  InsertGameResult,
  ListGamesFilter,
} from './games.ts';

export {
  DEFAULT_EXPERIMENT_LIMIT,
  MAX_EXPERIMENT_LIMIT,
  listExperiments,
  parseExperimentGames,
  upsertExperiment,
} from './experiments.ts';
export type { ExperimentInput, ExperimentRow } from './experiments.ts';

export { getDevice, touchDevice } from './devices.ts';
export type { DeviceRow, TouchDeviceInput } from './devices.ts';

export { CAL_SAMPLE_LIMIT, getStats } from './stats.ts';
export type { CalRecord, StatsOptions, StatsResult } from './stats.ts';

export { hitRateLimit, pruneRateLimits, windowStartOf } from './ratelimit.ts';
export type { RateLimitResult } from './ratelimit.ts';
