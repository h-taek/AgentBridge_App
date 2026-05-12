import { app, BrowserWindow, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import log from 'electron-log/main'
import { IpcChannel } from '@shared/ipc'
import { broadcastToAll } from './windowManager'

// GeminiQuotaTracker — M3 N 청크 재설계 (2026-05-11).
//
// **기존 incrementQuota 방식 폐기**. 이유:
//   - gemini headless 1회 spawn이 *내부적으로 N개의 API 호출*로 분기될 수 있음 (CLI 내부 retry/
//     tool-use loop 등). 우리가 spawn 카운트를 ±1만 하면 underestimation.
//   - 사용자가 외부에서 gemini를 별도 사용하면 카운트 불일치.
//   - 진실의 원천이 gemini 서버에 있고, gemini CLI는 인터랙티브 모드 *footer*에 그 값을 그대로
//     표시: `quota: X% used` ([Gemini CLI Discussion #3096](https://github.com/google-gemini/gemini-cli/discussions/3096)).
//
// 새 정책:
//   - gemini 어댑터 PTY data hook이 footer 라인을 정규식으로 파싱 → `recordQuotaPercent(percent)`로 영속화
//   - 헤드리스 refine 흐름은 `incrementQuota` 호출 안 함 — 단 응답에 quota 에러 감지 시 `markForcedFallback`
//   - severity는 *lastSeenUsedPercent* 기반:
//       null  → 'unknown'  (gemini 탭을 한 번도 안 열음. UI는 안내만)
//       <80%  → 'ok'
//       80~94 → 'warn'
//       95~99 → 'critical'
//       >=100 또는 forcedFallback → 'exceeded'
//   - RefineDispatcher는 critical/exceeded 시 자동 폴백
//
// 영속 위치: `~/Library/Application Support/AgentBridge/gemini_quota.json`.

const QUOTA_FILE_NAME = 'gemini_quota.json'

// % used 기반 임계값 (architecture §14.7는 카운터 기반이었지만 footer % 채택에 맞춰 갱신)
export const GEMINI_QUOTA_WARN_PERCENT = 80
export const GEMINI_QUOTA_CRITICAL_PERCENT = 95
export const GEMINI_QUOTA_EXCEEDED_PERCENT = 100

export type QuotaSeverity = 'unknown' | 'ok' | 'warn' | 'critical' | 'exceeded'

export type QuotaSnapshot = {
  // gemini footer에서 마지막으로 캡처한 % used. null이면 아직 한 번도 못 봄.
  usedPercent: number | null
  // 마지막 캡처 시각 (ISO). null이면 한 번도 못 봄.
  lastSeenAt: string | null
  severity: QuotaSeverity
  shouldFallback: boolean
  // gemini 응답 에러로 강제 폴백 마킹된 상태 (자정 UTC 후 자동 해제).
  forcedFallback: boolean
}

type QuotaFile = {
  usedPercent: number | null
  lastSeenAt: string | null
  // UTC 자정 기준 일자. 마지막 갱신 일자가 *오늘이 아니면* forcedFallback 자동 해제.
  forcedFallbackDate: string | null
  forcedFallback: boolean
}

function getQuotaFilePath(): string {
  return path.join(app.getPath('userData'), QUOTA_FILE_NAME)
}

// quota state 변경 시 모든 윈도우에 통보. QuotaSnapshot은 앱 단위 글로벌이라 멀티 윈도우 환경에서
// 어느 윈도우의 footer/IR refine 정책에도 동일 영향 → 전역 fan-out 유지 (M3.6 C broadcast matrix).
function broadcastQuotaUpdated(snap: QuotaSnapshot): void {
  broadcastToAll(IpcChannel.QuotaUpdated, snap)
}

function todayKey(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function severityFor(usedPercent: number | null, forcedFallback: boolean): QuotaSeverity {
  if (forcedFallback) return 'exceeded'
  if (usedPercent == null) return 'unknown'
  if (usedPercent >= GEMINI_QUOTA_EXCEEDED_PERCENT) return 'exceeded'
  if (usedPercent >= GEMINI_QUOTA_CRITICAL_PERCENT) return 'critical'
  if (usedPercent >= GEMINI_QUOTA_WARN_PERCENT) return 'warn'
  return 'ok'
}

function shouldFallbackFor(severity: QuotaSeverity): boolean {
  return severity === 'critical' || severity === 'exceeded'
}

async function readQuotaFile(): Promise<QuotaFile> {
  const p = getQuotaFilePath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<QuotaFile> & {
      // legacy(count 기반) 데이터 호환 — 무시하고 새 schema로 reset.
      count?: number
    }
    return {
      usedPercent: typeof parsed.usedPercent === 'number' ? parsed.usedPercent : null,
      lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : null,
      forcedFallbackDate:
        typeof parsed.forcedFallbackDate === 'string' ? parsed.forcedFallbackDate : null,
      forcedFallback: parsed.forcedFallback === true
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('gemini_quota.json 파싱 실패 — 새 schema로 리셋', { err: String(err) })
    }
  }
  return { usedPercent: null, lastSeenAt: null, forcedFallbackDate: null, forcedFallback: false }
}

async function writeQuotaFile(state: QuotaFile): Promise<void> {
  const p = getQuotaFilePath()
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, p)
}

