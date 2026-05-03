# Annotation

코드 주석 태그로 팀 협업하는 VS Code 익스텐션.

`@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint` 주석을 작성하면 사이드바에서 모아보고, gutter 아이콘 + 배경 하이라이트로 시각 표시합니다. 모든 태그 주석은 **git diff에 노출되지 않습니다** — git clean filter가 자동 적용되어 커밋 시 주석이 제거됩니다.

---

## 설치

### VS Code Marketplace

VS Code 확장 탭에서 `Annotation`을 검색하여 설치합니다.

### VSIX 수동 설치

```bash
code --install-extension jungle-dev-kit-<version>.vsix --force
```

### Docker / Dev Container 환경

```bash
# 호스트에서 컨테이너로 vsix 복사
docker cp jungle-dev-kit-<version>.vsix <container_id>:/tmp/

# 컨테이너 안에서 설치
code --install-extension /tmp/jungle-dev-kit-<version>.vsix --force
```

설치 후 `Cmd+Shift+P` → `Developer: Reload Window` 실행.

---

## 태그 종류

| 태그 | 색상 | 용도 | 사이드바 표시 |
|------|------|------|:---:|
| `@bookmark` | 파랑 `#4FC3F7` | 중요 코드 위치 표시 (핵심 로직, 진입점) | ✓ |
| `@todo` | 녹색 `#66BB6A` | 할 일 메모 (구현 예정 항목) | ✓ |
| `@review` | 골드 `#FFD54F` | 코드 리뷰 포인트 (커밋 단위 그룹핑) | ✓ |
| `@warn` | 빨강 `#EF5350` | 런타임 에러 기록 (위험 영역 표시) | ✓ |
| `@breakpoint` | 주황 `#FF7043` | 디버그 브레이크포인트 + 조사식 자동 등록 | ✓ |
| `@region` / `@endregion` | 보라 `#B39DDB` | 코드 접기 영역 정의 | ✓ |
| `@note` | — | 개인 메모 (사이드바 미표시, diff에서만 제외) | ✗ |

---

## 주석 작성 방법

### 한 줄 주석 (`//`)

```c
// @todo 페이지 테이블 초기화 로직 확인
void page_init (void) { ... }
```

### 한 줄 블록 주석 (`/* ... */`)

```c
/* @bookmark 스레드 생성 핵심 */
struct thread *thread_create (const char *name, ...) { ... }
```

### 여러 줄 블록 주석

```c
/* @review
 * 이 함수는 인터럽트 비활성화 상태에서 호출되어야 함.
 * 락 획득 순서: a_lock → b_lock
 */
```

여러 줄 블록 주석의 경우 gutter 아이콘은 첫 줄에만 표시되고, 나머지 줄에는 배경 하이라이트만 적용됩니다. 사이드바에는 모든 줄의 내용이 합쳐져서 표시됩니다.

### 자동완성

`//` 또는 `/*` 입력 후 `@`를 타이핑하면 태그 자동완성 목록이 나타납니다. C/C++ 파일에서 동작합니다.

---

## 태그 추가 방법

### 1. 직접 작성

코드에 주석을 작성하면 자동으로 인식됩니다. 파일 저장 또는 텍스트 변경 시 300ms debounce 후 스캔합니다.

### 2. 사이드바 `+` 버튼

사이드바 상단 `+` 버튼을 클릭하면 태그 유형 선택 → 내용 입력 → 현재 커서 위치에 `/* @tag 내용 */` 주석이 자동 삽입됩니다.

### 3. 우클릭 컨텍스트 메뉴

에디터에서 우클릭 → `Annotation` 서브메뉴에서 `@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint` 중 선택합니다.

### 4. 명령 팔레트

`Cmd+Shift+P` (Windows: `Ctrl+Shift+P`) → `TODO 추가`, `북마크 추가`, `리뷰 추가`, `경고 추가`, `브레이크포인트 추가`

---

## 사이드바 (Annotation Explorer)

사이드바 Activity Bar에 Annotation 아이콘이 추가됩니다. 워크스페이스 전체의 모든 태그를 모아봅니다.

### 보기 모드

- **유형별 그룹** (기본): `@bookmark`, `@todo`, `@review` 등 태그 유형별로 묶어서 표시
- **파일별 그룹**: 파일 단위로 묶어서 표시. 상단 목록 아이콘으로 전환

### 조작

