# Changelog

## [0.28.0] - 2026-05-06

### Fixed
- **어노테이션 소실 버그 6건 수정**
- **P1**: smudge 필터 all-or-nothing 태그 체크 → 삽입 위치별 개별 중복 체크로 변경 — 기존 태그 1개만 있어도 전체 복원이 건너뛰어지던 문제 해결
- **P2**: clean 필터 `blockStartRe` 매칭 시 같은 줄에 `*/`가 있는 경우 skip 설정하지 않도록 수정
- **P3**: clean 필터 skip 중 `*/` 뒤의 코드가 손실되던 버그 수정 — `*/` 이후 내용 보존
- **P4**: `scanDocument` 캐스케이드 와이프 방지 — 기존 어노테이션이 있었는데 스캔 결과가 0이면 기존 것을 보존
- **P5**: `_deletionGuard` 타임아웃 2000ms → 5000ms 증가 — 느린 디스크/큰 파일에서 재추가 방지 가드 만료 방지
- **P6**: smudge 필터 멀티라인 어노테이션 복원 시 빈 줄 생성 → 항상 한 줄짜리 주석으로 복원

## [0.27.0] - 2026-05-06

### Removed
- **Goal 기능 삭제**: GoalTracker, Goal 설정/보기/완료/삭제 커맨드, 상태바 아이템, AI 프롬프트 Goal 컨텍스트 제거
- **관련 설정 삭제**: `jungleKit.goal.showStatusBar`, `jungleKit.goal.includeInAI`

## [0.26.0] - 2026-05-06

### Fixed
- **tagSystem**: `_deletionGuard` 키에 line 번호 포함 — 동일 content 태그 충돌 방지
- **tagSystem**: 미종료 블록 주석에서 `i`가 잘못 전진하는 버그 수정 (`blockClosed` 플래그 도입)
- **tagSystem**: `clearAllAnnotations`/`clearFileAnnotations`에 `_deletionGuard` 적용 — 삭제 후 재추가 방지
- **tagSystem**: EOF 줄 삭제 시 빈 줄 남는 버그 수정 — 이전 줄 개행 포함 삭제
- **tagSystem**: `addTag` 입력에서 newline 제거 — 블록 주석 깨짐 방지
- **tagSystem**: `handleDrop` 시 `_scanTimer` 취소 — sortOrder 덮어쓰기 방지
- **tagSystem**: `_lastKnownHead` TOCTOU 수정 — diff 완료 후 업데이트
- **tagSystem**: `parseDiffAdditions` — `currentFile` 빈 문자열 방어, 함수 프로토타입 제외
- **tagSystem**: clean filter CRLF 지원 + trailing newline 보존
- **tagSystem**: `removeAnnotationLinesFromFiles` 중복 범위 방지 + EOF 처리 개선
- **tagSystem**: 초기 커밋 에러 감지 — exit code 128 + bad revision 추가
- **tagSystem**: `_navIndex` 필터 변경 시 리셋
- **prPanel**: branch name sanitization 시 변경 감지 및 에러 표시
- **prPanel**: `truncateDiffSmart` perFile=0 방어 + limit 초과 방지
- **prPanel**: AI 에러 메시지 타입 안전성 개선
- **githubPrClient**: `JSON.parse` try/catch 래핑 — 비-JSON 응답 크래시 방지
- **githubPrClient**: 응답 body 2MB 크기 제한 — 메모리 폭주 방지
- **gitUtils**: 커밋 로그 구분자를 ASCII Unit Separator로 변경 — 커밋 메시지 내 구분자 충돌 방지
- **gitUtils**: `NaN` count 방어
- **smartCommit**: `repositories[0]` → 워크스페이스 루트 매칭 (멀티루트 대응)
- **smartCommit**: diff 트런케이션을 줄 경계에서 자르기
- **smartCommit**: 에러 메시지 타입 안전성 개선
- **goalTracker**: `formatDate` Invalid Date 방어
- **gdbWarnTracker**: `applyEdit` 결과 확인
- **configManager**: `.gitignore` 항목 체크를 줄 단위 exact match로 변경

## [0.25.6] - 2026-05-06

### Fixed
- **tagSystem**: 태그 삭제 직후 재스캔으로 인한 재추가 방지 가드(`_deletionGuard`) 로직 구현
- **tagSystem**: `deleteAnnotation` 줄 번호 조정 시 삭제 범위 내 annotation이 잘못 이동하던 버그 수정 (`> ann.line` → `>= endLine`)

