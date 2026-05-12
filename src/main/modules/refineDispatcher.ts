import log from 'electron-log/main'
import type { CliKind } from '@shared/ipc'
import { getAdapter } from './cliAdapter'
import { getCliPath } from './envProbe'
import type { SpawnRefineResult } from './cliAdapter/types'
import {
  getQuotaSnapshot,
  looksLikeQuotaError,
  markForcedFallback,
  type QuotaSnapshot
} from './geminiQuotaTracker'
import { loadSettings, type RefineModelPolicy } from './settings'

// RefineDispatcher — M3 N 청크. architecture §14.7.
//
// refine LLM 선택 + 폴백 정책을 단일 모듈로 통합. ir:refine / handoff:prepare 호출자는
// 어댑터를 직접 잡지 않고 dispatcher.runRefine()으로 위임.
//
// 정책 (B+C 결합):
//   B = 가용성 폴백: gemini 미설치 / quota 초과 → 활성 모델로 자동 폴백
//   C = 사용자 명시 override: settings.refineModel으로 강제 선택. 단 'gemini-flash' 명시 시에도
//       가용성 미충족이면 폴백 (사용자 답답함보단 동작 우선)
//
// auto 모드 결정 트리:
//   1. settings.refineModel='off' → off 반환
//   2. settings.refineModel='active' → activeModel 헤드리스
//   3. settings.refineModel='gemini-flash' → gemini-flash 시도, 가용성 미충족 시 폴백
//   4. settings.refineModel='auto' → gemini 가용 + quota OK면 gemini-flash, 아니면 activeModel
//
// quota 처리 (2026-05-11 재설계):
//   - 카운터 증가 X — gemini 1 spawn = N requests일 수 있어 부정확. 진실의 원천은 gemini footer의 "% used"
//   - 호출 전 getQuotaSnapshot() — usedPercent ≥ 95% 또는 forcedFallback이면 사전 폴백
//   - 응답에 quota 키워드 검출 시 markForcedFallback (자정 UTC 자동 해제)
//   - 폴백은 같은 호출 안에서 1회만

export type RefineModelChoice = {
  // 실제 spawn된 어댑터 종류.
  spawnedModel: CliKind
  // refine 결과 + dispatcher 메타.
  result: SpawnRefineResult
  // 사용자가 의도한 모델(settings.refineModel)이 가용성 미충족으로 다른 모델로 폴백됐는지.
  fallback: boolean
  fallbackReason?: 'gemini-unavailable' | 'gemini-quota' | 'user-policy'
  policy: RefineModelPolicy
  // gemini 시도 후 quota 정보(있을 때만).
  quotaAfter?: QuotaSnapshot
}

export type RefineDispatchArgs = {
  // 활성 모델 — 'auto' / 'active' 정책 시 폴백 후보로 사용.
  activeModel: CliKind
  prompt: string
  cwd?: string
  abortSignal?: AbortSignal
  timeoutMs?: number
}

// off 모드 — refine 안 함. 호출자는 empty IR로 처리.
export class RefineOffError extends Error {
  constructor() {
    super("refine 비활성 (settings.refineModel='off')")
    this.name = 'RefineOffError'
  }
}

async function runWith(model: CliKind, args: RefineDispatchArgs): Promise<SpawnRefineResult> {
  const adapter = getAdapter(model)
  return adapter.spawnRefineIR({
    prompt: args.prompt,
    cwd: args.cwd,
    abortSignal: args.abortSignal,
    timeoutMs: args.timeoutMs
  })
}

// gemini 시도가 성공이라고 판정 가능한 조건: assistant 본문 받음 + quota 에러 아님.
function isQuotaFailure(result: SpawnRefineResult): boolean {
  return looksLikeQuotaError(result.stderr, result.assistantText, result.exitCode)
}

export async function runRefine(args: RefineDispatchArgs): Promise<RefineModelChoice> {
  const settings = await loadSettings()
  const policy = settings.refineModel

  if (policy === 'off') {
    throw new RefineOffError()
  }

  if (policy === 'active') {
    log.info('RefineDispatcher — active 정책', { activeModel: args.activeModel })
    const result = await runWith(args.activeModel, args)
    return { spawnedModel: args.activeModel, result, fallback: false, policy }
  }

  // 이하 'auto' / 'gemini-flash' — gemini 우선, 가용성 폴백 가능.
  const wantGemini = policy === 'auto' || policy === 'gemini-flash'
  if (!wantGemini) {
    // unreachable — TS exhaustiveness
    const result = await runWith(args.activeModel, args)
    return { spawnedModel: args.activeModel, result, fallback: false, policy }
  }

  const geminiAvailable = !!getCliPath('gemini')
  if (!geminiAvailable) {
    log.info('RefineDispatcher — gemini 미설치 폴백', {
      policy,
      fallbackTo: args.activeModel
    })
    const result = await runWith(args.activeModel, args)
    return {
      spawnedModel: args.activeModel,
      result,
      fallback: true,
      fallbackReason: 'gemini-unavailable',
      policy
    }
  }

  const quotaBefore = await getQuotaSnapshot()
  if (quotaBefore.shouldFallback) {
    log.info('RefineDispatcher — gemini quota 한도 폴백 (spawn 전)', {
      policy,
      severity: quotaBefore.severity,
      usedPercent: quotaBefore.usedPercent,
      forcedFallback: quotaBefore.forcedFallback,
      fallbackTo: args.activeModel
    })
    const result = await runWith(args.activeModel, args)
    return {
      spawnedModel: args.activeModel,
      result,
      fallback: true,
      fallbackReason: 'gemini-quota',
      policy,
      quotaAfter: quotaBefore
    }
  }

  // gemini 시도 — 카운터 증가 X (footer 캡처가 진실의 원천). 응답 후 quota 에러 감지로만 사후 폴백.
  log.info('RefineDispatcher — gemini-flash 시도', {
    policy,
    usedPercent: quotaBefore.usedPercent,
    severity: quotaBefore.severity
  })
  let geminiResult: SpawnRefineResult
  try {
    geminiResult = await runWith('gemini', args)
  } catch (err) {
    // spawn 자체 실패 (CLI 누락 등) — active 폴백
    log.warn('RefineDispatcher — gemini spawn 실패 폴백', {
      err: String(err),
      fallbackTo: args.activeModel
    })
    const result = await runWith(args.activeModel, args)
    return {
      spawnedModel: args.activeModel,
      result,
      fallback: true,
      fallbackReason: 'gemini-unavailable',
      policy,
      quotaAfter: quotaBefore
    }
  }

  if (isQuotaFailure(geminiResult)) {
    // gemini 응답에 quota 키워드 검출 — 강제 폴백 마킹 + active 폴백.
    const afterMark = await markForcedFallback()
    log.warn('RefineDispatcher — gemini 응답 quota 에러 → active 폴백', {
      stderrSlice: geminiResult.stderr.slice(0, 200)
    })
    const result = await runWith(args.activeModel, args)
    return {
      spawnedModel: args.activeModel,
      result,
      fallback: true,
      fallbackReason: 'gemini-quota',
      policy,
      quotaAfter: afterMark
    }
  }

  return {
    spawnedModel: 'gemini',
    result: geminiResult,
    fallback: false,
    policy,
    quotaAfter: quotaBefore
  }
}
