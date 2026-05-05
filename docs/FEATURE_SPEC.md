# Annotation Extension — 기능 상세 기획서

> **버전**: v1.3 (2026-05-05)
> **작성**: 기능 전수 감사 + 사용자 피드백 반영
> **목적**: 모든 기능의 정상 동작 기준 정의 → 하네스 검증 기준으로 사용

---

## 1. 태그 시스템 (tagSystem.ts)

### 1.1 태그 종류

| 태그 | 색상 | 사이드바 표시 | 자동완성 | git diff 제외 | 비고 |
|------|------|:---:|:---:|:---:|------|
| @todo | #66BB6A (녹색) | O | O | O | 구현 예정 항목 |
| @bookmark | #4FC3F7 (파랑) | O | O | O | 핵심 로직 위치 표시 |
| @review | #FB8C00 (주황) | O | O | O | 코드 리뷰 포인트 |
| @warn | #EF5350 (빨강) | O | O | O | 런타임 에러 기록 |
| @breakpoint | #FF7043 (주황빨강) | O | O | O | 디버그 중단점 + 조사식 |
| @note | 없음 | X | **O** | O | 개인 메모 (사이드바 미표시) |
| @region | #B39DDB (보라) | O (폴딩 그룹) | O | O | 코드 접기 시작 |
| @endregion | #B39DDB (보라) | X | O | O | 코드 접기 끝 |

**변경사항 C2**: @note를 자동완성 목록에 추가. `ALL_TAG_TYPES`에 'note' 포함 필수.

### 1.2 태그 추가

**정상 동작:**
1. 사용자가 커맨드 실행 (우클릭 메뉴 / 커맨드 팔레트 / 사이드바 + 버튼)
2. 입력창이 뜸: "{태그 이름} 내용을 입력하세요 (빈칸 가능)"
3. 입력 후 Enter → 현재 줄 위에 주석 삽입
4. JSON 파일 (`.annotation/annotations.json`)에 기록
5. 사이드바 즉시 갱신
6. gutter 아이콘 + 배경 하이라이트 표시
7. ESC → 취소 (아무 동작 안 함)
8. 빈 문자열 → 내용 없는 태그 생성 허용

**주석 형식:**
- 단일행: `// @todo 내용`
- 블록(단일행): `/* @bookmark 내용 */`
- 블록(멀티라인): `/* @review\n   내용\n*/`

**엣지 케이스:**
- 에디터가 열려있지 않은 상태에서 실행 → "활성 에디터가 없습니다" 경고
- 읽기 전용 파일 → VS Code가 자체적으로 쓰기 거부
- C/C++ 외 파일 (*.c, *.h 아닌 파일) → "C/C++ 파일에서만 사용 가능합니다" 안내 후 중단

### 1.3 태그 삭제

**사이드바에서 삭제 (resolveTagInline):**
1. 사이드바 아이템의 X(닫기) 버튼 클릭
2. 해당 파일을 열고 주석 줄 삭제
3. JSON에서 해당 ID 제거
4. 사이드바 갱신

**에디터에서 삭제 (deleteAnnotationAtCursor):**
1. 현재 커서가 있는 줄이 태그 주석인지 확인
2. 맞으면 해당 줄 삭제 + JSON 반영
3. 아니면 "현재 줄에 태그가 없습니다" 알림

**파일 전체 삭제 (clearFileTags):**
- 특정 파일의 모든 태그를 JSON에서 제거하고 파일의 주석도 삭제

**전체 삭제 (clearAllTags):**
- 확인 다이얼로그 필수
- 모든 파일의 모든 태그 주석 삭제 + JSON 초기화

### 1.4 태그 수정 (editTag)

1. 사이드바에서 연필 아이콘 클릭
2. 현재 내용이 채워진 입력창 표시
3. 수정 후 Enter → 파일의 주석 텍스트 업데이트 + JSON 갱신
4. ESC → 취소

### 1.5 태그 네비게이션

**파일 내 (nextTag / prevTag):**
- `Alt+]` → 현재 커서 아래의 다음 태그로 이동
- `Alt+[` → 현재 커서 위의 이전 태그로 이동
- 파일 끝/처음 도달 시 순환(wrap-around)
- 태그가 0개면 아무 동작 안 함