## [0.25.5] - 2026-05-06

### Fixed
- **tagSystem**: 새로고침 시 어노테이션이 전부 삭제되는 치명적 버그 수정 — `reconcileWorkspaceAnnotations`가 clean filter로 태그가 제거된 파일의 어노테이션을 삭제하던 문제 제거

## [0.25.1] - 2026-05-06

### Added
- **goalTracker**: Codex CLI의 `/goal`과 비슷한 장기 작업 목표 고정 기능 추가
  - `Goal 설정`, `Goal 보기`, `Goal 완료 처리`, `Goal 삭제` 명령 제공
  - `.annotation/goal.json`에 로컬 저장, 상태바에서 항상 확인 가능
  - 활성 Goal을 AI 커밋 메시지, AI PR 생성, AI 리뷰 설명 프롬프트에 자동 포함
- **tooling**: ESLint 설정과 smoke test 추가
  - `npm run lint`가 실제로 동작하도록 `.eslintrc.cjs` 추가
  - `npm test`가 compile + 명령/README/activation smoke 검증을 수행하도록 복구

### Changed
- **package.json**: `jungleKit.goal.showStatusBar`, `jungleKit.goal.includeInAI` 설정 추가
- **README / FEATURE_SPEC**: Goal 기능 사용법 및 동작 기준 문서화
- **package.json / README**: `.annotation` 기준의 활성화 조건, 설정 설명, 저장 경로로 정렬

### Fixed
- **repo hygiene**: 추적 중이던 레거시 `.jungle-kit` 로컬 산출물과 잘못된 `.gitattributes` 제거
- **validation**: 깨져 있던 `npm test` 스크립트 복구 및 lint 실행 가능 상태로 정리

## [0.25.0] - 2026-05-05

### Added
- **gdbWarnTracker**: GDB 디버그 콘솔 자동 감시 — breakpoint hit, signal, PANIC, ASSERT FAILED 감지 시 해당 위치에 `@warn` 어노테이션 자동 삽입
  - 지원 패턴: `Breakpoint N, func() at file:line`, `Program received signal SIGSEGV`, `Kernel PANIC at file:line`, `ASSERT FAILED at file:line`
  - 중복 삽입 방지 (동일 세션 내 같은 위치 1회만)
  - 상대 경로(../../) 자동 해석 via workspace glob 검색

### Fixed
- **prPanel**: AI PR 생성 시 diff 절삭 한도를 6KB → 80KB로 증가하여 대규모 변경도 정확히 분석
- **prPanel**: 파일별 균등 분배 절삭(`truncateDiffSmart`) 도입 — 첫 번째 파일만 보내던 문제 해결
- **tagSystem**: smudge filter Windows 경로 정규화 regex 수정 (이중 백슬래시 → 단일 백슬래시 매칭)

## [0.24.2] - 2026-05-05

### Fixed
- **tagSystem**: smudge filter 구현 — `git checkout`/`git pull` 시 `annotations.json` 기반으로 어노테이션 주석 자동 복원
  - 이중 삽입 방지 (이미 태그 존재 시 스킵)
  - JSON 파싱 실패, 파일 미존재 시 원본 그대로 통과 (안전 우선)
  - 배열 join 방식으로 이스케이핑 문제 완전 해소

## [0.24.0] - 2026-05-05

### Added
- **tagSystem**: `@note` 태그 타입 추가 — 개인 메모용 (사이드바 미표시, git diff 제외)
- **apiKeyManager**: 환경변수 `OPENAI_API_KEY` 폴백 지원 (SecretStorage → env var 순서)
- **tagSystem**: 기본 단축키 15개 확장 (네비게이션·태그 관리·개별 태그·git 단축키)
- **prPanel**: PR 생성 진행 상태 메시지 3단계 (`기존 PR 확인 중` → `변경 파일 분석 중` → `AI로 PR 내용 생성 중`)