// forcedFallback 자정 자동 해제 — read 시점에 적용.
function rolloverIfNeeded(state: QuotaFile): QuotaFile {
  if (!state.forcedFallback) return state
  if (state.forcedFallbackDate === todayKey()) return state
  return { ...state, forcedFallback: false, forcedFallbackDate: null }
}

// 모순 케이스 자동 해제 — 최근 캡처된 usedPercent가 critical 미만(<95%)인데 forcedFallback이
// 켜져있으면 false positive로 간주, 강제 해제. looksLikeQuotaError가 자연어 응답에서 quota
// 단어를 우연히 잡았던 경우 한 번 보정.
function reconcileForcedFallback(state: QuotaFile): QuotaFile {
  if (
    state.forcedFallback &&
    typeof state.usedPercent === 'number' &&
    state.usedPercent < GEMINI_QUOTA_CRITICAL_PERCENT
  ) {
    log.info('quota — usedPercent 낮은데 forcedFallback 켜진 모순 감지, 해제', {
      usedPercent: state.usedPercent
    })
    return { ...state, forcedFallback: false, forcedFallbackDate: null }
  }
  return state
}

function snapshotFrom(state: QuotaFile): QuotaSnapshot {
  const severity = severityFor(state.usedPercent, state.forcedFallback)
  return {
    usedPercent: state.usedPercent,
    lastSeenAt: state.lastSeenAt,
    severity,
    shouldFallback: shouldFallbackFor(severity),
    forcedFallback: state.forcedFallback
  }
}

export async function getQuotaSnapshot(): Promise<QuotaSnapshot> {
  const raw = await readQuotaFile()
  const afterRollover = rolloverIfNeeded(raw)
  const afterReconcile = reconcileForcedFallback(afterRollover)
  // rollover 또는 reconcile이 state를 변경했다면 디스크 반영 + 변경 broadcast.
  if (
    afterReconcile.forcedFallback !== raw.forcedFallback ||
    afterReconcile.forcedFallbackDate !== raw.forcedFallbackDate
  ) {
    await writeQuotaFile(afterReconcile)
    const snap = snapshotFrom(afterReconcile)
    broadcastQuotaUpdated(snap)
    return snap
  }
  return snapshotFrom(afterReconcile)
}