**전체 (nextTagGlobal / prevTagGlobal):**
- 사이드바 포커스 상태에서 `Alt+]`/`Alt+[`
- 파일 경계를 넘어 전체 워크스페이스의 다음/이전 태그로 이동
- 파일 자동 열기 + 커서 이동

### 1.6 태그 검색 (searchTags)

1. QuickPick 표시: "전체 보기" + 태그 타입별 필터 + "텍스트 검색"
2. 타입 선택 → 해당 타입의 태그만 목록으로 표시
3. 텍스트 검색 → 입력한 키워드가 포함된 태그 목록 표시
4. 선택 시 해당 파일:줄로 이동

### 1.7 보기 전환 (toggleTagView)

- 파일별 그룹핑 ↔ 태그 타입별 그룹핑 토글
- 현재 상태를 시각적으로 구분 가능해야 함

### 1.8 모두 접기/열기 (collapseTags) — 변경사항 C1

**변경 (단순 2-state 토글):**
- 내부 `_allCollapsed: boolean` 플래그로 상태 관리
- 실행 시: collapsed 상태 → 모두 열기 (expand all), expanded 상태 → 모두 접기 (collapse all)
- 이벤트 리스너로 개별 노드를 추적하지 않고, 커맨드 실행 시마다 플래그 반전
- 아이콘도 상태에 따라 변경 (접기: `$(collapse-all)`, 열기: `$(expand-all)`)

### 1.9 새로고침 (refreshTags) — 변경사항 C8

**변경:**
- 워크스페이스 전체 재스캔: `*.c`, `*.h` 파일
- 파일에 존재하는 태그 주석과 JSON 동기화
- 삭제된 파일의 태그 자동 제거
- **스캔 파일 수 제한 없음** (이전: 500개 제한)
- build/ 디렉토리 제외

**변경 내역:**
- `MAX_WORKSPACE_SCAN_FILES` 상수 제거
- `WORKSPACE_SCAN_GLOB`은 `'**/*.{c,h}'` 유지 (변경 없음)

### 1.10 태그로 이동 (goToTag)

- 사이드바 아이템 클릭 시 해당 파일 열기 + 커서 위치 + 화면 중앙 스크롤
- 파일이 삭제된 경우 "태그가 가리키는 파일을 열 수 없습니다" 경고

### 1.11 드래그 앤 드롭 정렬

- 사이드바에서 태그 아이템을 드래그하여 순서 변경
- 변경된 순서는 `sortOrder` 필드에 저장
- JSON에 즉시 반영

### 1.12 자동완성 (CompletionProvider) — 변경사항 C2

**정상 동작:**
1. C/C++ 파일에서 `// @` 또는 `/* @` 입력
2. 자동완성 팝업: @todo, @bookmark, @review, @warn, @breakpoint, **@note**, @region, @endregion
3. 선택 시 태그 이름 + 공백 삽입

**변경**: `ALL_TAG_TYPES`에 'note' 추가. `AnnotationType` 유니온에도 'note' 추가 필요. `TAG_LABELS`에 `note: '메모'` 추가.

### 1.13 리뷰 확인 (checkReviews)

**정상 동작:**
1. 워크스페이스의 @review 태그를 수집
2. API 키 확인 (없으면 등록 유도)
3. OpenAI API로 코드 컨텍스트와 함께 리뷰 분석 요청
4. 결과를 Output Channel에 표시

### 1.14 @region/@endregion 접기

- `// @region 이름` ~ `// @endregion` 사이를 VS Code 접기 영역으로 인식
- 중첩 가능 (스택 기반 매칭)
- C, C++, TypeScript, JavaScript, Python, Java 지원
- `/* @region */` 형태도 인식
- **참고:** 접기 기능은 모든 지원 언어에서 동작하지만, 태그 관리(사이드바/JSON/gutter)는 *.c, *.h 파일에만 적용된다

### 1.15 브레이크포인트 동기화

- `@breakpoint` 태그가 있는 줄에 VS Code 디버그 중단점 자동 등록
- 태그 삭제 시 중단점도 제거

---

## 2. git clean filter

### 2.1 필터 스크립트 (clean-local.js)

**정상 동작:**
익스텐션 활성화 시 다음 3단계를 순서대로 실행:
1. `.annotation/scripts/clean-local.js` 생성 (또는 갱신)
2. `git config filter.annotation-local.clean 'node .annotation/scripts/clean-local.js'` 실행
3. `.gitattributes` 파일 갱신 (`*.c filter=annotation-local`, `*.h filter=annotation-local`)

