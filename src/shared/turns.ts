// TurnRecord — M3 O 청크. architecture §15.3.
//
// turns.jsonl append-only NDJSON 1 record = 1 turn.
// Compaction scheduler가 oldest (count-3)개를 처리해 IR로 흡수하고 turns.jsonl을 rewrite.
// 최근 3개는 항상 raw 보존 (hook 본문에 inject).

import type { CliKind } from './ipc'

export type TurnToolCall = {
  // 'Read' | 'Bash' | 'Edit' | 'Write' | 'Grep' | ... (모델별 휴리스틱)
  tool: string
  // 파일 경로 또는 명령. 길면 truncate.
  arg: string
  // 도구 결과 요약 (선택). 첫 cut은 거의 비움 — 박스 본문에서 짧게만.
  summary?: string
}

export type TurnRecord = {
  id: string // uuid v4
  workspaceId: string
  sessionId: string // multi-tab 구분
  model: CliKind
  startedAt: string // ISO — 사용자 Enter 시점
  completedAt: string // ISO — PTY idle 후

  user: string // pty:write buffer flush 정제 (paste/backspace)
  userBytes: number // 정제 후 길이 (8K cap)

  // sliceAssistant 휴리스틱 결과:
  //   1. ANSI strip
  //   2. 시스템 indicator 제거
  //   3. ⏺ <Tool>(<arg>) 박스 추출 → toolCalls[]
  //   4. 남은 본문 = assistantBody (500 chars cap, 긴 응답은 첫 400 + 마지막 100)
  assistantBody: string
  assistantBodyBytes: number // 정제 후 길이

  toolCalls: TurnToolCall[]
}

// cap 정책 (architecture §15.3):
//   - user cap 8K
//   - assistantBody cap 500 chars (긴 응답은 첫 400 + 마지막 100)
//   - toolCalls.arg cap 500 chars
export const TURN_CAP = {
  userBytes: 8 * 1024,
  assistantBodyChars: 500,
  toolCallArgChars: 500
} as const

// Compaction trigger (architecture §15.4 + 2026-05-11 실사용 튜닝):
//   uncompacted count >= 6  OR  sum(userBytes + assistantBodyBytes) >= 12K
// 의도: 최근 3개 raw 보존(keepRecent), oldest 3개를 1개의 IR로 흡수.
// trigger 비교는 `>=` (countThreshold 값 그대로 "이 수치에서 발동").
export const COMPACTION_TRIGGER = {
  countThreshold: 6,
  bytesThreshold: 12 * 1024,
  // 최근 N개는 항시 raw 보존 (compaction에서 제외).
  keepRecent: 3
} as const

// turns.jsonl rotate 정책:
//   5MB OR 1000 record 도달 시 archive/turns_<TS>.jsonl.archive로 이동.
//   (Compaction과 별개 — 한 워크스페이스가 장기간 사용된 경우 안전망)
export const TURNS_ROTATE = {
  maxBytes: 5 * 1024 * 1024,
  maxRecords: 1000
} as const