// gemini PTY footer에서 캡처한 % used를 영속화. 이전 값과 동일하면 mtime만 갱신(IO 감소 위해 skip).
export async function recordQuotaPercent(percent: number): Promise<QuotaSnapshot> {
  if (!Number.isFinite(percent) || percent < 0 || percent > 1000) {
    // 비정상 값은 무시 (정규식 오인일 가능성).
    return getQuotaSnapshot()
  }
  let state = rolloverIfNeeded(await readQuotaFile())
  // 같은 값이면 lastSeenAt만 갱신해도 의미 없음 — IO 절약을 위해 변화 있을 때만 write.
  if (state.usedPercent === percent) {
    return {
      usedPercent: state.usedPercent,
      lastSeenAt: state.lastSeenAt,
      severity: severityFor(state.usedPercent, state.forcedFallback),
      shouldFallback: shouldFallbackFor(severityFor(state.usedPercent, state.forcedFallback)),
      forcedFallback: state.forcedFallback
    }
  }
  state = {
    ...state,
    usedPercent: percent,
    lastSeenAt: new Date().toISOString()
  }
  // 새 % 캡처가 critical 미만이면 forcedFallback도 자동 해제 (모순 보정).
  state = reconcileForcedFallback(state)
  await writeQuotaFile(state)
  log.info('gemini quota footer 캡처', { usedPercent: percent })
  const snap = snapshotFrom(state)
  broadcastQuotaUpdated(snap)
  return snap
}

// gemini 응답에서 quota exceeded 감지 시 호출. 카운터와 별개로 강제 폴백 마킹.
// 자정(UTC) 자동 해제.
export async function markForcedFallback(): Promise<QuotaSnapshot> {
  let state = rolloverIfNeeded(await readQuotaFile())
  state = { ...state, forcedFallback: true, forcedFallbackDate: todayKey() }
  await writeQuotaFile(state)
  log.warn('gemini quota — 강제 폴백 마킹 (응답 에러 감지)')
  const snap = snapshotFrom(state)
  broadcastQuotaUpdated(snap)
  return snap
}

// gemini PTY raw bytes에서 footer "% used" 라인 캡처용 정규식.
// 인터랙티브 모드 footer 예: " quota   ...   4% used"
// ANSI escape가 끼어있어도 매칭되도록 임의 비-숫자 prefix 허용.
//
// 매칭 우선순위:
//   1. "quota" 단어 + 공백 또는 ANSI + 숫자 + "%" + 공백 + "used"
//   2. 단순 "N% used" — quota 단어 없어도 footer 컨텍스트면 통상 같은 의미 (false positive 방지 위해
//      "quota"가 *최근 N bytes 안*에 있을 때만 적용)
//
// 본 함수는 단일 chunk가 아니라 *최근 누적 라인*에서 검색. 호출자는 ANSI strip 후 마지막 ~4KB 정도만.
const QUOTA_FOOTER_RE = /(\d+)\s*%\s*used/i
const QUOTA_KEYWORD_RE = /quota/i

export function extractQuotaPercent(strippedTail: string): number | null {
  if (!QUOTA_KEYWORD_RE.test(strippedTail)) return null
  const m = QUOTA_FOOTER_RE.exec(strippedTail)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null
  return n
}

// gemini quota 에러 휴리스틱 — 자연어 응답에 'quota' 단어가 우연 등장하는 false positive를
// 막기 위해 *에러 컨텍스트와 결합된 강한 패턴*만 매칭. 또한 assistantText는 exit code != 0일
// 때만 검사한다 (정상 응답 본문은 자연어이므로 quota/429 같은 단어가 토론 주제로 등장 가능).
const QUOTA_STRONG_PATTERNS: RegExp[] = [
  /quota\s*(?:exceeded|exhausted|limit|reached|hit|error)/i,
  /exceed(?:ed|ing)?\s+(?:your\s+)?quota/i,
  /out\s+of\s+quota/i,
  /rate[\s_-]*limit(?:ed|ing|\s+exceeded|\s+reached|\s+error)?/i,
  /resource[\s_-]*exhausted/i,
  /(?:http\s*\/?\s*)?status[:\s]+429\b/i,
  /\b429\s+(?:too\s+many|error|status|response|resource|client)/i,
  /too\s+many\s+requests/i
]