- Node.js 기반 (크로스 플랫폼: macOS, Windows, Linux)
- stdin으로 파일 내용을 받아 태그 주석만 제거하고 stdout으로 출력

**제거 대상 (8종 + region 2종 = 10종):**
1. `// @todo 내용` → 줄 전체 제거
2. `// @bookmark 내용` → 줄 전체 제거
3. `// @review 내용` → 줄 전체 제거
4. `// @warn 내용` → 줄 전체 제거
5. `// @breakpoint 내용` → 줄 전체 제거
6. `// @note 내용` → 줄 전체 제거
7. `// @region 내용` → 줄 전체 제거
8. `// @endregion` → 줄 전체 제거
9. `/* @tag 내용 */` → 줄 전체 제거 (단일행 블록)
10. `/* @tag\n...\n*/` → 시작~끝 줄 전부 제거 (멀티라인 블록)

**보존 대상:**
- 태그가 아닌 모든 코드 줄
- `#include`, 함수 정의, 일반 주석 등

**검증 기준:**
```
입력:
#include <stdio.h>
// @todo 이것은 테스트
/* @bookmark 블록 */
/* @review
   멀티라인
*/
// @note 개인 메모
int main() { return 0; }

출력:
#include <stdio.h>
int main() { return 0; }
```

### 2.2 .gitattributes 설정

- `*.c filter=annotation-local`
- `*.h filter=annotation-local`
- 중복/레거시 엔트리 자동 정리 (`junglekit-local`, `jungle-local` 등)
- **주의: .gitattributes는 .gitignore에 등록하지 않음** (변경사항 C11)

### 2.3 레거시 정리

- 이전 bash 스크립트 (`clean-local.sh`, `smudge-local.sh`) 자동 삭제
- 이전 필터명 (`junglekit-local`, `jungle-local`) git config에서 자동 제거
- 이전 폴더명 `.jungle-kit/` → `.annotation/` 마이그레이션 (변경사항 C10)

---

## 3. 단축키 설정 (configureShortcuts) — 변경사항 C9

### 3.1 WebView 패널

**정상 동작:**
1. 커맨드 실행 → WebView 패널 열림
2. 기본 단축키 목록 표시 (사용자에게 유용한 모든 커맨드):

**기본 단축키 전체 목록:**

| 그룹 | ID | 이름 | 커맨드 | 기본 키 |
|------|-----|------|--------|---------|
| 네비게이션 | annotation.prevTag | 이전 태그로 이동 | jungleKit.prevTag | alt+[ |
| 네비게이션 | annotation.nextTag | 다음 태그로 이동 | jungleKit.nextTag | alt+] |
| 태그 관리 | annotation.deleteTag | 현재 줄 태그 삭제 | jungleKit.deleteAnnotationAtCursor | (미지정) |
| 태그 관리 | annotation.addTag | 태그 추가 | jungleKit.addTagAtCursor | (미지정) |
| 태그 관리 | annotation.searchTags | 태그 검색 | jungleKit.searchTags | (미지정) |
| 태그 관리 | annotation.refreshTags | 태그 새로고침 | jungleKit.refreshTags | (미지정) |
| 태그 추가 | annotation.addTodo | TODO 추가 | jungleKit.addTodo | (미지정) |
| 태그 추가 | annotation.addBookmark | 북마크 추가 | jungleKit.addBookmark | (미지정) |
| 태그 추가 | annotation.addReview | 리뷰 추가 | jungleKit.addReviewPoint | (미지정) |
| 태그 추가 | annotation.addWarn | 경고 추가 | jungleKit.addWarning | (미지정) |
| 태그 추가 | annotation.addBreakpoint | 브레이크포인트 추가 | jungleKit.addBreakpoint | (미지정) |
| Git | annotation.commitMessage | 커밋 메시지 생성 | jungleKit.generateCommitMessage | (미지정) |
| Git | annotation.createPR | PR 만들기 | jungleKit.createPR | (미지정) |
| Git | annotation.pullAndPush | Pull & Push | jungleKit.pullAndPush | (미지정) |
| Git | annotation.undoCommit | 마지막 커밋 되돌리기 | jungleKit.undoLastCommit | (미지정) |

