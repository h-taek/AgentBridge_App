import { useCallback, useState } from 'react'
import type { CliKind, EnvProbeResult, SessionMeta } from '@shared/ipc'
import { TerminalIcon } from './icons'

// M3 L3 청크 — Workspace 안 sessions[] 탭 표시.
// architecture §14 multi-tab UI 패턴.
//
// 표시 정책:
//   - 활성 탭(closedAt이 null)만 가로 배치 (탭바)
//   - 닫힌 탭은 보이지 않음 (좌 사이드바 트리에서 다시 클릭 시 PTY 재spawn으로 복원)
//   - 활성 탭 = 사용자가 현재 보고 있는 session (탭 강조)
//   - "x" 버튼  = sessions.close soft (사이드바에서 다시 열 수 있음)
//   - 이름 수정은 *좌 사이드바*에서만 (탭에는 펜 없음 — 좁은 폭 + 중복 회피)

type Props = {
  sessions: SessionMeta[]
  activeSessionId: string | null
  env: EnvProbeResult | null
  busy: boolean
  onSelectTab: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onAddTab: (target: CliKind | 'shell') => void
}

const MODEL_LABELS: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini'
}

export function SessionTabs({
  sessions,
  activeSessionId,
  env,
  busy,
  onSelectTab,
  onCloseTab,
  onAddTab
}: Props): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const openSessions = sessions.filter((s) => s.closedAt === null)

  const isAvailable = useCallback(
    (k: CliKind) => env?.clis.find((c) => c.kind === k)?.found === true,
    [env]
  )

  return (
    <div className="session-tabs">
      <div className="session-tabs-bar">
        {openSessions.length === 0
          ? null
          : openSessions.map((s) => {
              const isActive = s.sessionId === activeSessionId
              const isShell = (s.kind ?? 'cli') === 'shell'
              const displayName = s.title?.trim() || (isShell ? '터미널' : MODEL_LABELS[s.model])
              return (
                <div
                  key={s.sessionId}
                  className={`session-tab model-${isShell ? 'shell' : s.model}${isActive ? ' active' : ''}`}
                  role="tab"
                  aria-selected={isActive}
                >
                  <button
                    className="session-tab-label"
                    onClick={() => {
                      if (busy) return
                      if (!isActive) onSelectTab(s.sessionId)
                    }}
                    disabled={busy}
                    title={`${displayName} · ${s.sessionId.slice(0, 8)}…`}
                  >
                    {isShell ? (
                      <span className="session-tab-icon" aria-hidden="true">
                        <TerminalIcon />
                      </span>
                    ) : (
                      <span className={`session-tab-dot model-${s.model}`} />
                    )}
                    {displayName}
                  </button>
                  <button
                    className="session-tab-close"
                    onClick={() => {
                      if (busy) return
                      onCloseTab(s.sessionId)
                    }}
                    disabled={busy}
                    title="탭 닫기 (사이드바에서 다시 열 수 있음)"
                    aria-label="탭 닫기"
                  >
                    ×
                  </button>
                </div>
              )
            })}

        <div className="session-tab-add-wrap">
          <button
            className="session-tab-add"
            onClick={() => setAddOpen((v) => !v)}
            disabled={busy}
            title="다른 모델 탭 추가"
          >
            + 모델
          </button>
          {addOpen && (
            <div className="session-tab-add-menu" role="menu">
              {(['claude', 'codex', 'gemini'] as CliKind[]).map((k) => (
                <button
                  key={k}
                  className="session-tab-add-item"
                  onClick={() => {
                    setAddOpen(false)
                    if (!isAvailable(k) || busy) return
                    onAddTab(k)
                  }}
                  disabled={!isAvailable(k) || busy}
                  title={!isAvailable(k) ? `${MODEL_LABELS[k]} CLI가 PATH에 없음` : undefined}
                >
                  <span className={`session-tab-dot model-${k}`} />
                  {MODEL_LABELS[k]}
                  {!isAvailable(k) && <span className="hint"> (미설치)</span>}
                </button>
              ))}
              <button
                className="session-tab-add-item"
                onClick={() => {
                  setAddOpen(false)
                  if (busy) return
                  onAddTab('shell')
                }}
                disabled={busy}
                title="내장 터미널 (zsh) — AgentBridge 메모리 없음"
              >
                <span className="session-tab-icon" aria-hidden="true">
                  <TerminalIcon />
                </span>
                터미널
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
