import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ArchiveSnapshotMeta,
  InstructionFileInfo,
  QuotaSnapshot,
  TurnsSummaryResult
} from '@shared/ipc'
import type { IR } from '@shared/ir'
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  SparkleIcon,
  TrashIcon
} from './icons'
import { IrDetailModal } from './IrDetailModal'

// M3.5 UI-E 후속 — 메모리 관리 패널 (3 collapsible 그룹).
//   Group 1: AI 지시 (cwd 안 AGENTS.md / CLAUDE.md / GEMINI.md)
//   Group 2: Refine / Quota (정책 + gemini quota %)
//   Group 3: 메모리 (Turn 흐름 + 현재 IR + Archive 스냅샷)
// 각 그룹은 접기/펼치기. 카드 클릭(현재 IR / Archive) → 큰 모달에서 6 섹션 stacked view.

type Props = {
  workspaceId: string
}

type DetailTarget =
  | { kind: 'current'; ir: IR; mtime: string | null }
  | { kind: 'archive'; meta: ArchiveSnapshotMeta }

const ARCHIVE_INITIAL_VISIBLE = 5

function formatRelative(iso: string | null, now: number): string {
  if (!iso) return '아직 없음'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '아직 없음'
  const diffSec = Math.max(0, Math.round((now - t) / 1000))
  if (diffSec < 10) return '방금'
  if (diffSec < 60) return `${diffSec}초 전`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}일 전`
  return new Date(iso).toLocaleDateString()
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function IrPanel({ workspaceId }: Props): React.JSX.Element {
  const [ir, setIr] = useState<IR | null>(null)
  const [irMtime, setIrMtime] = useState<string | null>(null)
  const [turns, setTurns] = useState<TurnsSummaryResult | null>(null)
  const [instructions, setInstructions] = useState<InstructionFileInfo[]>([])
  const [archive, setArchive] = useState<ArchiveSnapshotMeta[]>([])
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [openInstructions, setOpenInstructions] = useState(true)
  const [openRefine, setOpenRefine] = useState(true)
  const [openMemory, setOpenMemory] = useState(true)
  const [showAllArchive, setShowAllArchive] = useState(false)

  // 메모리 초기화 확인 모달.
  const [resetOpen, setResetOpen] = useState(false)
  const [resetAlsoTurns, setResetAlsoTurns] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const [archiveDetailIr, setArchiveDetailIr] = useState<{
    ir: IR | null
    loading: boolean
    error: string | null
  }>({ ir: null, loading: false, error: null })

  // 1분 tick — 상대 시간 라벨 갱신.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const loadIr = useCallback(async () => {
    const res = await window.agentbridge.ir.load({ workspaceId })
    setIr(res.ir)
    setIrMtime(res.fileMtime)
  }, [workspaceId])

  const loadTurns = useCallback(async () => {
    const res = await window.agentbridge.memory.turnsSummary({ workspaceId })
    setTurns(res)
  }, [workspaceId])

  const loadInstructions = useCallback(async () => {
    const res = await window.agentbridge.memory.instructionsList({ workspaceId })
    setInstructions(res.files)
  }, [workspaceId])

  const loadArchive = useCallback(async () => {
    const res = await window.agentbridge.memory.archiveList({ workspaceId })
    setArchive(res.snapshots)
  }, [workspaceId])

  const loadQuota = useCallback(async () => {
    const snap = await window.agentbridge.quota.get()
    setQuota(snap)
  }, [])

  // background probe (10분 stale gate 통과 시 발동). renderer 마운트 시점에 한 번 trigger.
  // 결과는 quota:updated broadcast로 들어옴 → onUpdated 핸들러가 setQuota.
  const triggerBackgroundProbe = useCallback(() => {
    void window.agentbridge.quota.probe().catch(() => undefined)
  }, [])

  const loadSettings = useCallback(async () => {
    const s = await window.agentbridge.settings.get()
    setSettings(s)
  }, [])

  // 워크스페이스 변경 시 일괄 fetch — workspaceId(외부 시그널) → 패널 내부 state 동기화 패턴.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIr(null)
    setIrMtime(null)
    setTurns(null)
    setInstructions([])
    setArchive([])
    setRefineError(null)
    setShowAllArchive(false)
    void loadIr().catch(() => undefined)
    void loadTurns().catch(() => undefined)
    void loadInstructions().catch(() => undefined)
    void loadArchive().catch(() => undefined)
    void loadQuota().catch(() => undefined)
    void loadSettings().catch(() => undefined)
    // 워크스페이스 진입 시점에 background probe 한 번 — 결과는 quota:updated로.
    triggerBackgroundProbe()
  }, [
    workspaceId,
    loadIr,
    loadTurns,
    loadInstructions,
    loadArchive,
    loadQuota,
    loadSettings,
    triggerBackgroundProbe
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 자동/수동 정제 완료 시 통보 — IR + turns + archive 동기화.
  useEffect(() => {
    const unsub = window.agentbridge.ir.onUpdated((evt) => {
      if (evt.workspaceId !== workspaceId) return
      void loadIr().catch(() => undefined)
      void loadTurns().catch(() => undefined)
      void loadArchive().catch(() => undefined)
    })
    return unsub
  }, [workspaceId, loadIr, loadTurns, loadArchive])

  // background probe / 응답 에러 마킹 / 모순 reconcile 시 main이 broadcast.
  useEffect(() => {
    const unsub = window.agentbridge.quota.onUpdated((snap) => {
      setQuota(snap)
    })
    return unsub
  }, [])

  // turnRecorder가 새 turn append할 때마다 통보 — Turn 흐름 바 즉시 갱신.
  useEffect(() => {
    const unsub = window.agentbridge.memory.onTurnsUpdated((evt) => {
      if (evt.workspaceId !== workspaceId) return
      void loadTurns().catch(() => undefined)
    })
    return unsub
  }, [workspaceId, loadTurns])

  const handleRefine = useCallback(async () => {
    if (refining) return
    setRefining(true)
    setRefineError(null)
    try {
      const res = await window.agentbridge.ir.refine({ workspaceId, timeoutMs: 120_000 })
      if (!res.ok) setRefineError(res.error ?? '정제 실패')
      else if (res.error) setRefineError(`경고: ${res.error}`)
      await loadIr()
      await loadTurns()
      await loadArchive()
    } catch (e) {
      setRefineError(String(e))
    } finally {
      setRefining(false)
    }
  }, [refining, workspaceId, loadIr, loadTurns, loadArchive])

  // 메모리 초기화 — ir.json + (옵션) turns.jsonl 비움. archive 보존.
  // main이 ir:updated / turns:updated broadcast → 자동 fetch chain 재실행.
  const handleResetConfirm = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    setResetError(null)
    try {
      const res = await window.agentbridge.memory.reset({
        workspaceId,
        alsoTurns: resetAlsoTurns
      })
      if (!res.ok) {
        setResetError(res.error ?? '초기화 실패')
        return
      }
      setResetOpen(false)
    } catch (e) {
      setResetError(String(e))
    } finally {
      setResetting(false)
    }
  }, [resetting, workspaceId, resetAlsoTurns])

  // 워크스페이스 변경 시 reset 모달 닫기 — 외부 시그널 동기화.
  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setResetOpen(false)
    setResetError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspaceId])

  // CurrentIrCard 카드 헤더 휴지통 → 현재 IR을 비우고 archive 최신 스냅샷을 promote.
  // archive 비어있으면 빈 IR로 떨어짐. archive 최신을 소비(unlink)하므로 반복 클릭 시
  // 이전 스냅샷을 한 단계씩 거슬러 복원하는 효과.
  // main이 ir:updated broadcast + loadArchive 자동 갱신.
  const handleDeleteCurrentIr = useCallback(async () => {
    if (!ir) return
    const hasArchive = archive.length > 0
    const msg = hasArchive
      ? '현재 메모리를 비우고 가장 최신 스냅샷을 현재 메모리로 복원합니다.\n복원된 스냅샷은 archive 목록에서 제거됩니다. 계속할까요?'
      : '현재 메모리를 비웁니다 (archive 스냅샷 없음 — 빈 메모리로 전환). 계속할까요?'
    if (!window.confirm(msg)) return
    try {
      const res = await window.agentbridge.memory.promoteLatestArchive({ workspaceId })
      if (!res.ok) setRefineError(res.error ?? '복원 실패')
    } catch (e) {
      setRefineError(String(e))
    }
  }, [ir, workspaceId, archive.length])

  // ArchiveCard 카드 헤더 휴지통 → 개별 스냅샷 파일 삭제.
  // archive:delete(workspaceId, archivePath) — main이 안전 가드 통과 후 unlink. 성공 시 loadArchive 갱신.
  const handleDeleteArchive = useCallback(
    async (meta: ArchiveSnapshotMeta) => {
      if (
        !window.confirm(
          `이 스냅샷을 삭제합니다 (${formatAbsolute(meta.archivedAt)}).\n되돌릴 수 없습니다. 계속할까요?`
        )
      )
        return
      try {
        const res = await window.agentbridge.memory.archiveDelete({
          workspaceId,
          archivePath: meta.archivePath
        })
        if (!res.ok) {
          setRefineError(res.error ?? '스냅샷 삭제 실패')
          return
        }
        await loadArchive()
      } catch (e) {
        setRefineError(String(e))
      }
    },
    [workspaceId, loadArchive]
  )

  // archive 카드 클릭 → IR 본문 fetch 후 모달 표시.
  const openArchiveDetail = useCallback(
    async (meta: ArchiveSnapshotMeta) => {
      setDetail({ kind: 'archive', meta })
      setArchiveDetailIr({ ir: null, loading: true, error: null })
      try {
        const res = await window.agentbridge.memory.archiveLoad({
          workspaceId,
          archivePath: meta.archivePath
        })
        setArchiveDetailIr({ ir: res.ir, loading: false, error: null })
      } catch (e) {
        setArchiveDetailIr({ ir: null, loading: false, error: String(e) })
      }
    },
    [workspaceId]
  )

  const closeDetail = useCallback(() => {
    setDetail(null)
    setArchiveDetailIr({ ir: null, loading: false, error: null })
  }, [])

  const handleOpenInstructionFile = useCallback(
    async (info: InstructionFileInfo) => {
      if (!info.exists) {
        const res = await window.agentbridge.memory.instructionsCreate({
          workspaceId,
          kind: info.kind
        })
        await loadInstructions()
        await window.agentbridge.openPath(res.absolutePath)
        return
      }
      await window.agentbridge.openPath(info.absolutePath)
    },
    [workspaceId, loadInstructions]
  )

  const visibleArchive = useMemo(
    () => (showAllArchive ? archive : archive.slice(0, ARCHIVE_INITIAL_VISIBLE)),
    [archive, showAllArchive]
  )

  const currentUpdatedAt = ir?.meta.updatedAt ?? irMtime

  return (
    <section className="mem-panel" aria-label="메모리 패널">
      <MemGroup
        title="AI 지시"
        open={openInstructions}
        onToggle={() => setOpenInstructions((v) => !v)}
      >
        <InstructionsCard files={instructions} onAction={handleOpenInstructionFile} now={now} />
      </MemGroup>

      <MemGroup title="Refine / Quota" open={openRefine} onToggle={() => setOpenRefine((v) => !v)}>
        <RefineQuotaCard settings={settings} quota={quota} />
      </MemGroup>

      <MemGroup
        title="메모리"
        open={openMemory}
        onToggle={() => setOpenMemory((v) => !v)}
        action={
          <>
            <span
              className="mem-info-tip"
              title={
                'AgentBridge 메모리(IR)는 `/clear` 후에도 다음 메시지에 자동 재주입됩니다.\n메모리 자체를 비우려면 휴지통 버튼으로 초기화하세요.'
              }
              role="img"
              aria-label="메모리 동작 안내"
              onClick={(e) => e.stopPropagation()}
            >
              <InfoIcon />
            </span>
            <button
              type="button"
              className="mem-refine-btn"
              onClick={(e) => {
                e.stopPropagation()
                void handleRefine()
              }}
              disabled={refining}
              title="지금 정제"
              aria-label="지금 정제"
            >
              {refining ? <RefreshIcon className="spin" /> : <SparkleIcon />}
            </button>
            <button
              type="button"
              className="mem-reset-btn"
              onClick={(e) => {
                e.stopPropagation()
                setResetAlsoTurns(true)
                setResetError(null)
                setResetOpen(true)
              }}
              disabled={refining || resetting}
              title="메모리 초기화"
              aria-label="메모리 초기화"
            >
              <TrashIcon />
            </button>
          </>
        }
      >
        {refineError && <div className="mem-error">{refineError}</div>}
        <TurnFlowCard summary={turns} />
        <CurrentIrCard
          ir={ir}
          updatedLabel={formatRelative(currentUpdatedAt, now)}
          onOpen={() => {
            if (ir) setDetail({ kind: 'current', ir, mtime: irMtime })
          }}
          onDelete={handleDeleteCurrentIr}
        />
        {archive.length > 0 && (
          <>
            <div className="mem-subhead">이전 스냅샷 · {archive.length}</div>
            {visibleArchive.map((s) => (
              <ArchiveCard
                key={s.archivePath}
                snapshot={s}
                relativeLabel={formatRelative(s.archivedAt, now)}
                onOpen={() => void openArchiveDetail(s)}
                onDelete={() => void handleDeleteArchive(s)}
              />
            ))}
            {archive.length > ARCHIVE_INITIAL_VISIBLE && (
              <button
                type="button"
                className="mem-archive-more"
                onClick={() => setShowAllArchive((v) => !v)}
              >
                {showAllArchive ? '접기' : `+ ${archive.length - ARCHIVE_INITIAL_VISIBLE}개 더보기`}
              </button>
            )}
          </>
        )}
      </MemGroup>

      <IrDetailModal
        open={detail !== null}
        title={detail?.kind === 'archive' ? '메모리 스냅샷' : '현재 메모리'}
        subtitle={
          detail?.kind === 'archive'
            ? `${formatAbsolute(detail.meta.archivedAt)} · ${formatRelative(detail.meta.archivedAt, now)}`
            : currentUpdatedAt
              ? `마지막 정제 · ${formatAbsolute(currentUpdatedAt)}`
              : undefined
        }
        ir={detail?.kind === 'current' ? detail.ir : archiveDetailIr.ir}
        loading={detail?.kind === 'archive' ? archiveDetailIr.loading : false}
        error={detail?.kind === 'archive' ? archiveDetailIr.error : null}
        onClose={closeDetail}
      />

      <MemoryResetConfirm
        open={resetOpen}
        alsoTurns={resetAlsoTurns}
        onToggleAlsoTurns={() => setResetAlsoTurns((v) => !v)}
        busy={resetting}
        error={resetError}
        onCancel={() => {
          if (resetting) return
          setResetOpen(false)
          setResetError(null)
        }}
        onConfirm={handleResetConfirm}
      />
    </section>
  )
}

// ─── 메모리 초기화 확인 모달 ────────────────────────────────────────────
// SettingsModal 톤. 본문에 "되돌릴 수 없음 + archive 보존" 명시. turns 초기화는 옵션 토글.
function MemoryResetConfirm({
  open,
  alsoTurns,
  onToggleAlsoTurns,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  open: boolean
  alsoTurns: boolean
  onToggleAlsoTurns: () => void
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busy) onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        className="mem-reset-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="mem-reset-title">메모리 초기화</div>
        <div className="mem-reset-body">
          현재 워크스페이스의 IR(요약 메모리)을 비웁니다. 되돌릴 수 없습니다. archive 스냅샷은
          보존됩니다.
        </div>
        <label className="mem-reset-option">
          <input type="checkbox" checked={alsoTurns} onChange={onToggleAlsoTurns} disabled={busy} />
          <span>최근 turn 기록(turns.jsonl)도 함께 초기화</span>
        </label>
        {error && <div className="mem-reset-error">{error}</div>}
        <div className="mem-reset-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? '초기화 중…' : '초기화'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MemGroup({
  title,
  open,
  onToggle,
  action,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`mem-group${open ? ' open' : ''}`}>
      <button type="button" className="mem-group-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRightIcon className={`mem-group-chevron${open ? ' rot' : ''}`} />
        <span className="mem-group-title">{title}</span>
        {action && <span className="mem-group-action">{action}</span>}
      </button>
      {open && <div className="mem-group-body">{children}</div>}
    </div>
  )
}

// ─── γ AI 지시 카드 ────────────────────────────────────────────────────
function InstructionsCard({
  files,
  onAction,
  now
}: {
  files: InstructionFileInfo[]
  onAction: (info: InstructionFileInfo) => Promise<void> | void
  now: number
}): React.JSX.Element {
  if (files.length === 0) {
    return <div className="mem-card mem-card-empty">워크스페이스 경로가 없습니다.</div>
  }
  return (
    <div className="mem-card mem-card-static">
      <ul className="mem-instructions-list">
        {files.map((f) => (
          <li key={f.kind} className="mem-instruction-row">
            <div className="mem-instruction-meta">
              <div className="mem-instruction-name mono">{f.filename}</div>
              <div className="mem-instruction-sub">
                {f.exists
                  ? `${formatBytes(f.sizeBytes ?? 0)} · ${formatRelative(f.mtime, now)}`
                  : '미생성'}
              </div>
            </div>
            <button
              type="button"
              className="mem-instruction-action"
              onClick={() => void onAction(f)}
              title={f.exists ? '에디터에서 열기' : '빈 파일 생성 후 열기'}
              aria-label={f.exists ? '에디터에서 열기' : '만들기'}
            >
              {f.exists ? <ExternalLinkIcon /> : <PlusIcon />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── δ Refine / Quota 카드 ────────────────────────────────────────────
function RefineQuotaCard({
  settings,
  quota
}: {
  settings: AppSettings | null
  quota: QuotaSnapshot | null
}): React.JSX.Element {
  const policyLabel = settings
    ? {
        auto: '자동 (gemini-flash 우선)',
        'gemini-flash': 'Gemini Flash 고정',
        active: '활성 모델 헤드리스',
        off: '정제 끔'
      }[settings.refineModel]
    : '—'

  const severity = quota?.severity ?? 'unknown'
  const severityLabel: Record<typeof severity, string> = {
    unknown: '미감지',
    ok: 'OK',
    warn: '주의',
    critical: '임박',
    exceeded: '초과'
  }
  const severityCls: Record<typeof severity, string> = {
    unknown: 'mem-badge-skip',
    ok: 'mem-badge-pass',
    warn: 'mem-badge-pend',
    critical: 'mem-badge-mod',
    exceeded: 'mem-badge-fail'
  }

  return (
    <div className="mem-card mem-card-static">
      <div className="mem-kv-row">
        <span className="mem-kv-key">정제 정책</span>
        <span className="mem-kv-val">{policyLabel}</span>
      </div>
      <div className="mem-kv-row">
        <span className="mem-kv-key">Gemini 사용량</span>
        <span className="mem-kv-val">
          <span className={`mem-badge ${severityCls[severity]}`}>{severityLabel[severity]}</span>
          {quota?.usedPercent !== null && quota?.usedPercent !== undefined && (
            <span className="mem-kv-suffix">{quota.usedPercent}%</span>
          )}
        </span>
      </div>
      {quota?.forcedFallback && (
        <div className="mem-kv-note">응답 에러로 폴백 마킹됨 (UTC 자정 해제)</div>
      )}
    </div>
  )
}

// ─── β Turn 흐름 카드 ─────────────────────────────────────────────────
// 막대 시각 단순화 — 실제 trigger 임계(countThreshold + keepRecent)와 별개로 막대를
// 7칸으로 분할(tick 6개). turn 누적이 시각상 일정 간격으로 채워지는 게이지 역할.
// trigger 코드 조건은 그대로(`uncompacted >= countThreshold`), 막대 100% 도달과 실제
// trigger 시점은 일치하지 않을 수 있음 — 정확한 trigger 조건은 hint·문서에서 별도 안내.
const BAR_DIVISIONS = 7

function TurnFlowCard({ summary }: { summary: TurnsSummaryResult | null }): React.JSX.Element {
  if (!summary) {
    return <div className="mem-card mem-card-static mem-card-empty">집계 중…</div>
  }
  const uncompacted = Math.max(0, summary.count - summary.keepRecent)
  const countPct = Math.min(100, (summary.count / BAR_DIVISIONS) * 100)
  const bytePct = Math.min(100, (summary.bytes / summary.bytesThreshold) * 100)
  const willTrigger =
    uncompacted >= summary.countThreshold || summary.bytes >= summary.bytesThreshold

  // tick 6개, 7칸 분할 — 1/7, 2/7, ..., 6/7 위치.
  const ticks = Array.from({ length: BAR_DIVISIONS - 1 }, (_, i) => i + 1)

  return (
    <div className="mem-card mem-card-static">
      <div className="mem-flow-header">
        <span className="mem-flow-label">{willTrigger ? '곧 자동 정제됨' : '다음 정제까지'}</span>
        <span className="mem-flow-count">
          {summary.count} turn · {formatBytes(summary.bytes)}
        </span>
      </div>

      <div className="mem-flow-row">
        <span className="mem-flow-axis">Turn</span>
        <div className="mem-flow-bar" title={`${summary.count} turn`}>
          <div className="mem-flow-bar-fill" style={{ width: `${countPct}%` }} />
          {ticks.map((t) => (
            <span
              key={t}
              className="mem-flow-tick"
              style={{ left: `${(t / BAR_DIVISIONS) * 100}%` }}
            />
          ))}
        </div>
      </div>

      <div className="mem-flow-row">
        <span className="mem-flow-axis">Bytes</span>
        <div className="mem-flow-bar" title={`${summary.bytes}/${summary.bytesThreshold} bytes`}>
          <div className="mem-flow-bar-fill alt" style={{ width: `${bytePct}%` }} />
        </div>
      </div>
    </div>
  )
}

// ─── 현재 IR 단일 카드 ────────────────────────────────────────────────
function CurrentIrCard({
  ir,
  updatedLabel,
  onOpen,
  onDelete
}: {
  ir: IR | null
  updatedLabel: string
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  if (!ir) {
    return (
      <div className="mem-card mem-card-static mem-card-empty">
        아직 IR이 생성되지 않았습니다. 대화 시작 후 자동 정제 또는 우측 위 ✨로 수동 정제.
      </div>
    )
  }
  // key 동기화 — IR 본문이 바뀌면(promote 또는 refine 직후) wrapper가 remount되며
  // CSS animation 'mem-card-promote'가 한 번 발동해 새 카드가 위에서 내려오는 효과.
  const animKey = ir.meta?.updatedAt ?? ir.intent.goal ?? 'current'
  return (
    <div className="mem-card-wrap mem-card-promote" key={animKey}>
      <button type="button" className="mem-card mem-card-button" onClick={onOpen}>
        <div className="mem-card-head">
          <span className="mem-card-eyebrow">현재 메모리</span>
          <span className="mem-card-time">{updatedLabel}</span>
        </div>
        <div className="mem-card-title">{ir.intent.goal?.trim() || '(목표 미설정)'}</div>
        <div className="mem-card-counts">
          <CountChip label="결정" n={ir.decisions.length} />
          <CountChip label="파일" n={ir.files.length} />
          <CountChip label="명령" n={ir.commands.length} />
          <CountChip label="테스트" n={ir.tests.length} />
          <CountChip label="할 일" n={ir.pending.length} />
        </div>
      </button>
      <button
        type="button"
        className="mem-card-delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title="현재 메모리 비우기 (archive 최신 스냅샷 복원)"
        aria-label="현재 메모리 비우기"
      >
        <TrashIcon />
      </button>
    </div>
  )
}

// ─── Archive 스냅샷 카드 ──────────────────────────────────────────────
function ArchiveCard({
  snapshot,
  relativeLabel,
  onOpen,
  onDelete
}: {
  snapshot: ArchiveSnapshotMeta
  relativeLabel: string
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const total =
    snapshot.counts.decisions +
    snapshot.counts.files +
    snapshot.counts.commands +
    snapshot.counts.tests +
    snapshot.counts.pending
  return (
    <div className="mem-card-wrap">
      <button type="button" className="mem-card mem-card-button mem-card-history" onClick={onOpen}>
        <div className="mem-card-head">
          <span className="mem-card-eyebrow">스냅샷</span>
          <span className="mem-card-time">{relativeLabel}</span>
        </div>
        <div className="mem-card-title">{snapshot.intentGoal?.trim() || '(목표 미설정)'}</div>
        <div className="mem-card-counts">
          <CountChip label="결정" n={snapshot.counts.decisions} />
          <CountChip label="파일" n={snapshot.counts.files} />
          <CountChip label="명령" n={snapshot.counts.commands} />
          <CountChip label="테스트" n={snapshot.counts.tests} />
          <CountChip label="할 일" n={snapshot.counts.pending} />
          <span className="mem-count-total">총 {total}</span>
        </div>
      </button>
      <button
        type="button"
        className="mem-card-delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title="이 스냅샷 삭제"
        aria-label="스냅샷 삭제"
      >
        <TrashIcon />
      </button>
    </div>
  )
}

function CountChip({ label, n }: { label: string; n: number }): React.JSX.Element {
  return (
    <span className={`mem-count-chip${n === 0 ? ' empty' : ''}`}>
      <span className="mem-count-chip-label">{label}</span>
      <span className="mem-count-chip-n">{n}</span>
    </span>
  )
}
