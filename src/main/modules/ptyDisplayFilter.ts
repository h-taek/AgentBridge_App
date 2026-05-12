// PTY display filter — M3 O 청크 후속 (2026-05-11).
//
// codex 0.130.0 + gemini는 hook `additionalContext`를 TUI에 *visible developer message*로
// 렌더링. `suppressOutput: true`는 no-op (openai/codex#15497, #16933 확정).
//
// → 워크어라운드: **PTY output stripping**. 우리가 helper binary로 emit한
//   `<agentbridge-context>…</agentbridge-context>` 블록을 PTY → renderer/turnRecorder 경로에서 제거.
//   replay.log엔 raw 그대로 (포렌식/디버그 목적).
//
// 모델은 codex 내부 채널로 additionalContext를 이미 받았으므로 *모델 입력 무영향*.
// claude는 TUI에 hook output 표시 안 함 → 필터 적용해도 no-op (안전).
//
// State machine (per ptySessionId):
//   - 'pass-through': open tag 검색. 발견 시 emit-before + 'in-block' 전환.
//   - 'in-block': close tag 검색. 발견 시 buffer 폐기 + 'pass-through' 복귀.
//
// chunk 경계 처리:
//   - pass-through: 끝부분 (OPEN_TAG.length - 1) bytes는 partial 가능성으로 보류
//   - in-block: 마찬가지 (CLOSE_TAG.length - 1) bytes는 partial 가능성

const OPEN_TAG = '<agentbridge-context>'
const CLOSE_TAG = '</agentbridge-context>'
const HIDDEN_MARKER = '[hook context hidden]'

type FilterState = {
  inBlock: boolean
  // chunk 경계에서 partial match 보류 buffer (pass-through 상태에서만 유효).
  // in-block 상태에서는 끝부분 (CLOSE_TAG.length - 1) bytes를 보류.
  carry: string
}

const states = new Map<string, FilterState>()

export function registerDisplayFilter(ptySessionId: string): void {
  states.set(ptySessionId, { inBlock: false, carry: '' })
}

export function unregisterDisplayFilter(ptySessionId: string): void {
  states.delete(ptySessionId)
}

// input 끝부분이 tag의 prefix와 일치하는지 검사. 일치하는 가장 긴 prefix 길이 반환 (0 = no match).
// chunk 경계에서 partial tag 매칭 보류용.
function endsWithPrefixOf(input: string, tag: string): number {
  const maxCheck = Math.min(input.length, tag.length - 1)
  for (let len = maxCheck; len > 0; len--) {
    if (input.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

// 등록 안 된 세션은 pass-through. 호출자는 항상 returned value를 사용.
export function filterDisplayData(ptySessionId: string, data: string): string {
  const state = states.get(ptySessionId)
  if (!state) return data

  // carry + 새 data 합치고 처음부터 처리
  let input = state.carry + data
  state.carry = ''
  let output = ''

  while (input.length > 0) {
    if (state.inBlock) {
      const closeIdx = input.indexOf(CLOSE_TAG)
      if (closeIdx === -1) {
        // close tag 미발견 — 끝부분이 CLOSE_TAG prefix와 매칭되면 carry, 나머지 폐기.
        const carryLen = endsWithPrefixOf(input, CLOSE_TAG)
        state.carry = carryLen > 0 ? input.slice(input.length - carryLen) : ''
        input = ''
      } else {
        // close tag 발견 — 블록 종료. 본문 폐기 + 잔여 분기 처리 계속.
        state.inBlock = false
        input = input.slice(closeIdx + CLOSE_TAG.length)
      }
    } else {
      const openIdx = input.indexOf(OPEN_TAG)
      if (openIdx === -1) {
        // open tag 미발견 — 끝부분이 OPEN_TAG prefix와 매칭되면 carry, 나머지 emit.
        const carryLen = endsWithPrefixOf(input, OPEN_TAG)
        if (carryLen > 0) {
          output += input.slice(0, input.length - carryLen)
          state.carry = input.slice(input.length - carryLen)
        } else {
          output += input
        }
        input = ''
      } else {
        // open tag 발견 — open 이전까지 emit + marker 삽입 + in-block 전환.
        output += input.slice(0, openIdx)
        output += HIDDEN_MARKER
        state.inBlock = true
        input = input.slice(openIdx + OPEN_TAG.length)
      }
    }
  }

  return output
}

// 디버깅용 — 현재 상태 조회.
export function getFilterState(
  ptySessionId: string
): { inBlock: boolean; carryLen: number } | null {
  const s = states.get(ptySessionId)
  if (!s) return null
  return { inBlock: s.inBlock, carryLen: s.carry.length }
}