### Changed
- **configManager/tagSystem**: 설정 폴더 `.jungle-kit` → `.annotation` 마이그레이션 (자동 감지·이동·레거시 삭제)
- **tagSystem**: git clean filter 이름 `jungle-local` → `annotation-local` (레거시 자동 제거)
- **tagSystem**: TreeView 접기/펼치기 토글 (`_allCollapsed` 상태 기반)
- **tagSystem**: `maxResults` 파일 스캔 제한 제거 — 전체 워크스페이스 태그 수집
- **shadowDiff**: 배경 장식을 세로선(borderLeft)에서 미세 배경색(backgroundColor)으로 변경
- **styleEnforcer**: `.clang-format` 항상 최신 내용으로 덮어쓰기 (가드 제거)
- **styleEnforcer**: `editor.formatOnSave` 무조건 설정 (조건부 가드 제거)
- **configManager**: 미사용 설정 필드 제거 (`project`, `autoFix`, `clangFormatContent`)

### Security
- **shadowDiff**: 모든 shell 호출을 `execFileAsync` 인자 배열로 전환 — shell injection 완전 차단

## [0.23.1] - 2026-05-05

### Security
- **prPanel**: PR 생성 명령을 `execFile` 인자 배열로 전환하여 shell injection 방지
- **styleEnforcer**: clang-format 호출을 `execFile`로 전환

### Fixed
- **tagSystem**: git clean filter를 bash/sed/awk에서 Node.js로 완전 재작성 — macOS/Windows/Linux 크로스 플랫폼 지원
- **tagSystem**: `.gitattributes` 중복/레거시 엔트리 자동 정리 로직 추가
- **tagSystem**: `saveAnnotations()` 원자적 쓰기 (`.tmp` + `renameSync`)
- **tagSystem**: `generateId()` 밀리초 충돌 방지 카운터 추가
- **tagSystem**: 단축키 패널 재열기 시 HTML 갱신 후 reveal
- **tagSystem**: `loadShortcutSettings()` 파일 손상 시 기본값 3개 항목 반환
- **configManager**: `configDir` 정적 필드 → `getConfigDir()` 동적 getter 전환 (멀티루트/폴더 변경 대응)
- **prPanel**: `changeBase` 핸들러에 disposed 가드 추가 (await 후 패널 닫힘 대응)
- **shadowDiff**: `pullAndPush()`에 root 빈문자열 가드 추가
- **shadowDiff**: `fetchAndAnalyze()` 뮤텍스 추가 (중복 실행 방지)
- **gitUtils**: `run()` 메서드에 timeout 파라미터 추가 (기본 30초)
- **gitUtils**: `getDiffAgainst()` 빈 base 가드 추가

### Changed
- **styleEnforcer**: clang-format 바이너리를 npm 패키지로 번들 — 시스템 설치 불필요
- **styleEnforcer**: `.clang-format` 파일이 없을 때만 생성 (사용자 커스텀 보존)
- **styleEnforcer**: 레거시 `.jungle-kit/styles/.clang-format` 자동 마이그레이션
- **tagSystem**: 이전 bash 스크립트 (`clean-local.sh`, `smudge-local.sh`) 자동 제거
- **tagSystem**: 이전 필터명 (`junglekit-local`) git config에서 자동 제거

## [0.22.1] - 2026-05-05

### Fixed
- **prPanel**: "Webview is disposed" 크래시 수정 — 비동기 git 작업 중 패널 닫힘 감지 (`this._panel` null 체크)
- **prPanel**: Description 템플릿 및 Review Tags에서 이모지 제거
- **prPanel**: `checkExistingPR`에서 패널 disposed 상태 체크 추가

## [0.22.0] - 2026-05-05

### Fixed
- **tagSystem**: 단축키 패널 재열기 시 HTML 갱신되지 않던 문제 수정 — `reveal()` 전에 최신 설정으로 HTML 재생성
- **tagSystem**: `saveAnnotations()` try-catch 래핑 — 디스크 I/O 실패 시 크래시 대신 경고 메시지 표시
- **tagSystem**: `loadAnnotations()` JSON 손상 시 백업 파일 자동 생성 + 경고 메시지 표시 (데이터 유실 방지)
- **tagSystem**: `addTag()` applyEdit 실패 시 사용자에게 경고 표시 (읽기전용 파일 등)
- **prPanel**: `openPanel()` 에러 시 사용자에게 에러 메시지 표시 (무음 실패 제거)
- **prPanel**: `retainContextWhenHidden` 추가 — 탭 전환 시 입력 내용 유지
- **styleEnforcer**: `clang-format` 미설치(ENOENT) 감지 후 설치 안내 메시지 표시

## [0.21.1] - 2026-05-05

