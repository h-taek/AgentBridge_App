import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import log from 'electron-log/main'

// Gemini resume 모듈 — UUID 직접 사용.
//
// gemini CLI는 `--resume <UUID>` 직접 지원
// (https://geminicli.com/docs/cli/session-management/). 이전 probe_results.md §1.1의
// "UUID 직접 안 됨" 정보는 오인 — index/latest 우회 폐기, UUID 그대로 전달.
//
// 이 모듈에 남은 역할:
//   - hasGeminiSessionFile: 빈 세션 판정용 (CLIAdapter.hasNativeSession 위임 대상)
//   - deleteGeminiSessionFiles: hard delete 시 native 파일 unlink (외부 agent 노출 차단)
//   - resolveResumeArgs: UUID 그대로 `['--resume', uuid]` 반환 (jsonl 존재 확인 후
//     없으면 친절한 에러)

const SESSION_FILE_RE = /^session-.+-([0-9a-f]{8})\.jsonl$/

type SessionFileInfo = {
  file: string
  sessionId: string
  mtimeMs: number
}

// 단일 chats 디렉토리에서 모든 session 파일 메타 수집.
async function collectSessionFiles(chatsDir: string): Promise<SessionFileInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(chatsDir)
  } catch {
    return []
  }
  const out: SessionFileInfo[] = []
  for (const e of entries) {
    if (!SESSION_FILE_RE.test(e)) continue
    const file = path.join(chatsDir, e)
    try {
      const stat = await fs.stat(file)
      const buf = await fs.readFile(file, 'utf8')
      const firstLine = buf.split('\n', 1)[0]
      const meta = JSON.parse(firstLine) as { sessionId?: string }
      if (typeof meta.sessionId === 'string') {
        out.push({ file, sessionId: meta.sessionId, mtimeMs: stat.mtimeMs })
      }
    } catch {
      // 깨진 파일 무시
    }
  }
  return out
}

export type ResumeResolveOptions = {
  // 우리가 spawn 시 사용한 modelSessionId(full UUID).
  sessionId: string
}

// 우리 sessionId(UUID)에 해당하는 jsonl이 *유의미한 메시지 라인을 가지고 있는지* 판정.
//
// gemini는 PTY spawn 직후(사용자 입력 0건이어도) jsonl을 즉시 생성한다 — 메타 1줄만 적힌
// 빈 jsonl. claude/codex는 사용자 메시지가 도착해야 jsonl을 만들지만 gemini는 이 동작이
// 다름(사용자 직접 검증). 따라서 단순 파일 존재 체크로는 빈 세션 판정 불가 — 메타 라인을
// 제외한 추가 라인이 1개 이상이어야 "사용자 활동이 있는 native 세션"으로 본다.
export async function hasGeminiSessionFile(modelSessionId: string): Promise<boolean> {
  const uuidLower = modelSessionId.toLowerCase()
  const tmpRoot = path.join(os.homedir(), '.gemini', 'tmp')
  let projects: string[]
  try {
    projects = await fs.readdir(tmpRoot)
  } catch {
    return false
  }
  for (const p of projects) {
    const chats = path.join(tmpRoot, p, 'chats')
    const all = await collectSessionFiles(chats)
    const ours = all.find((f) => f.sessionId.toLowerCase() === uuidLower)
    if (!ours) continue
    try {
      const buf = await fs.readFile(ours.file, 'utf8')
      // 빈 라인 제거 후 라인 수. 메타 1줄 + 메시지 N줄. N >= 1이면 활동 있음.
      const lines = buf.split('\n').filter((l) => l.length > 0)
      return lines.length >= 2
    } catch {
      return false
    }
  }
  return false
}

// 우리 sessionId(UUID)와 매칭되는 모든 ~/.gemini/tmp/*/chats jsonl 파일 unlink.
// 외부 agent가 같은 sessionId를 resume하지 못하게 한다.
export async function deleteGeminiSessionFiles(modelSessionId: string): Promise<void> {
  const uuidLower = modelSessionId.toLowerCase()
  const tmpRoot = path.join(os.homedir(), '.gemini', 'tmp')
  let projects: string[]
  try {
    projects = await fs.readdir(tmpRoot)
  } catch {
    return
  }
  for (const p of projects) {
    const chats = path.join(tmpRoot, p, 'chats')
    const all = await collectSessionFiles(chats)
    for (const f of all) {
      if (f.sessionId.toLowerCase() !== uuidLower) continue
      try {
        await fs.unlink(f.file)
        log.info('gemini native session 삭제', { file: f.file })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          log.warn('gemini native session 삭제 실패', { file: f.file, err: String(err) })
        }
      }
    }
  }
}

// resume args 결정. UUID 직접 전달 — `gemini --resume <UUID>`. 디스크 jsonl 존재 확인은
// 그대로 — 없으면 사용자에게 친절한 에러로 알려 새 워크스페이스로 안내(gemini CLI는
// 누락된 UUID를 받으면 모호한 에러로 exit).
export async function resolveResumeArgs(opts: ResumeResolveOptions): Promise<string[]> {
  const exists = await hasGeminiSessionFile(opts.sessionId)
  if (!exists) {
    throw new Error(
      `gemini 세션 ${opts.sessionId}을(를) ~/.gemini/tmp에서 찾을 수 없습니다 — 메시지 교환 전 닫힌 빈 세션은 gemini가 영속화하지 않습니다. 이 thread를 삭제하고 새로 만드세요.`
    )
  }
  log.info('gemini resume — UUID 직접 전달', { uuid: opts.sessionId })
  return ['--resume', opts.sessionId]
}
