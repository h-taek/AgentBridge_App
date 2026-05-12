import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { getCliPath, getShellPath } from '../envProbe'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { extractQuotaPercent, recordQuotaPercent } from '../geminiQuotaTracker'
import { buildAdapterEnv } from './env'
import { deleteGeminiSessionFiles, hasGeminiSessionFile, resolveResumeArgs } from './geminiResume'
import { runRefineSpawn } from './refineHeadless'
import type {
  CLIAdapter,
  RefineUsage,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult,
  SpawnRefineRequest,
  SpawnRefineResult
} from './types'

// ANSI escape strip — geminiQuotaTracker.extractQuotaPercent에 정제된 라인 전달용.
const ANSI_STRIP_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

// 누적 buffer (tail 최대 4KB) — gemini PTY data 들어올 때마다 footer 캡처 시도.
// 메모리 누수 방지로 ptySessionId별 buffer는 본 함수 안 closure로 관리.
function createQuotaCaptureHook(): (data: string) => void {
  let tail = ''
  let lastPercent: number | null = null
  const TAIL_MAX = 4_000
  return (data: string): void => {
    tail = (tail + data).slice(-TAIL_MAX)
    const stripped = tail.replace(ANSI_STRIP_RE, '')
    const pct = extractQuotaPercent(stripped)
    if (pct != null && pct !== lastPercent) {
      lastPercent = pct
      // fire-and-forget — 영속화 실패해도 PTY 흐름은 그대로.
      void recordQuotaPercent(pct).catch((err) => {
        log.warn('gemini quota footer 영속화 실패', { err: String(err) })
      })
    }
  }
}

// Gemini 어댑터.
// - 새 세션: `gemini --session-id <UUID> --skip-trust` — UUID 사전 통제(claude 패턴).
//   --skip-trust로 workspace trust 다이얼로그 우회. 인증은 사용자 환경에 이미 설정돼있다고 가정.
// - 이어가기: `gemini --resume <UUID> --skip-trust` — UUID 직접 전달.
// - chat submit: bracketed paste — 단순 \r/\n suffix는 입력 박스에서 줄바꿈으로 처리됨.
//
// IR 주입은 hook 시스템(M 청크 — cwd/.gemini/settings.json의 SessionStart/BeforeAgent)이 담당.
// M2의 argv 기반 `-i <payload>` 흐름은 폐기됨.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const cliPath = getCliPath('gemini')
  if (!cliPath) {
    throw new Error('gemini CLI not found in PATH (EnvProbe 결과 미발견)')
  }

  const isNewSession = req.sessionId == null
  const geminiSessionId = req.sessionId ?? randomUUID()
  const env = buildAdapterEnv({ shellPath: getShellPath() })

  let args: string[]
  if (isNewSession) {
    args = ['--session-id', geminiSessionId, '--skip-trust']
  } else {
    // resume — UUID → index 매핑. 실패 시 throw로 spawn 자체 안 함.
    const resumeArgs = await resolveResumeArgs({ sessionId: geminiSessionId })
    args = [...resumeArgs, '--skip-trust']
  }

  log.info('gemini spawnInteractive', {
    geminiSessionId,
    isNewSession,
    cwd: req.cwd
  })

  // gemini PTY 출력에 quota footer 캡처 hook chaining — 호출자 onData 보존.
  const quotaHook = createQuotaCaptureHook()
  const wrappedHooks: SpawnInteractiveHooks = {
    ...hooks,
    onData: (data): void => {
      quotaHook(data)
      hooks.onData?.(data)
    }
  }

  const result = startPty(
    {
      command: cliPath,
      args,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      env
    },
    sender,
    wrappedHooks
  )

  return { ...result, modelSessionId: geminiSessionId }
}

// gemini refine 헤드리스 — `gemini -p '<prompt>' -o stream-json --approval-mode auto_edit
// --skip-trust` (architecture §7.2). probe_results §1: 깨끗한 JSON 라인 출력.
//   {"type":"init",...}
//   {"type":"message","role":"user",...}
//   {"type":"message","role":"assistant","content":"..."}
//   {"type":"result","status":"success",...}
async function spawnRefineIRGemini(req: SpawnRefineRequest): Promise<SpawnRefineResult> {
  const cliPath = getCliPath('gemini')
  if (!cliPath) {
    throw new Error('gemini CLI not found in PATH')
  }
  const env = buildAdapterEnv({ shellPath: getShellPath() })
  let assistantText = ''
  let usage: RefineUsage | undefined
  log.info('gemini spawnRefineIR', { promptLen: req.prompt.length, cwd: req.cwd })
  const base = await runRefineSpawn({
    command: cliPath,
    args: ['-p', req.prompt, '-o', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust'],
    cwd: req.cwd,
    env,
    stdinPayload: null,
    abortSignal: req.abortSignal,
    timeoutMs: req.timeoutMs,
    onLine: (line) => {
      let evt: unknown
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const o = evt as { type?: string; role?: string; content?: unknown; usage?: unknown }
      if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string') {
        assistantText += o.content
      } else if (o.type === 'result' && o.usage && typeof o.usage === 'object') {
        const u = o.usage as Record<string, number>
        usage = {
          inputTokens: u.input_tokens ?? u.prompt_tokens,
          outputTokens: u.output_tokens ?? u.completion_tokens
        }
      }
    }
  })
  return { assistantText, usage, ...base }
}

async function hasNativeSession(modelSessionId: string | null): Promise<boolean> {
  if (!modelSessionId) return false
  return hasGeminiSessionFile(modelSessionId)
}

async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  await deleteGeminiSessionFiles(modelSessionId)
}

export const geminiAdapter: CLIAdapter = {
  kind: 'gemini',
  // 시도 흔적: '\r' / '\n' / bracketed paste 모두 줄바꿈 누적.
  // 사용자 검증으로 paste markers `[200~` 등이 화면에 *invisible* 처리됨을 확인 — 즉 ESC sequence
  // 자체는 무시되지만 그 안의 text와 \r은 *fast-paste detection*에 의해 한 덩어리(연속 byte)로 처리
  // 되어 \r도 줄바꿈으로 흡수됨. readline 기반 input 박스의 표준 거동.
  // 해결: text와 \r을 별도 step으로 분리하고 사이에 80ms 지연 — \r이 단일 키 이벤트로 인식됨.
  formatChatSubmit: (text) => [{ write: text, delayMs: 80 }, { write: '\r' }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  spawnRefineIR: spawnRefineIRGemini,
  hasNativeSession,
  deleteNativeSession
}
