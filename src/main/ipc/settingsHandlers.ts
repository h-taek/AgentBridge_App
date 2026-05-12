import { ipcMain } from 'electron'
import log from 'electron-log/main'
import {
  IpcChannel,
  type AppSettings,
  type QuotaProbeResult,
  type QuotaSnapshot
} from '@shared/ipc'
import { loadSettings, saveSettings } from '../modules/settings'
import { getQuotaSnapshot, probeQuotaInBackground } from '../modules/geminiQuotaTracker'

// settings:get/set — M3 N 청크. UI가 refineModel 토글에 사용.
async function handleSettingsGet(): Promise<AppSettings> {
  return loadSettings()
}

async function handleSettingsSet(_e: unknown, patch: Partial<AppSettings>): Promise<AppSettings> {
  log.info('settings:set', patch)
  return saveSettings(patch)
}

// quota:get — 현재 영속화된 quota snapshot. UI 배지가 폴링.
async function handleQuotaGet(): Promise<QuotaSnapshot> {
  return getQuotaSnapshot()
}

// quota:probe — gemini PTY를 background로 spawn → footer "% used" 캡처 → SIGTERM.
// 사용자 명시 액션(RefineSettingsPanel "지금 확인" 버튼). 자동 호출 없음.
async function handleQuotaProbe(): Promise<QuotaProbeResult> {
  log.info('quota:probe 호출')
  const result = await probeQuotaInBackground()
  return result
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, handleSettingsGet)
  ipcMain.handle(IpcChannel.SettingsSet, handleSettingsSet)
  ipcMain.handle(IpcChannel.QuotaGet, handleQuotaGet)
  ipcMain.handle(IpcChannel.QuotaProbe, handleQuotaProbe)
}