export function looksLikeQuotaError(
  stderr: string,
  assistantText: string,
  exitCode?: number | null
): boolean {
  // stderr는 항상 검사 — 정상 흐름에서 quota 토픽이 stderr로 나갈 일 없음.
  if (QUOTA_STRONG_PATTERNS.some((re) => re.test(stderr))) return true
  // assistantText는 spawn이 실패했을 때(=exit != 0)만 본다.
  // 자연어 응답에 quota/429 단어가 토론 주제로 등장하는 false positive 차단.
  if (exitCode != null && exitCode !== 0) {
    if (QUOTA_STRONG_PATTERNS.some((re) => re.test(assistantText))) return true
  }
  return false
}

// ─── Background quota probe — gemini PTY를 hidden으로 spawn해 footer 캡처 ───
//
// 사용자 확인: gemini 호출 자체로는 quota 소모 안 함. 빈 세션은 gemini가 자동 정리.
// → 우리는 background PTY로 spawn → footer 라인이 그려진 직후 footer 캡처 → SIGTERM.
//
// recursion 가드:
//   - cwd = OS tmpdir 하위 격리 디렉토리 → cwd-local hook(.gemini/settings.json) 없음.
//   - 사용자 글로벌 hook(`~/.gemini/settings.json`)이 우리 helper를 호출할 가능성은 없음(우리는
//     글로벌 무수정). 다른 사용자 hook이 있으면 *그건 사용자 영역*이라 우리가 통제 X.
//
// timeout: 8초. footer는 통상 spawn 후 1~3초 안에 그려짐 ([HANDOFF 메모: gemini cold start ~4초]).
//
// 임포트 순환 회피 — geminiAdapter가 본 모듈을 import하므로 본 모듈이 직접 geminiAdapter를 import
// 하지 않는다. ptySession을 직접 사용 (geminiAdapter.spawnInteractive는 PTY + IR 주입 + thread_id
// 캡처 등 multi-tab 부수 효과까지 묶고 있어 background probe에 부적합).

const PROBE_TIMEOUT_MS = 8_000
const ANSI_STRIP_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

export type ProbeResult = {
  ok: boolean
  // ok=true 시 캡처된 % 포함된 최신 snapshot.
  snapshot: QuotaSnapshot
  // 진단용. ok=false면 사유 (timeout / spawn 실패 등).
  reason?: string
  durationMs: number
}

type ProbeDeps = {
  // ptySession.startPty / killPty 주입 — 순환 import 회피용. main에서 inject.
  startPty: (
    req: { command: string; args: string[]; cwd: string; cols?: number; rows?: number },
    sender: WebContents,
    hooks: { onData?: (data: string) => void; onExit?: () => void }
  ) => { sessionId: string; pid: number }
  killPty: (sessionId: string) => void
  // gemini 절대경로 — null이면 미설치.
  geminiCliPath: string | null
}

let depsCache: ProbeDeps | null = null
export function registerProbeDeps(deps: ProbeDeps): void {
  depsCache = deps
}

function pickAnyWebContents(): WebContents | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents
  }
  return null
}

// In-flight probe 가드 — 다중 trigger 동시 호출 시 중복 spawn 방지.
let inflightProbe: Promise<ProbeResult> | null = null

// 자동 trigger 진입점. lastSeenAt이 maxAgeMs 안이면 즉시 현재 snapshot 반환 (probe skip).
// 사용자 명시 액션("지금 확인" 버튼)은 maxAgeMs=0으로 호출해 강제 probe.
export async function probeQuotaIfStale(maxAgeMs: number): Promise<ProbeResult> {
  const snap = await getQuotaSnapshot()
  if (snap.lastSeenAt && maxAgeMs > 0) {
    const ageMs = Date.now() - new Date(snap.lastSeenAt).getTime()
    if (ageMs < maxAgeMs) {
      return { ok: true, snapshot: snap, durationMs: 0, reason: 'fresh, skipped' }
    }
  }
  if (inflightProbe) return inflightProbe
  inflightProbe = probeQuotaInBackground().finally(() => {
    inflightProbe = null
  })
  return inflightProbe
}

