import type { CliKind } from '@shared/ipc'
import { claudeAdapter } from './claudeAdapter'
import { codexAdapter } from './codexAdapter'
import { geminiAdapter } from './geminiAdapter'
import type { CLIAdapter } from './types'

// 모델별 어댑터 라우팅 — M2 E 청크에서 gemini 추가로 세 모델 모두 등록 완료.
const adapters: Partial<Record<CliKind, CLIAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter
}

export function getAdapter(kind: CliKind): CLIAdapter {
  const a = adapters[kind]
  if (!a) {
    throw new Error(`CLIAdapter 미구현: ${kind}`)
  }
  return a
}

export type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'
