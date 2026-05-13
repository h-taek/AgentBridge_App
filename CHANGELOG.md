# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 1.1.0 형식을 따르며 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 사용합니다.

## [0.0.2] — 2026-05-13

ad-hoc 서명 베타. v0.0.1 패키지 빌드에서 발견된 결함 두 건 수정 + 자동 업데이트 채널 사전 도입.

### Fixed

- **Hook 시스템 자동 IR 주입이 패키지 빌드에서 항상 실패하던 문제** — `agentbridge-memory` helper binary 경로가 `process.resourcesPath/bin/...`로 잘못 참조돼 hook 없이 spawn 폴백됐습니다. `app.asar.unpacked/resources/bin/...`로 정정. 차별점 3(IR 자동 핸드오프)이 패키지 빌드에서 정상 동작합니다.
- **Gemini quota 자동 background probe가 패키지 빌드에서 즉시 종료되던 문제** — probe PTY spawn에 login shell PATH가 누락돼 `env: node: No such file or directory`로 exit 127. 어댑터 공용 env 빌더(`buildAdapterEnv`)를 probe 흐름에 inject. footer 자동 캡처 + 자동 폴백 흐름이 정상 동작합니다.

### Added

- **자동 업데이트(electron-updater)** — GitHub Releases의 `latest-mac.yml` 채널을 부팅 직후 + 6시간 주기로 polling. 새 버전 발견 시 백그라운드 다운로드 후 다음 종료 시 자동 설치. 진행/오류는 `~/Library/Logs/agentbridge/main.log`에 누적. ad-hoc 서명 단계에선 다운로드까지만 동작하며, Apple Developer ID 인증서 + notarytool 통과 후 update 흐름이 작동합니다.

## [0.0.1] — 2026-05-13

첫 공개. macOS만 지원, ad-hoc 서명 빌드.

> **외부 사용자 첫 실행 안내**: ad-hoc 서명이라 macOS Gatekeeper가 차단합니다.
> 다음 중 하나로 우회:
>
> 1. 터미널: `xattr -dr com.apple.quarantine /Applications/AgentBridge.app`
> 2. 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"

### Added — 핵심 기능

- **멀티 에이전트 워크스페이스** — 한 워크스페이스 안에 Claude · Codex · Gemini CLI 탭을 동시에 띄울 수 있습니다. xterm.js로 각 CLI의 인터랙티브 화면을 그대로 임베드합니다.
- **IR 자동 핸드오프** — 매 사용자 메시지마다 IR(공유 메모리)이 hook 메커니즘으로 자동 주입됩니다. 모델을 갈아타도 작업 맥락이 끊기지 않습니다.
- **IR 정제** — Gemini 무료 티어를 헤드리스로 호출해 IR을 갱신합니다. 메인 모델(Claude/Codex) 토큰을 소비하지 않습니다. compaction 임계(turn 수/byte)를 넘으면 자동으로, 또는 메모리 패널 버튼으로 수동 실행할 수 있습니다.
- **메모리 패널** — 우측 사이드바에 AI 지시 / Refine·Quota / 메모리 3 그룹의 collapsible 카드. 현재 IR · 이전 스냅샷 · Turn 흐름을 한눈에 확인할 수 있고, IR 카드별 개별 삭제, 메모리 초기화, 수동 정제가 가능합니다.
- **세션 영속화 + resume** — 모든 워크스페이스/세션은 자동으로 저장되며, 앱 재실행 시 native CLI resume(`claude --resume` / `codex resume` / `gemini --resume`)으로 이전 대화를 그대로 이어갈 수 있습니다.
- **사용자 자산 격리** — 글로벌 설정(`~/.claude` / `~/.codex` / `~/.gemini`)은 수정하지 않습니다. 워크스페이스 cwd에는 CLI native config 3종(`.codex/hooks.json` / `.codex/config.toml` / `.gemini/settings.json`)만 마커 블록 merge로 추가합니다. claude는 cwd 무침범으로 동작합니다.

### Added — 부가 기능

- **드래그 앤 드롭 첨부** — 파일을 xterm 영역에 떨어뜨리면 절대 경로가 모델 입력에 자동 paste됩니다. bracketed paste로 자동 submit을 차단해 사용자가 직접 Enter를 누를 때까지 모델이 전송하지 않습니다. 한 번에 최대 20개 파일.
- **멀티 윈도우** — 워크스페이스를 별도 BrowserWindow로 띄울 수 있습니다. ⌘N으로 새 빈 윈도우, 좌 사이드바 우클릭 메뉴에서 "새 창으로 열기". 한 워크스페이스 = 한 윈도우 정책으로 중복 열림을 차단합니다.
- **내장 터미널 세션** — 일반 zsh PTY 탭. 모델 spawn 없이 CLI 환경 점검·잡일용으로 사용할 수 있습니다.
- **홈 화면 부트스트랩** — 앱 실행 시 홈 화면에서 메시지를 입력하면 `~/AgentBridge/Chat-YYMMDD-HHMM/` 폴더에 워크스페이스를 자동 생성해 모델을 시작합니다.
- **Gemini quota 자동 폴백** — Gemini CLI footer의 `X% used`를 자동 감지해 95% 이상이면 활성 모델로 자동 폴백합니다. 임계 진입 시 UI 배지로 안내하며, UTC 자정에 자동 해제됩니다.
- **워크스페이스/세션 인라인 rename** — 좌 사이드바 펜 아이콘 또는 우클릭 메뉴로 직접 이름 편집. IME composition 안전.
- **codex hook trust 안내** — codex의 `/hooks` 수동 승인 절차를 UI 배너로 안내합니다.

### Added — 단축키

- ⌘B / ⌘⌥B — 좌·우 사이드바 토글
- ⌘N — 새 빈 윈도우 (macOS Safari/Finder 표준)
- ⌘Q — 앱 종료
- Enter / ⇧Enter — 홈 화면 전송 / 줄바꿈
- Esc — 모달 닫기 · sub-page 뒤로
- ⇧Enter (터미널 안) — 줄바꿈 (Option+Enter 동등)

### Known limitations

- 다국어 UI(영어 등) 및 라이트 테마는 잠겨 있습니다(언어 `ko` / 테마 `dark` 고정).
- 사용자 정의 단축키, 로컬 LLM 어댑터, 드래그 앤 드롭 폴더 지원 없음.
- macOS 외 플랫폼(Windows/Linux) 빌드 없음.

[0.0.2]: https://github.com/h-taek/AgentBridge/releases/tag/v0.0.2
[0.0.1]: https://github.com/h-taek/AgentBridge/releases/tag/v0.0.1
