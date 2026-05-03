# Changelog

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
