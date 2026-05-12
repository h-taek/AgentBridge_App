import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TitleBar } from './TitleBar'

// 3 column grid shell — 좌 사이드바 + 중앙 + 우 사이드바, 각 사이드바 토글 가능.
// 단축키: ⌘B (좌), ⌘⌥B (우) — VSCode 동일 (사용자에게 칩으로 안내하지 않음).
// collapsed 상태에서도 자식은 mount 유지 → 토글 애니메이션 중 layout shift 최소화.
//
// 토글 버튼은 사이드바 *내부* 상단에 위치 — 타이틀바엔 collapsed 시 fallback만.
// 사이드바가 직접 닫힘 버튼을 노출하므로 토글이 패널에 "속한" 느낌.
//
// 우 사이드바 자동 동작:
//   - workspaceOpen=false (홈 화면): 강제 접힘 (사용자 토글 무효)
//   - workspaceOpen 전환 (false → true): 자동 펼침
//   - workspaceOpen 전환 (true → false): 자동 접힘
//   사용자가 워크스페이스 활성 상태에서 명시적으로 토글한 상태는 유지.

type LeftRenderer = (ctx: { onClose: () => void }) => ReactNode
type RightRenderer = (ctx: { onClose: () => void }) => ReactNode

type Props = {
  left: LeftRenderer
  right: RightRenderer
  children: ReactNode
  memoryActive?: boolean
  // 워크스페이스가 열려 있는지 여부. 홈 화면(false)일 땐 우 사이드바 자동 접힘.
  workspaceOpen?: boolean
}

export function AppShell({
  left,
  right,
  children,
  memoryActive,
  workspaceOpen
}: Props): React.JSX.Element {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(false)
  const prevWorkspaceOpenRef = useRef<boolean | undefined>(workspaceOpen)

  // 워크스페이스 활성 전환 시 우 사이드바 자동 토글 (open → 펼침 / close → 접힘).
  // rightOpen은 사용자 토글 가능한 state라 derive 불가 — prev 비교로 1회만 발사하는 동기 setState.
  useEffect(() => {
    const prev = prevWorkspaceOpenRef.current
    if (prev !== workspaceOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRightOpen(Boolean(workspaceOpen))
    }
    prevWorkspaceOpenRef.current = workspaceOpen
  }, [workspaceOpen])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code !== 'KeyB') return
      e.preventDefault()
      if (e.altKey) {
        // 홈 화면(workspaceOpen=false)에선 우 사이드바 토글 무효 — 표시할 컨텍스트 없음.
        if (!workspaceOpen) return
        setRightOpen((v) => !v)
      } else setLeftOpen((v) => !v)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [workspaceOpen])

  return (
    <div className="app-shell">
      <TitleBar
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onToggleLeft={() => setLeftOpen((v) => !v)}
        onToggleRight={() => setRightOpen((v) => !v)}
        memoryActive={memoryActive}
      />
      <aside className={`sidebar sidebar-left${leftOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-inner">{left({ onClose: () => setLeftOpen(false) })}</div>
      </aside>
      <section className="app-center">{children}</section>
      <aside className={`sidebar sidebar-right${rightOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-inner">{right({ onClose: () => setRightOpen(false) })}</div>
      </aside>
    </div>
  )
}