3. 연필 아이콘 → 인라인 수정 모드
4. 키 입력 후 확인/취소
5. "적용" 버튼 → VS Code keybindings.json에 반영
6. "초기화" 버튼 → 기본값 복원

**검증 기준:**
- 패널을 열었을 때 15개 이상 항목이 보여야 함
- 빈 페이지 = 버그
- 이미 열린 패널이 있으면 HTML 갱신 후 reveal

### 3.2 키바인딩 저장

- `.annotation/keybindings.json`에 커스텀 키 저장
- VS Code 전역 `keybindings.json`에 실제 반영
- 백업 → 원자적 쓰기

---

## 4. Shadow Diff (shadowDiff.ts)

### 4.1 백그라운드 fetch

- `jungleKit.sync.intervalMinutes` 설정값 (기본 5분) 마다 `git fetch --all --prune`
- 중복 실행 방지 (`_isFetching` 뮤텍스)
- 익스텐션 dispose 시 interval 정리

### 4.2 원격 브랜치 분석

- 현재 브랜치를 제외한 모든 origin/ 브랜치와 diff 비교
- *.c, *.h 파일만 대상
- 파일별 hunk 파싱 (시작줄, 끝줄, diff 내용)
- 각 브랜치의 작성자, 마지막 커밋 시간 수집

**보안 수정사항 C6**: `execAsync` → `execFile` 인자 배열로 전환 필수

### 4.3 에디터 데코레이션 — 변경 (변경사항 C12)

**변경:** 좌측 보더(세로선) → 미세 배경색으로 교체
- `conflictDecoration`, `modifiedDecoration`의 `borderLeft` 스타일 삭제
- 대신 hunk 범위 전체에 미세한 배경색 적용 (예: `rgba(255, 165, 0, 0.06)`)
- `updateEditorDecorations` 메서드는 배경색 적용 로직으로 유지
- `getLocalModifiedLines` 메서드 삭제 (원격 diff 기반만 사용)
- `createDecorations` 메서드를 배경색 전용으로 재작성

### 4.4 CodeLens (유지)

- 충돌 가능 영역 위에 `"작성자 (브랜치) — 시간"` 인라인 표시
- 클릭 시 Output Channel에 diff 상세 표시

### 4.5 Hover 프로바이더 (유지)

- hunk 범위 내 줄에 마우스 올리면 diff 미리보기
- Markdown 형식 (작성자, 브랜치, diff 코드블록)

### 4.6 Pull & Push

**정상 동작:**
1. 현재 브랜치의 origin 대비 behind/ahead 확인
2. behind > 0 → `git pull --rebase` (진행 표시)
3. ahead > 0 → `git push origin {branch}` (진행 표시)
4. rebase 충돌 시 명확한 안내 메시지

**엣지 케이스:**
- detached HEAD → "동기화할 수 없습니다" 경고
- 워크스페이스 없음 → 에러 메시지
- 네트워크 실패 → 에러 메시지

---

## 5. AI 기능

### 5.1 공통: API 키 관리 — 변경사항 C3

**변경 (환경변수 지원 추가):**

현재: API 키가 없으면 "키를 등록하세요" 팝업 → 사용 불가
변경: 환경변수도 확인하도록 개선. 키가 없으면 현행대로 등록 유도.

**우선순위:**
1. 사용자 등록 키 (SecretStorage)
2. 환경변수 `OPENAI_API_KEY`
3. 없으면 → "API Key를 등록하세요" 팝업 (현행 유지)

**검증:**
- 키가 없는 상태에서 AI 기능 실행 → 등록 유도 팝업 표시
- 환경변수 `OPENAI_API_KEY`가 설정되어 있으면 등록 없이 동작
- 사용자 키가 환경변수보다 우선
- 키 등록/삭제 UI는 현행 유지

### 5.2 AI 커밋 메시지 (generateCommitMessage)

**정상 동작:**
1. staged 변경사항이 있는지 확인 (없으면 경고)
2. diff를 `AI_DIFF_TRUNCATE_LIMIT` 문자(character)로 절삭
3. `resources/conventions/commit-convention.md`를 시스템 프롬프트로 사용
4. OpenAI API 호출 (설정된 모델: gpt-4o / gpt-4o-mini)
5. 응답에서 코드블록 추출 (있으면)
6. VS Code SCM 입력창에 결과 설정