- **클릭**: 해당 코드 위치로 이동 (파일이 열리지 않았으면 자동 오픈)
- **수정 버튼** (✏️): 사이드바 표시 제목을 수정합니다. 파일 내 주석 원문은 변경되지 않습니다
- **삭제 버튼** (✕): 파일 내 주석과 사이드바 항목을 함께 삭제합니다
- **새로고침** (↻): 워크스페이스 전체를 다시 스캔합니다
- **검색** (🔍): 태그 유형 필터 또는 텍스트 검색
- **모두 접기**: 트리 전체를 접습니다
- **모든 태그 삭제**: 워크스페이스 내 모든 어노테이션을 삭제합니다 (확인 팝업)
- **파일 태그 삭제**: 특정 파일의 모든 태그를 삭제합니다

### 드래그 & 드롭

같은 태그 유형 내에서 사이드바 항목을 드래그하여 순서를 변경할 수 있습니다. 변경된 순서는 `.jungle-kit/annotations.json`에 저장됩니다.

### 태그 네비게이션

- `Alt+]` — 다음 태그로 이동 (현재 파일 내)
- `Alt+[` — 이전 태그로 이동 (현재 파일 내)
- 사이드바 포커스 시 같은 단축키로 전체 워크스페이스 태그 순회

---

## Git Diff에서 자동 제외

익스텐션 활성화 시 다음이 자동 설정됩니다:

1. `.jungle-kit/scripts/clean-local.sh` — awk 기반 필터 스크립트 생성
2. `git config filter.jungle-local.clean` — 커밋 시 태그 주석 제거
3. `git config filter.jungle-local.smudge` — checkout 시 원본 유지 (`cat`)
4. `.gitattributes`에 `*.c filter=jungle-local`, `*.h filter=jungle-local` 추가

### 제거 규칙

필터는 다음 패턴을 모두 처리합니다:

- `// @tag ...` — 한 줄 주석 삭제
- `/* @tag ... */` — 한 줄 블록 주석 삭제
- `/* @tag ... ↵ * 내용 ↵ */` — 여러 줄 블록 주석 전체 삭제

대상 태그: `@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint`, `@note`, `@region`, `@endregion`

### 결과

- 로컬에서는 주석이 그대로 보입니다
- `git diff`에는 태그 주석이 나타나지 않습니다
- 팀원에게 push해도 태그 주석은 전달되지 않습니다
- `.gitattributes`와 `.jungle-kit/`는 `.gitignore`에 자동 등록됩니다

---

## @warn — 런타임 에러 기록

`@warn` 태그가 있는 줄 근처(±2줄)를 편집하면 콘솔에 경고 로그가 출력됩니다. 위험한 코드 영역에 표시해두면 실수를 방지할 수 있습니다.

```c
/* @warn 이 함수 수정 시 락 순서 주의 */
void critical_section (void) { ... }
```

`@warn`은 수동으로만 추가됩니다. 런타임에서 발생한 에러를 기록하는 용도로 사용하세요.

---

## @breakpoint — 디버그 브레이크포인트 + 조사식

`@breakpoint` 태그에 쉼표로 구분된 표현식을 작성하면:

1. **주석 다음 실행 가능 코드 줄**에 VS Code 브레이크포인트를 자동 설정
2. 디버그 세션 시작 시 표현식을 **Watch 패널에 자동 등록**
3. 디버그 세션 종료 시 자동 등록한 브레이크포인트를 **자동 제거**

```c
/* @breakpoint (void *) t→tf.R.rip, (void *) t→tf.R.rdi, (char *) t→tf.R.rsi */
process_create_initd (file_name);
```

위 예시에서는 `process_create_initd` 줄에 브레이크포인트가 걸리고, Watch 패널에 3개의 표현식이 등록됩니다.

### 동작 세부사항

- 브레이크포인트는 주석/빈 줄을 건너뛰고 실제 코드 줄에 설정됩니다 (최대 10줄 탐색)
- 파일 저장 시 브레이크포인트 위치가 자동 동기화됩니다
- Watch 표현식 중복 등록을 방지합니다 (`workspaceState` 기반)

---

## @region / @endregion — 코드 접기

```c
// @region 메모리 관리
void *malloc (size_t size) { ... }
void free (void *ptr) { ... }
// @endregion
```

`@region`과 `@endregion` 사이의 코드를 접을 수 있습니다. 중첩도 지원합니다. C, C++, TypeScript, JavaScript, Python, Java 파일에서 동작합니다.

