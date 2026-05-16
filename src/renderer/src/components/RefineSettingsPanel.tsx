import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, EnvProbeResult, QuotaSnapshot, RefineModelPolicy } from '@shared/ipc'

// M3 N 청크 — refine 모델 정책 토글 + gemini quota 상태 배지.
// architecture §14.7.
//
// 표시 항목:
//   - 현재 refineModel (auto / gemini-flash / active / off) 토글
//   - 오늘 gemini-flash 호출 횟수 + 임계 색상 (ok=회색 / warn=노랑 / critical=주황 / exceeded=빨강)
//   - shouldFallback=true면 "토큰 비용 부담 중" 안내 (architecture §14.7 폴백 정책)
//
// 폴링 — 5초마다 quota:get. spawn 직후 즉시 반영 안 돼도 다음 polling 사이클에 잡힘.

const POLICY_LABELS: Record<RefineModelPolicy, string> = {
  auto: 'auto (gemini 우선)',
  'gemini-flash': 'gemini-flash 강제',
  active: '활성 모델 (비용 부담)',
  off: 'refine off'
}

const SEVERITY_COLORS: Record<
  QuotaSnapshot['severity'],
  { fg: string; bg: string; border: string }
> = {
  unknown: { fg: '#888', bg: '#1f1f1f', border: '#333' },
  ok: { fg: '#a0a0a0', bg: '#1f1f1f', border: '#333' },
  warn: { fg: '#f4d77a', bg: '#3a2f12', border: '#8a6d2a' },
  critical: { fg: '#f4a062', bg: '#3a2412', border: '#8a5a2a' },
  exceeded: { fg: '#f47a7a', bg: '#3a1212', border: '#8a2a2a' }
}

const SEVERITY_LABELS: Record<QuotaSnapshot['severity'], string> = {
  unknown: 'gemini 탭 미사용',
  ok: '정상',
  warn: '경고',
  critical: '한도 근접',
  exceeded: '한도 초과'
}