**엣지 케이스:**
- Git 확장이 없는 경우 → 클립보드에 복사
- Git 리포지토리가 없는 경우 → 클립보드에 복사

### 5.3 PR 생성 패널 (createPR) — 변경사항 C13

**정상 동작:**
1. WebView 패널 열림
2. **기존 오픈 PR 확인** — `gh pr view` 실행하여 현재 브랜치에 열린 PR 존재 여부 확인
   - 열린 PR이 있으면 → PR 정보(제목, URL, 상태)를 패널에 표시 + "이미 열린 PR이 있습니다" 안내 + 수정 모드로 전환
   - 없으면 → 새 PR 생성 모드
3. base 브랜치 선택 (드롭다운)
4. 변경 파일 목록 + diff 표시
5. AI로 제목/본문 자동 생성
6. "PR 만들기" / "PR 수정" → `gh pr create` 또는 `gh pr edit` 실행
7. 성공 시 PR URL 표시

**각 단계별 진행 메시지 표시:**
- "기존 PR 확인 중..."
- "변경 파일 분석 중..."
- "AI로 PR 내용 생성 중..."
- "커밋 푸시 중..."
- "PR 생성 중..." / "PR 수정 중..."
- 각 메시지가 UI에 표시되어야 멈춤/오작동 판별 가능

**엣지 케이스:**
- `gh` CLI 미설치 → 안내 메시지
- base 변경 시 → diff 재계산 (disposed 가드 포함)
- 패널 닫힘 후 비동기 완료 → 안전하게 무시

### 5.4 AI 리뷰 (checkReviews)

**정상 동작:**
1. @review 태그들을 수집
2. 각 태그의 전후 컨텍스트 (10줄) 추출
3. OpenAI API로 코드 리뷰 요청
4. 결과를 표시

---

## 6. 코딩 스타일 (styleEnforcer.ts)

### 6.1 .clang-format 관리 — 변경사항 C4

**변경 (무조건 덮어쓰기):**
- 익스텐션 활성화 시 항상 PintOS 스타일로 덮어쓰기
- `existsSync` 가드 제거
- 이유: 일관된 코딩 스타일 보장

### 6.2 formatOnSave 자동 활성화 — 변경사항 C5

**변경 (무조건 설정):**
- 항상 `editor.formatOnSave: true`로 설정
- 기존 값 확인 없이 무조건 덮어쓰기
- 적용 대상: `[c]`, `[cpp]` 언어 override sections

### 6.3 스타일 검사 (styleCheck)

**정상 동작:**
1. 현재 활성 파일에 대해 `clang-format --dry-run --Werror` 실행
2. 번들된 clang-format 바이너리 우선 사용 → 없으면 시스템 PATH
3. 위반 사항을 Diagnostics Collection에 표시
4. 태그 주석이 있는 줄은 스타일 검사에서 제외

**검증:** clang-format 바이너리가 없어도 크래시하지 않아야 함 (ENOENT 처리)

### 6.4 자동 저장 활성화

- `files.autoSave`가 'off'이면 'afterDelay'로 변경
- Workspace 레벨 설정

---

## 7. 환경 검증 (environmentValidator.ts)

### 7.1 검증 항목

| 도구 | 확인 명령 | 설치 안내 |
|------|----------|----------|
| gcc | `gcc --version` | `sudo apt install gcc` |
| qemu | `qemu-system-x86_64 --version` | `sudo apt install qemu-system-x86` |
| gdb | `gdb --version` | `sudo apt install gdb` |
| make | `make --version` | `sudo apt install build-essential` |
| clang-format | `clang-format --version` | `sudo apt install clang-format` |
| C/C++ 확장 | vscode.extensions.getExtension | `code --install-extension` |

### 7.2 동작

- 시작 시 자동 실행 (`showOnStartup: true`)
- 전부 통과 → 정보 메시지
- 실패 항목 있음 → Output Channel에 상세 결과 + Fix 명령어 표시

---

## 8. 프로젝트 초기화 (init) — 변경사항 C10

**변경: 폴더명 `.jungle-kit/` → `.annotation/`**

