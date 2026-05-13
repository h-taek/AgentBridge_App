import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

// AgentBridge auto-update (electron-updater + electron-builder GitHub publish 채널).
//
// 동작:
//   - 부팅 직후 1회 + 6시간 주기로 GitHub Releases의 `latest-mac.yml` 조회
//   - 새 버전 발견 시 백그라운드 다운로드 → 다음 앱 종료 후 자동 설치 (native dialog 노출)
//   - 진행 상황 / 오류는 electron-log로 main.log에 누적
//
// 제약:
//   - dev 모드(electron-vite dev) 자체는 skip — 패키지된 .app만 실제 update 가능
//   - ad-hoc 서명(identity '-') 상태에선 macOS가 새 빌드 적용을 거부할 수 있음. Apple Developer ID
//     인증서 + notarytool 통과 후에 update 흐름이 완전 동작. 코드 자체는 사전 도입(v0.0.2 이후
//     사용자가 인증서를 적용하면 별도 코드 수정 없이 작동).

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6시간

let scheduledPoll: NodeJS.Timeout | null = null

export function initAppUpdater(): void {
  // dev에선 dev-app-update.yml이 존재해야만 동작. 본 프로젝트는 그 stub을 untrack(`HANDOFF.md`
  // 운영 정책)이라 일반 dev 흐름에선 skip이 안전. 사용자가 직접 dry-run을 원하면 stub을 둔 채로
  // forceDevUpdateConfig=true를 직접 toggle.
  if (is.dev) {
    log.info('appUpdater — dev 모드 skip')
    return
  }

  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('appUpdater — checking for update')
  })
  autoUpdater.on('update-available', (info) => {
    log.info('appUpdater — update available', { version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    log.info('appUpdater — update not available', { version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    log.info('appUpdater — download progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('appUpdater — update downloaded (다음 종료 시 설치)', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    log.warn('appUpdater — error', { message: err?.message ?? String(err) })
  })

  const runCheck = (): void => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((err) => log.warn('appUpdater — checkForUpdates 실패', { err: String(err) }))
  }

  runCheck()
  scheduledPoll = setInterval(runCheck, POLL_INTERVAL_MS)
  app.on('before-quit', () => {
    if (scheduledPoll) {
      clearInterval(scheduledPoll)
      scheduledPoll = null
    }
  })
}