export function RefineSettingsPanel(): React.JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [env, setEnv] = useState<EnvProbeResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeReason, setProbeReason] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.agentbridge.settings.get().then((s) => {
      if (!cancelled) setSettings(s)
    })
    void window.agentbridge.envProbe().then((e) => {
      if (!cancelled) setEnv(e)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // quota 폴링 — 5초 간격. settings panel이 boot시 1회 + interval.
  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      void window.agentbridge.quota.get().then((q) => {
        if (!cancelled) setQuota(q)
      })
    }
    poll()
    const id = setInterval(poll, 5_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const handlePolicyChange = useCallback(async (next: RefineModelPolicy) => {
    setSaving(true)
    try {
      const updated = await window.agentbridge.settings.set({ refineModel: next })
      setSettings(updated)
    } finally {
      setSaving(false)
    }
  }, [])

  const handleProbeNow = useCallback(async () => {
    setProbing(true)
    setProbeReason(null)
    try {
      const r = await window.agentbridge.quota.probe()
      setQuota(r.snapshot)
      if (!r.ok) {
        setProbeReason(r.reason ?? '캡처 실패')
      } else {
        setProbeReason(null)
      }
    } finally {
      setProbing(false)
    }
  }, [])

  if (!settings) return null

  const sev = quota?.severity ?? 'ok'
  const color = SEVERITY_COLORS[sev]
  const geminiInstalled = env?.clis.find((c) => c.kind === 'gemini')?.found === true
  // gemini 미설치 + 'auto'/'gemini-flash' 정책이면 *항상* active 폴백 — 토큰 비용 사용자 부담.
  // 'active'/'off'는 gemini 무관이라 미설치 배지 안 띄움.
  const showGeminiMissingBadge =
    env != null &&
    !geminiInstalled &&
    (settings.refineModel === 'auto' || settings.refineModel === 'gemini-flash')

  return (
    <details
      style={{
        margin: '8px 0',
        padding: '6px 12px',
        border: '1px solid #333',
        borderRadius: 6,
        background: '#1a1a1a',
        fontSize: 13
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        refine 설정 · 모델 = <strong>{POLICY_LABELS[settings.refineModel]}</strong>
        {quota && (
          <span
            style={{
              marginLeft: 12,
              padding: '2px 8px',
              borderRadius: 4,
              background: color.bg,
              color: color.fg,
              border: `1px solid ${color.border}`,
              fontSize: 11
            }}
            title={
              quota.lastSeenAt
                ? `gemini 인터랙티브 footer 캡처: ${new Date(quota.lastSeenAt).toLocaleString()}`
                : 'gemini 인터랙티브 탭을 한 번 열면 footer에서 % used 캡처'
            }
          >
            gemini quota {quota.usedPercent != null ? `${quota.usedPercent}% used` : '— (미캡처)'} ·{' '}
            {SEVERITY_LABELS[sev]}
            {quota.forcedFallback && ' · 응답 에러'}
          </span>
        )}
      </summary>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['auto', 'gemini-flash', 'active', 'off'] as RefineModelPolicy[]).map((p) => (
          <label
            key={p}
            style={{
              cursor: saving ? 'wait' : 'pointer',
              padding: '4px 10px',
              border: `1px solid ${settings.refineModel === p ? '#5a8aff' : '#333'}`,
              borderRadius: 4,
              background: settings.refineModel === p ? '#1a2540' : 'transparent',
              fontSize: 12
            }}
          >
            <input
              type="radio"
              name="refineModel"
              value={p}
              checked={settings.refineModel === p}
              onChange={() => void handlePolicyChange(p)}
              disabled={saving}
              style={{ marginRight: 6 }}
            />
            {POLICY_LABELS[p]}
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="btn"
          onClick={() => void handleProbeNow()}
          disabled={probing}
          title="gemini PTY를 background로 띄워 footer % used 캡처 후 종료 (수초 소요)"
          style={{ fontSize: 12 }}
        >
          {probing ? '캡처 중...' : 'gemini quota 지금 확인'}
        </button>
        {probeReason && (
          <span style={{ fontSize: 11, color: '#a07a7a' }}>캡처 실패: {probeReason}</span>
        )}
      </div>
      {quota?.shouldFallback && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            background: '#3a2412',
            color: '#f4a062',
            border: '1px solid #8a5a2a',
            borderRadius: 4,
            fontSize: 12
          }}
        >
          ⚠ gemini-flash 한도 근접/초과 — 다음 refine부터 활성 모델로 자동 폴백됩니다 (토큰 비용
          사용자 부담). 자정(UTC) 이후 자동 해제.
        </div>
      )}
      {quota?.severity === 'unknown' && !showGeminiMissingBadge && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            background: '#1f2030',
            color: '#9aa0c0',
            border: '1px solid #3a3f55',
            borderRadius: 4,
            fontSize: 12
          }}
        >
          gemini quota는 인터랙티브 탭의 footer에서 캡처됩니다. gemini 탭을 한 번 열면 그 시점의 %
          used가 영속화되어 다음 refine 호출 시 사전 폴백 판단에 사용됩니다.
        </div>
      )}
      {showGeminiMissingBadge && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 10px',
            background: '#3a2f12',
            color: '#f4d77a',
            border: '1px solid #8a6d2a',
            borderRadius: 4,
            fontSize: 12
          }}
        >
          ⚠ <strong>gemini CLI 미설치</strong> — refine 시 활성 모델로 폴백되어{' '}
          <strong>토큰 비용이 사용자에게 부담</strong>됩니다. 무료 티어 활용을 원하시면 gemini CLI
          설치 후 인증을 완료하세요. (gemini 미설치 상태에서는{' '}
          <code>refineModel=&apos;active&apos;</code>이 더 명시적입니다.)
        </div>
      )}
      {settings.refineModel === 'off' && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
          refine 비활성 — IR이 갱신되지 않아 hook은 빈 컨텍스트만 inject합니다.
        </div>
      )}
    </details>
  )
}