### Fixed
- **prPanel**: 기존 PR 자동감지 `--jq` 쉘 이스케이프 문제 → JSON 직접 파싱으로 전환
- **styleEnforcer**: `ColumnLimit: 79` → `0`으로 변경하여 긴 줄 자동 줄바꿈 비활성화
- **styleEnforcer**: `files.autoSave: afterDelay` 워크스페이스 설정 자동 활성화 추가

## [0.21.0] - 2026-05-05

### Fixed
- **prPanel**: 패널 토글 동작 구현 — 열려있으면 닫고, 닫혀있으면 여는 싱글톤 관리 (`_panel` 필드 + `onDidDispose` 정리)
- **prPanel**: 패널 열 때 `gh pr view`로 기존 PR 자동 감지 — 이미 열린 PR이 있으면 링크와 안내 표시
- **tagSystem**: 사이드바 "모든 태그 삭제" 버튼이 현재 필터(`filterType`/`filterText`)를 무시하고 전체 삭제하던 버그 수정 — 필터링된 항목만 삭제
- **tagSystem**: 단축키 설정 패널이 빈 화면으로 표시되던 버그 수정 — `loadShortcutSettings`에서 빈 배열 `[]` 반환 시 기본값 폴백 + WebView에서 빈 상태 안내 메시지 표시

## [0.20.1] - 2026-05-05

### Fixed
- **tagSystem**: `removeAnnotationLinesFromFiles`에서 파일 마지막 줄 어노테이션 삭제 시 EOF 범위 클램핑 누락 수정

## [0.20.0] - 2026-05-05

### Security
- **styleEnforcer**: `clang-format` 호출을 `execFile`로 전환하여 파일명 기반 shell injection 차단
- **shadowDiff**: `getLocalModifiedLines`에서 `execFile`로 전환하여 파일 경로 injection 차단
- **tagSystem**: WebView에 주입되는 JSON에 `<`/`>` 이스케이프 추가 (XSS 방지)

### Fixed
- **tagSystem**: `deleteAnnotation` 후 `applyEdit`이 트리거하는 재스캔이 삭제된 어노테이션을 복원하는 race condition 수정
- **tagSystem**: `selected.detail!` non-null assertion을 안전한 가드로 교체
- **prPanel**: `openPanel` 전체를 try/catch로 래핑 — 패널이 중간에 닫혀도 unhandled rejection 방지
- **prPanel**: `handleCreatePR` 중복 실행 방지 (`_isCreatingPR` guard)
- **prPanel**: PR 생성 성공 시 URL 클릭 가능한 링크로 표시
- **gitUtils**: `undoLastCommit`에 cwd 빈 문자열 guard 추가
- **extension.ts**: `goToTag`에서 파일 열기 실패 시 unhandled promise rejection → try/catch 전환
- **configManager**: `initProject` 전체를 try/catch로 래핑 — 읽기 전용 파일시스템에서 무음 실패 방지
- **configManager**: `ensureGitignoreEntry` TOCTOU race 수정 및 에러 핸들링 추가
- **configManager**: `.gitignore` 경로가 `.jungle-kit/` 안에 잘못 쓰이던 버그 수정 → 워크스페이스 루트로 변경
- **styleEnforcer**: `.clang-format` 쓰기에 try/catch 추가 (읽기 전용 파일시스템 대응)
- **smartCommit**: `max_completion_tokens` → `max_tokens`로 수정 (GPT-4o-mini 호환)

### Changed
- **shadowDiff**: `branchChanges` 원자적 교체 — 분석 중 부분 데이터 참조 race condition 제거
- **shadowDiff**: `_disposed` 플래그 추가 — 익스텐션 비활성화 후 타이머 콜백에서 disposed 리소스 접근 방지
- **shadowDiff**: `_outputChannel` deactivate 시 자동 정리
- **environmentValidator**: `dispose()` 메서드 추가 + deactivate 시 `_outputChannel` 정리

### Removed
- **tagSystem**: 미사용 `_treeView` 필드 제거 (dead code)
- **configManager**: 미사용 `pintos-activate` 환경 검사 키 제거 (dead config)

## [0.19.0] - 2025-05-05

### Fixed
- **치명적**: PR 패널 `onDidReceiveMessage` 핸들러에서 예외 발생 시 무음 실패 → 전체 try/catch + 에러 메시지 표시
- PR 생성 버튼 클릭 후 반응 없음 → "PR 생성 중..." 로딩 상태 표시 + 버튼 비활성화
- PR 각 단계(푸시/생성)마다 진행 상태 메시지 표시
- 에러/성공 시 버튼 상태 자동 복원