**정상 동작:**
1. `.annotation/` 디렉토리 생성
2. `.annotation/config.json` 생성 (기본 설정)
3. `.annotation/notes/` 디렉토리 생성
4. `.gitignore`에 `.annotation/` 추가 (`.gitattributes`는 등록하지 않음)

**마이그레이션 (익스텐션 활성화 시 자동 실행):**
- 익스텐션 활성화 시 `.jungle-kit/` 폴더 존재 여부를 자동 체크
- 존재하면 사용자 확인 없이 자동 이동:
  1. `annotations.json`, `keybindings.json`, `config.json`, `scripts/`, `notes/` 전부 이동
  2. 이전 폴더 `.jungle-kit/` 삭제
  3. `.gitignore`에서 `.jungle-kit/` 엔트리 제거, `.annotation/` 추가

**필터명 마이그레이션 순서:**
1. git config에 `annotation-local` 필터 등록
2. .gitattributes 내 `jungle-local`을 `annotation-local`로 교체
3. git config에서 `jungle-local` 필터 제거

---

## 9. Git 유틸리티

### 9.1 마지막 커밋 되돌리기 (undoLastCommit)

**정상 동작:**
1. 확인 다이얼로그: "마지막 커밋을 취소하고 변경사항을 staged로 되돌리겠습니까?"
2. "취소 (soft reset)" 선택 → `git reset --soft HEAD~1`
3. "아니오" → 아무 동작 안 함
4. 성공 → "마지막 커밋이 취소되었습니다" 메시지

---

## 10. 데이터 저장

### 10.1 annotations.json

- 위치: `.annotation/annotations.json`
- 원자적 쓰기: `.tmp` → `renameSync`
- 포맷: `{ version: number, annotations: Annotation[] }`

### 10.2 keybindings.json

- 위치: `.annotation/keybindings.json`
- 포맷: `{ version: number, shortcuts: ShortcutEntry[] }`

### 10.3 config.json

- 위치: `.annotation/config.json`
- initProject 시 생성

---

## 11. .gitignore 정책 — 변경사항 C11

**자동 등록 대상:**
- `.annotation/` → .gitignore에 자동 추가

**자동 등록하지 않는 대상:**
- `.gitattributes` → .gitignore에 등록하지 않음 (git이 추적해야 하는 파일)

---

## 12. 죽은 코드 정리 대상

| 항목 | 위치 | 조치 |
|------|------|------|
| `jungleKit.project` 설정 | package.json + configManager.ts | 제거 |
| `ConventionConfig` 필드들 | configManager.ts | config.json에서 제거 |
| `StyleConfig.clangFormatContent` | configManager.ts | 제거 |
| `EnvConfig.autoFix` | configManager.ts | 제거 |
| `setTreeView()` 빈 메서드 | tagSystem.ts | 제거 |
| `DiffFile.status` 항상 'M' | gitUtils.ts | 필드 제거 |
| 에디터 데코레이션 borderLeft | shadowDiff.ts | 배경색으로 교체 (C12) |
| `MAX_WORKSPACE_SCAN_FILES` 상수 | tagSystem.ts | 삭제 (C8) |

---

## 13. 보안 수정 대상

| 위치 | 현재 | 수정 |
|------|------|------|
| shadowDiff.ts:178 | `execAsync(\`git diff ...\`)` | `execFileAsync('git', ['diff', ...])` |
| shadowDiff.ts:186 | `execAsync(\`git log ...\`)` | `execFileAsync('git', ['log', ...])` |
| shadowDiff.ts:192 | `execAsync(\`git log ...\`)` | `execFileAsync('git', ['log', ...])` |
| shadowDiff.ts:108 | `execAsync('git pull --rebase')` | `execFileAsync('git', ['pull', '--rebase'])` |
| shadowDiff.ts:128 | `execAsync(\`git push ...\`)` | `execFileAsync('git', ['push', ...])` |

---

## 14. 이번 기획에서 변경되는 항목 요약