---

## @review — 자동 리뷰 생성 (Phase 2)

### 자동 생성 (pull 시)

팀원이 push한 커밋을 pull 받으면, 새로 추가된 함수/변수를 자동으로 감지하여 `@review` 태그를 생성합니다.

- OpenAI API 키가 설정되어 있으면 AI가 한국어로 코드 설명 생성
- API 키가 없으면 Doxygen 스타일 시그니처 설명으로 대체
- **자기 커밋에는 리뷰를 생성하지 않음**
- 가상(virtual) 항목으로 사이드바에만 표시 (파일에 주석을 쓰지 않음)

### 수동 생성 (리뷰 확인)

사이드바 상단 체크리스트 아이콘을 클릭하면 최근 30개 커밋 중 하나를 선택하여 해당 커밋의 변경사항에 대한 리뷰 태그를 일괄 생성합니다.

### 사이드바 그룹핑

`@review` 태그는 커밋 해시별로 그룹핑됩니다:
- `uncommitted` — 수동으로 작성한 리뷰
- `abc1234 — 작성자 (3)` — 특정 커밋의 자동 리뷰

---

## AI 커밋 메시지 생성

소스 제어 패널 상단 또는 사이드바 메뉴에서 `커밋 메시지 생성`을 클릭하면:

1. staged diff를 분석하여 한국어 커밋 메시지를 생성합니다
2. `resources/conventions/commit-convention.md` 규칙에 따라 `<type>: <한국어 제목>` 형식으로 작성
3. 생성된 메시지가 SCM input box에 자동 설정됩니다

diff가 4,000바이트를 초과하면 자동으로 잘립니다.

---

## Shadow Diff — 팀원 변경사항 시각화

백그라운드에서 주기적으로 `git fetch`를 실행하여 원격 브랜치의 변경사항을 감시합니다.

### 시각 표시

- **파란색 gutter** (왼쪽 3px): 팀원이 수정한 영역
- **빨간색 gutter** (왼쪽 3px): 같은 줄을 로컬에서도 수정함 (충돌 가능)
- **CodeLens**: 충돌 가능 영역 위에 `작성자 (브랜치) — 시간` 표시
- **Hover**: 마우스를 올리면 팀원의 diff 미리보기

### Pull & Push

사이드바 메뉴에서 `Pull & Push`를 클릭하면 `git pull --rebase` → `git push`를 순차 실행합니다.

---

## PR 만들기

사이드바 메뉴에서 `PR 만들기`를 클릭하면 WebView 기반 PR 생성 패널이 열립니다.

### 기능

- 브랜치 선택: 현재 브랜치에서 base 브랜치로 PR 생성
- base 브랜치 변경 시 변경 파일 목록과 diff가 자동 갱신
- `AI 생성` 버튼: `resources/conventions/pr-convention.md` 규칙에 따라 제목과 본문을 AI가 작성
- 변경 파일, 커밋 로그, @review 포인트를 접이식 패널로 표시
- GitHub CLI (`gh`) 연동으로 원클릭 PR 생성

### 요구사항