### Changed
- `devcontainer.json`에 `woonyong.jungle-dev-kit` 익스텐션 추가 — 컨테이너 재빌드 시 자동 설치
- `devcontainer.json`에 `extensions.autoUpdate: true` 설정 추가

## [0.18.6] - 2025-05-05

### Fixed
- PR 생성 시 `git push`가 HTTPS 인증 프롬프트에서 무한 대기하는 문제 — `gh auth setup-git`으로 credential helper 자동 등록
- `git push` / `gh pr create`에 timeout(30초) 추가하여 무응답 방지

## [0.18.5] - 2025-05-05

### Fixed
- `gh` 자동 설치: `apt-get` → GitHub Releases 바이너리 직접 다운로드 방식으로 변경 (도커 네트워크 제한 환경 대응)

## [0.18.4] - 2025-05-05

### Changed
- PR 생성 시 `gh` CLI 미설치 감지 → 확인 없이 백그라운드 자동 설치 후 PR 플로우 계속 진행

## [0.18.3] - 2025-05-05

### Added
- PR 생성 시 `gh` CLI 미설치 감지 → 자동 설치 제안 (터미널에서 `apt-get install gh` 실행)

## [0.18.2] - 2025-05-05

### Fixed
- `undoLastCommit`에서 제거된 `this.cwd` 참조 → `this.getCwd()` 호출로 수정 (컴파일 에러 방지)
- `parseNumstat`에서 바이너리 파일(`-\t-\t...`) 파싱 시 NaN/undefined 발생 → 필터링 추가
- `parseNumstat` 리네임 파일 경로 탭 포함 시 잘림 → `slice(2).join('\t')` 로 수정
- `getAuthorName`/`getCurrentCommitHash`에서 워크스페이스 미오픈 시 빈 문자열 cwd 전달 → 조기 반환 추가
- `styleEnforcer.checkFile`에서 워크스페이스 루트 미존재 시 빈 cwd로 clang-format 실행 → 조기 반환 추가
- `applyKeybindings`에서 HOME 환경변수 없을 때 루트(`/`) 경로에 keybindings.json 생성 시도 → 조기 반환 추가

## [0.18.1] - 2025-05-05

### Fixed
- PR 생성 시 `.jungle-kit` 디렉토리 미존재로 임시 파일 작성 실패(`ENOENT`) — 자동 생성 추가
- PR 패널 열 때 base 브랜치 후보가 0개이면 빈 `<select>` → 에러 메시지 후 패널 닫기
- PR base 브랜치 목록에 리모트 브랜치도 포함 — 로컬에 `main`이 없어도 `origin/main`을 base로 사용 가능
- detached HEAD 상태에서 PR 패널 열기 시도 시 조기 차단 + 에러 메시지

## [0.18.0] - 2025-05-05

### Fixed
- PR 생성 시 `gh auth status` 미체크로 미인증 상태에서 의미불명 에러 발생 — 인증·리모트 사전 검증 추가
- `git push` 실패가 `catch {}` 로 무음 처리되어 푸시 안 된 채 PR 생성 시도 — 에러 전파 + "up-to-date" 판별 추가
- PR 생성 에러 메시지를 raw stderr 대신 상황별 한국어 안내로 개선 (이미 PR 존재, base 미발견 등)
- `.clang-format` 파일이 사용자 수정 시 익스텐션 기준 컨벤션과 달라지던 문제 — 매 활성화 시 강제 덮어쓰기로 변경

### Changed
- `.clang-format` 동기화 정책: "존재하면 건너뜀" → "매번 강제 덮어쓰기" (컨벤션 통일)

## [0.17.2] - 2025-05-05

### Fixed
- `.clang-format` 파일이 `.jungle-kit/styles/`에 생성되어 VS Code `formatOnSave`가 인식하지 못하던 치명적 버그 수정 — 워크스페이스 루트에 생성하도록 변경, 기존 레거시 파일 자동 마이그레이션
- 사이드바 트리 펼치기/접기 오류 수정 — 모든 TreeItem에 `id` 속성 추가, VS Code 내부 상태 관리에 위임
- **치명적**: `reviewInProgress` 플래그 조기 리턴 시 리셋 안됨 → 자동 리뷰 영구 차단 수정
- 다중 선택 드래그 정렬 `Infinity - Infinity = NaN` 비결정적 순서 수정
- 리뷰 자동 생성 루프 `Date.now()` ID 중복 → `generateId()` 교체
- `_scanTimer`/`EventEmitter` 익스텐션 비활성화 시 리소스 누수 수정
- `openAnnotationInEditor` root 불일치 수정
- PR 임시 파일 실패 시 미삭제 수정

