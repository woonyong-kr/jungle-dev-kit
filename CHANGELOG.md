# Changelog

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