- [GitHub CLI](https://cli.github.com) 설치 및 `gh auth login` 완료
- OpenAI API 키 (AI 생성 기능 사용 시)

---

## 코딩 스타일 검사

`.clang-format` 기반 스타일 검사를 자동으로 수행합니다.

### 동작

- 익스텐션 활성화 시 `.jungle-kit/styles/.clang-format` 파일 자동 생성 (PintOS GNU 스타일)
- C/C++ 파일 저장 시 `clang-format --dry-run --Werror`를 실행
- 스타일 위반이 있으면 Problems 패널에 `[Style]` 진단 표시
- **어노테이션 태그가 포함된 줄은 스타일 검사에서 자동 제외** (블록 주석 전체 범위 포함)
- `editor.formatOnSave`가 C/C++ 파일에 자동 활성화됩니다

### 수동 실행

`Cmd+Shift+P` → `코딩 스타일 검사`

---

## 환경 검증

익스텐션 시작 시 개발 환경을 자동으로 검증합니다.

| 검사 항목 | 기본 활성화 |
|-----------|:-----------:|
| gcc | ✓ |
| qemu-system-x86_64 | ✓ |
| gdb | ✓ |
| make | ✓ |
| clang-format | ✓ |
| C/C++ 확장 (ms-vscode.cpptools) | ✓ |

누락된 도구가 있으면 Output 채널에 `[FAIL]` 표시와 설치 명령을 안내합니다. `.jungle-kit/config.json`의 `env.checks`에서 개별 항목을 비활성화할 수 있습니다.

---

## 단축키 설정

사이드바 메뉴에서 `단축키 설정`을 클릭하면 WebView 기반 설정 패널이 열립니다.

### 기본 단축키

| 기능 | 기본 키 |
|------|---------|
| 디버그 시작 | `F5` |
| Step Over | `F6` |
| Step Into | `F7` |
| Continue | `F8` |
| 브레이크포인트 토글 | `F11` |
| 이전 에디터 탭 | `Cmd+[` |
| 다음 에디터 탭 | `Cmd+]` |
| 코드 접기 | `Cmd+Shift+[` |
| 코드 펼치기 | `Cmd+Shift+]` |
| 전체 선택 | `Alt+A` |
| 참조 찾기 | `Alt+F7` |
| 이전 태그 이동 | `Alt+[` |
| 다음 태그 이동 | `Alt+]` |

단축키를 수정한 후 `적용` 버튼을 누르면 VS Code `keybindings.json`에 자동 반영됩니다. `초기화` 버튼으로 기본값 복원이 가능합니다.

---

## API 키 관리

OpenAI API 키는 VS Code SecretStorage를 통해 OS 키체인(macOS Keychain, Windows Credential Manager, Linux libsecret)에 안전하게 저장됩니다. 평문으로 디스크에 기록되지 않습니다.

- **등록**: `Cmd+Shift+P` → `OpenAI API 키 등록`
- **삭제**: `Cmd+Shift+P` → `OpenAI API 키 삭제`
- AI 기능 호출 시 키가 없으면 등록 안내 팝업이 자동으로 표시됩니다

---

## 프로젝트 초기화

`Cmd+Shift+P` → `프로젝트 초기화`를 실행하면:

- `.jungle-kit/` 디렉토리 생성
- `.jungle-kit/config.json` — 프로젝트 설정 (커밋 컨벤션, 환경 검증 설정 등)
- `.jungle-kit/reviews/`, `.jungle-kit/knowledge/`, `.jungle-kit/notes/` 서브 디렉토리 생성
- `.jungle-kit/.gitignore`에 `annotations.json`, `keybindings.json`, `notes/` 추가

---

## 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `jungleKit.project` | `pintos` | 대상 OS 프로젝트 타입 (`pintos` / `xv6` / `custom`) |
| `jungleKit.ai.model` | `gpt-4o-mini` | AI 기능에 사용할 OpenAI 모델 (`gpt-4o` / `gpt-4o-mini`) |
| `jungleKit.sync.intervalMinutes` | `5` | Shadow Diff 백그라운드 fetch 주기 (분) |
| `jungleKit.style.autoCreateClangFormat` | `true` | `.clang-format` 파일 자동 생성 여부 |

---

## 활성화 조건

다음 중 하나라도 충족되면 익스텐션이 자동 활성화됩니다:

- 워크스페이스에 `Makefile.build` 파일이 존재
- 워크스페이스에 `Makefile` 파일이 존재
- 워크스페이스에 `.c` 파일이 존재
- 워크스페이스에 `.jungle-kit/config.json` 파일이 존재
- `프로젝트 초기화` 명령 실행

---

## 파일 구조

```
.jungle-kit/
├── annotations.json      # 어노테이션 메타데이터 (displayLabel, sortOrder 등)
├── keybindings.json       # 단축키 설정
├── config.json            # 프로젝트 설정
├── scripts/
│   ├── clean-local.sh     # git clean filter (awk 기반)
│   └── smudge-local.sh    # git smudge filter (cat)
├── styles/
│   └── .clang-format      # PintOS GNU 코딩 스타일
├── reviews/               # (예약)
├── knowledge/             # (예약)
└── notes/                 # 개인 메모 (gitignore 대상)
```

---

## 요구사항

- VS Code 1.85.0 이상
- Git이 설치되어 있어야 합니다
- C/C++ 파일이 있는 프로젝트에서 최적 동작
- AI 기능 사용 시 OpenAI API 키 필요
- PR 생성 시 [GitHub CLI](https://cli.github.com) 필요
- 스타일 검사 시 `clang-format` 필요

---

## 라이선스

MIT