export async function probeQuotaInBackground(): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (!depsCache) {
    return {
      ok: false,
      reason: 'probe deps not registered',
      snapshot: await getQuotaSnapshot(),
      durationMs: 0
    }
  }
  if (!depsCache.geminiCliPath) {
    return {
      ok: false,
      reason: 'gemini CLI not found',
      snapshot: await getQuotaSnapshot(),
      durationMs: Date.now() - startedAt
    }
  }
  const sender = pickAnyWebContents()
  if (!sender) {
    return {
      ok: false,
      reason: 'no WebContents available',
      snapshot: await getQuotaSnapshot(),
      durationMs: Date.now() - startedAt
    }
  }

  // 격리 cwd — cwd-local hook 없음. 매 probe마다 새 디렉토리 (cleanup은 OS temp policy 위임).
  const probeCwd = path.join(os.tmpdir(), `agentbridge-quota-probe-${Date.now()}`)
  await fs.mkdir(probeCwd, { recursive: true })

  return new Promise<ProbeResult>((resolve) => {
    let resolved = false
    let tail = ''
    const TAIL_MAX = 4_000
    let ptySessionId: string | null = null

    const cleanup = (): void => {
      if (ptySessionId) {
        try {
          depsCache!.killPty(ptySessionId)
        } catch {
          /* noop */
        }
      }
      // probeCwd unlink — 빈 디렉토리 (gemini가 새 파일 만든 게 없으면 그대로). 잔재면 무시.
      fs.rm(probeCwd, { recursive: true, force: true }).catch(() => undefined)
    }

    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      cleanup()
      log.warn('quota probe — timeout, footer 미캡처', { timeoutMs: PROBE_TIMEOUT_MS })
      void getQuotaSnapshot().then((snap) =>
        resolve({
          ok: false,
          reason: 'timeout',
          snapshot: snap,
          durationMs: Date.now() - startedAt
        })
      )
    }, PROBE_TIMEOUT_MS)

    log.info('quota probe — gemini background spawn', { cwd: probeCwd })
    try {
      const { sessionId } = depsCache!.startPty(
        {
          command: depsCache!.geminiCliPath!,
          args: ['--skip-trust'],
          cwd: probeCwd,
          cols: 120,
          rows: 30
        },
        sender,
        {
          onData: (data): void => {
            if (resolved) return
            tail = (tail + data).slice(-TAIL_MAX)
            const stripped = tail.replace(ANSI_STRIP_RE, '')
            const pct = extractQuotaPercent(stripped)
            if (pct != null) {
              resolved = true
              clearTimeout(timer)
              log.info('quota probe — footer 캡처', { usedPercent: pct })
              cleanup()
              void recordQuotaPercent(pct).then((snap) =>
                resolve({ ok: true, snapshot: snap, durationMs: Date.now() - startedAt })
              )
            }
          },
          onExit: (): void => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            log.warn('quota probe — PTY 종료 (footer 미캡처)')
            cleanup()
            void getQuotaSnapshot().then((snap) =>
              resolve({
                ok: false,
                reason: 'pty exited before footer captured',
                snapshot: snap,
                durationMs: Date.now() - startedAt
              })
            )
          }
        }
      )
      ptySessionId = sessionId
    } catch (err) {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      log.warn('quota probe — spawn 실패', { err: String(err) })
      cleanup()
      void getQuotaSnapshot().then((snap) =>
        resolve({
          ok: false,
          reason: `spawn failed: ${String(err)}`,
          snapshot: snap,
          durationMs: Date.now() - startedAt
        })
      )
    }
  })
}