| # | 변경 | 영향 파일 | 상세 |
|---|------|----------|------|
| C1 | collapseTags 토글화 | extension.ts, tagSystem.ts | 접기/열기 상태 추적 + 토글 로직 |
| C2 | @note 자동완성 추가 | tagSystem.ts | `ALL_TAG_TYPES`·`AnnotationType`·`TAG_LABELS`에 'note' 추가 |
| C3 | AI 키 환경변수 지원 추가 | apiKeyManager.ts | SecretStorage → 환경변수 → 등록 유도 (내장 키 없음) |
| C4 | .clang-format 무조건 덮어쓰기 | styleEnforcer.ts | `existsSync` 가드 제거 |
| C5 | formatOnSave 무조건 설정 | styleEnforcer.ts | 조건문 제거, 항상 true 설정 |
| C6 | shadowDiff execFile 전환 | shadowDiff.ts | 5개소 execAsync → execFileAsync |
| C7 | 죽은 코드 정리 | 여러 파일 | 미사용 코드/설정 제거 |
| C8 | 스캔 파일수 제한 제거 | tagSystem.ts | `MAX_WORKSPACE_SCAN_FILES` 제거 (glob은 *.{c,h} 유지) |
| C9 | 단축키 전체 확장 (15개) | tagSystem.ts | `DEFAULT_SHORTCUTS` 3개 → 15개 |
| C10 | 폴더명 .jungle-kit → .annotation + 필터명 jungle-local → annotation-local | 전체 (tagSystem, configManager, package.json 등) | 모든 경로·필터명 참조 변경 + 마이그레이션 로직 |
| C11 | .gitattributes .gitignore 미등록 | tagSystem.ts | `entriesToAdd`에서 `.gitattributes` 제거 |
| C12 | 에디터 데코레이션 변경 (보더→배경색) | shadowDiff.ts | 좌측 보더 삭제, hunk 범위 미세 배경색으로 교체 |
| C13 | PR 기존 오픈 확인 + 진행 메시지 | prPanel.ts | 오픈 PR 감지 → 수정 모드, 각 단계 메시지 표시 |

---

## 15. 하네스 검증 체크리스트 (기획 승인 후 적용)

1. **컴파일 검증** — `npm run compile` 에러 0건
2. **git filter 실제 테스트** — 10종 태그 패턴 입력 → 필터 실행 → 태그 0건 + 코드 보존 확인
3. **보안 패턴 스캔** — shadowDiff.ts에 `execAsync` 미사용 확인
4. **자동완성 목록 검증** — `ALL_TAG_TYPES`에 'note' 포함 확인
5. **단축키 패널 검증** — `DEFAULT_SHORTCUTS` 배열이 15개 + WebView HTML에 render() 함수 존재
6. **API 키 환경변수 검증** — `process.env.OPENAI_API_KEY` 참조 로직 존재 확인
7. **.clang-format 덮어쓰기 검증** — 생성 전 `existsSync` 가드 없어야 함
8. **formatOnSave 강제 설정 검증** — 조건 없이 true 설정
9. **collapseTags 토글 검증** — collapseAll 단순 위임이 아닌 토글 로직 존재
10. **원자적 쓰기 검증** — saveAnnotations에 `.tmp` + `renameSync` 패턴
11. **PR execFile 검증** — `execFileAsync('gh', ...)` 형태
12. **PR 기존 오픈 확인 검증** — `gh pr view` 호출 로직 존재
13. **PR 진행 메시지 검증** — 진행 상태 메시지 문자열 존재 확인
14. **폴더명 검증** — 소스에 `.jungle-kit`을 주 경로로 사용하는 곳 0건 (마이그레이션 로직 내 참조는 허용, `.annotation` 사용)
15. **.gitattributes .gitignore 미등록 검증** — `entriesToAdd`에 `.gitattributes` 미포함
16. **에디터 데코레이션 변경 검증** — `borderLeft` 스타일 미존재 + `backgroundColor` 스타일 존재
17. **스캔 파일수 제한 검증** — `MAX_WORKSPACE_SCAN_FILES` 미존재
18. **스캔 glob 검증** — `WORKSPACE_SCAN_GLOB`이 `*.{c,h}`만 포함 (`.cpp` 미포함)
19. **죽은 코드 검증** — `jungleKit.project` 설정 미존재
20. **필터명 검증** — 소스에 `jungle-local`을 주 필터명으로 사용하는 곳 0건 (`annotation-local` 사용, 레거시 정리 로직 내 참조는 허용)
21. **git filter config 검증** — 소스에 `execFileAsync('git', ['config', ...)` 호출이 `annotation-local` 필터 등록에 사용됨
22. **핀토스 프로젝트 태그 잔류** — grep으로 @태그 0건 확인