### Changed
- `@review` 색상 골드(#FFD54F) → 주황(#FB8C00) 변경

## [0.17.1] - 2025-05-05

### Fixed
- 사이드바 트리 펼치기/접기 오류 수정 — 모든 TreeItem에 명시적 `id` 속성 추가하여 VS Code가 리프레시 후 expand/collapse 상태를 안정적으로 보존하도록 개선
- 커스텀 `_userExpandState`/`resolveExpandState` 상태 추적 제거 — VS Code 내부 상태 관리에 위임하여 `fire(undefined)`와 `onDidExpandElement` 간 레이스 컨디션 해소
- **치명적**: `reviewInProgress` 플래그가 조기 리턴 시 리셋되지 않아 이후 모든 자동 리뷰가 영구 차단되던 버그 수정 — 전체 로직을 `try/finally`로 래핑
- 다중 선택 드래그 정렬에서 `Infinity - Infinity = NaN`으로 비결정적 순서가 발생하던 버그 수정 — fallback 비교 함수 추가
- 리뷰 자동 생성 루프에서 `Date.now()` 기반 ID 중복 가능성 수정 — `generateId()` 사용으로 교체
- `_scanTimer`와 `_onDidChangeTreeData` EventEmitter가 익스텐션 비활성화 시 정리되지 않던 리소스 누수 수정
- `openAnnotationInEditor`에서 `workspaceFolders[0]` 대신 `config.getWorkspaceRoot()` 사용으로 일관성 확보
- PR 생성 실패 시 임시 파일(`pr-title-temp.txt`, `pr-body-temp.md`)이 삭제되지 않던 버그 수정 — `finally` 블록으로 이동

### Changed
- `@review` 색상을 골드(#FFD54F)에서 주황(#FB8C00)으로 변경 — 가독성 개선

## [0.17.0] - 2025-05-05

### Fixed
- `@region` 접기(folding) 시 닫는 마커(`@endregion`)가 표시되지 않던 버그 수정 — 정규식을 주석 패턴(`//`, `/* */`, `#`)에 앵커링
- 사이드바 "전체 태그 삭제"(`clearAllTags`) 실행 시 디바운스 스캔 타이머가 삭제를 되돌리던 버그 수정 — 파일 편집 전후 `_scanTimer` 취소
- 리뷰 어노테이션 삭제 시 사이드바 트리가 접히던 버그 수정 — `EventEmitter<TagTreeItem | undefined>` + `_userExpandState` 기반 expand/collapse 상태 보존
- 빈 내용(태그만 있고 텍스트 없음)의 `@tag` 등록·삭제·스캔 동작 보장
- `//`와 `/* */` 모든 주석 스타일에서 태그가 동일하게 동작하도록 수정
- breakpoint 코드 줄 감지에서 `*ptr` 패턴이 블록 주석 continuation으로 잘못 인식되던 버그 수정

### Changed
- 초기화 코드에서 미사용 `reviews/`, `knowledge/` 디렉터리 생성 제거
- README에서 `reviews/`, `knowledge/` 참조 삭제 및 "언제 어떤 태그를 쓰는가" 사용 시나리오 섹션 추가
- 자동 리뷰 생성 동시 실행 방지 — `reviewInProgress` 플래그 추가

## [0.16.0] - 2025-05-04

### Changed
- `addTagAtCursor` 및 `searchTags` 필터에서 `@endregion` 제거 — `SIDEBAR_TAG_TYPES` 사용
- `@endregion`을 사이드바에서 숨김 — `@region`만 표시
- `@region` 중첩 시 사이드바에서 트리 구조로 표시 (스택 기반 부모-자식 매칭)
- 자식이 있는 `@region` 아이템에도 편집/삭제 버튼 노출

### Removed
- `gitUtils.ts` 미사용 메서드 7개 제거
- `shadowDiff.ts` 미사용 `getBranchChanges()`, `getTeamMembers()` 제거
- `apiKeyManager.ts` 미사용 `hasKey()` 제거
- `tagSystem.ts` 미사용 `execSync` import 제거

### Fixed
- `deleteAnnotation` 연속 호출 시 디바운스 스캔의 줄 번호 밀림으로 삭제한 어노테이션이 되살아나던 레이스 컨디션 수정 — 타이머 취소 + 즉시 재스캔
- `scanDocument` content fallback 맵에서 동일 타입+내용 어노테이션의 displayLabel/sortOrder가 마지막 값으로 덮어써지던 버그 수정 — 배열 기반 분배로 교체
- 단축키 설정 WebView에서 `s.label`, `s.description`, `s.id`, `e.message`가 HTML 이스케이프 없이 innerHTML에 삽입되던 XSS 취약점 수정 — `esc()` 함수 적용
- `handleDrop` 다중 선택 드래그 시 `draggedAnns`가 배열 순서대로 삽입되어 사이드바 정렬과 다를 수 있던 버그 수정 — sortOrder 기준 정렬 후 삽입
- `prPanel` `handleAIGenerate`에서 `_currentDiff`가 빈 문자열일 때 `||`로 원래 diff에 fallback되던 버그 수정 — `??` (nullish coalescing)로 교체
- **치명적**: git clean filter awk 패턴에 줄 시작 앵커(`^`)가 없어 인라인 주석(`int x; // @todo`)이 코드와 함께 커밋에서 제거되던 버그 수정
- `addTag` 내용에 `*/`가 포함되면 C 주석이 조기 종료되던 버그 수정 — `*/` → `* /` 이스케이프
- `.gitattributes`에 `.h` 필터 줄 추가 시 이전 줄과 병합될 수 있던 버그 수정 — 개행 보장
- `buildRegionTree`에서 필터 적용 시 `@endregion`이 제외되어 트리 구조가 깨지던 버그 수정 — 전체 annotations에서 region/endregion 추출
- `environmentValidator.ts` OutputChannel 매 호출 생성 리소스 누수 수정 — 싱글턴 멤버 변수로 교체
- 블록 주석 파싱에서 `*` prefix 없는 연속 줄(들여쓰기만)을 인식하지 못해 `break` 되던 버그 수정 — `*/` 전까지 무조건 스캔
- 블록 주석 내부 줄이 재스캔되어 중복 어노테이션이 등록되던 버그 수정 — `i = blockEndLine` 점프 추가
- `syncBreakpoints`에서 실행 가능 줄이 없을 때 0번 줄에 중단점이 설정되던 버그 수정 — `bpLine = -1` 기본값 + skip 가드
- `applyKeybindings` needsComma 정규식이 `]`를 매칭하여 배열 끝 뒤에 불필요한 쉼표를 삽입하던 버그 수정
- `displayLabel`/`sortOrder`가 줄 이동 시 유실되던 버그 수정 — content 기반 fallback 맵 추가
- **치명적**: `.gitattributes`의 필터 이름(`junglekit-local`)과 git config의 필터 이름(`jungle-local`)이 불일치하여 clean filter가 동작하지 않던 버그 수정 — 이전 이름 자동 마이그레이션 추가
- git filter 스크립트 경로에 공백이 포함될 때 shell 인자 분리로 필터가 실패하던 버그 수정 — 경로를 따옴표로 감쌈
- `syncWatchExpressions`에서 실패한 조사식도 영구 등록되어 재시도가 안 되던 버그 수정 — 성공 항목만 기록
- `git log` 포맷 구분자 `|`가 커밋 메시지에 포함되면 파싱이 깨지던 버그 수정 — NULL 바이트 구분자로 교체
- `clang-format` 스타일 경로에 공백 포함 시 실패하던 버그 수정 — 따옴표 추가
- `getDiffAgainst`, `getChangedFiles`, `getAheadBehind`에서 detached HEAD 방어 추가
- `smartCommit.ts` Git 확장 미활성화 상태에서 `exports.getAPI` TypeError 수정 — `isActive` 체크 추가
- `shadowDiff.ts` OutputChannel 매 호출 생성 리소스 누수 수정
- `prPanel.ts` detached HEAD 상태 빈 브랜치 `git push` 위험 수정
- `smartCommit.ts` SCM 설정 실패 시 무음 종료 수정 — 클립보드 폴백
- `environmentValidator.ts` 전체 통과 시 피드백 누락 수정
- `tagSystem.ts` `setupAnnotationFilter` `execSync` 블로킹을 `execAsync`로 교체

### Refactored
- `extension.ts` contextValue ID 추출 정규식 중복을 `extractTagId()` 헬퍼로 통합
- `parseDiffAdditions` hunk 이중 파싱 수정 — 내부 루프 종료 후 외부 루프 인덱스를 점프
- `parseDiffAdditions` `\ No newline at end of file` 줄이 context로 취급되어 줄 번호가 +1 되던 버그 수정
- `handleDrop` 다중 선택 드래그 시 `targetIdx=-1`로 잘못된 위치에 삽입되던 버그 수정
- `undoLastCommit` git reset 실패 시 거짓 성공 메시지를 표시하던 버그 수정 — 에러 메시지 표시로 교체

## [0.15.2] - 2025-05-04

### Fixed
- 멀티라인 블록 주석의 gutter 아이콘이 모든 줄에 반복 표시되던 문제 수정 — 첫 줄에만 아이콘, 나머지는 배경 하이라이트만 적용
- 어노테이션 태그가 포함된 줄이 clang-format 스타일 검사에서 오류로 표시되던 문제 수정 — 블록 주석 전체 범위를 자동 제외

### Removed
- 미사용 `localComments.prefix` 설정 제거
- 미사용 `DIFF_FILE_RE`, `loadConvention()` dead code 제거

### Changed
- README.md 전면 재작성 — 모든 기능의 상세 사용법과 동작 기준을 문서화

## [0.15.1] - 2025-05-03

### Fixed
- 멀티라인 블록 주석의 에디터 데코레이션이 전체 범위를 표시하도록 수정

## [0.15.0] - 2025-05-03

### Changed
- `@warn` 기능을 런타임 에러 기록 전용으로 전환 — 진단 기반 auto-warn 제거
- `@warn` 라벨을 '경고'에서 '런타임 에러'로 변경

### Removed
- `registerAutoWarn()`, `syncVirtualWarns()` 및 관련 디바운스 로직 제거

## [0.14.0] - 2025-05-03

### Fixed
- git clean filter가 멀티라인 블록 주석(`/* @tag ... */`)의 첫 줄만 제거하던 치명적 버그 수정 — sed에서 awk 상태 머신으로 교체하여 블록 전체 제거

## [0.13.0] - 2025-05-02

### Fixed
- 단축키 설정 화면 렌더링 오류 수정
- openai 모듈 동적 import 에러 핸들링 강화
- shell injection 방어 누락 — `sanitizeRef()` 일괄 적용

### Changed
- 하드코딩 상수를 중앙 설정 상수로 이동
- PR base 브랜치를 동적 선택 방식으로 변경
- XSS 방지를 위한 HTML escape 적용

## [0.12.0] - 2025-05-01

### Added
- 단축키 설정 WebView UI (디버그, 네비게이션, 접기/펼치기 등)
- `Alt+[` / `Alt+]` 태그 네비게이션 (파일 내 + 전체 워크스페이스)
- 워크스페이스 전체 `@breakpoint` 스캔 기능

## [0.10.2] - 2025-04-30

### Fixed
- 미사용 `_warnedDiagKeys` 필드 제거
- `@warn` / `@review` 자동 기능을 가상(virtual) 표시 방식으로 전환 — 파일에 주석을 쓰지 않음

### Added
- Watch 패널 조사식 자동 등록 (`debug.addToWatchExpressions` 내부 커맨드 사용)
- `@warn` 무한 루프 방지

## [0.1.0] - 2025-04-28

### Added
- 초기 릴리스
- 7종 어노테이션 태그 (`@bookmark`, `@todo`, `@review`, `@warn`, `@breakpoint`, `@region`, `@endregion`) + `@note`
- git clean filter를 통한 diff 자동 제외
- gutter 아이콘 + 배경 하이라이트 데코레이션
- 사이드바 Annotation Explorer (유형별/파일별 보기, 검색, 드래그 정렬)
- AI 커밋 메시지 생성 (OpenAI)
- Shadow Diff (원격 변경사항 시각화)
- PR 생성 패널 (GitHub CLI 연동)
- 코딩 스타일 검사 (clang-format)
- 환경 검증
- `@region`/`@endregion` 코드 접기
- API 키 보안 저장 (SecretStorage)
