# Annotation

코드 주석 태그로 팀 협업하는 VS Code 익스텐션.

`// @todo`, `// @bookmark`, `// @review`, `// @warn`, `// @breakpoint` 주석을 작성하면 사이드바에서 모아보고, gutter 아이콘으로 시각 표시합니다. 모든 태그 주석은 **git diff에 노출되지 않습니다** (git clean filter 자동 적용).

---

## 설치

```bash
code --install-extension annotation-<version>.vsix --force
```

설치 후 `Cmd+Shift+P` → `Developer: Reload Window` 실행.

## 태그 종류

| 태그 | 색상 | 용도 | 예시 |
|------|------|------|------|
| `@bookmark` | 파랑 #4FC3F7 | 중요 코드 위치 표시 | `// @bookmark 핵심 스케줄링 로직` |
| `@todo` | 녹색 #66BB6A | 할 일 메모 | `// @todo 에러 처리 추가 필요` |
| `@review` | 골드 #FFD54F | 코드 리뷰 포인트 | `// @review 동기화 이슈 확인` |
| `@warn` | 빨강 #EF5350 | 위험/주의 경고 | `// @warn 이 함수 수정 시 락 순서 주의` |
| `@breakpoint` | 주황 #FF7043 | 디버그 브레이크포인트 + 조사식 | `// @breakpoint f->R.rax, f->R.rdi` |
| `@local` | — | 개인 메모 (사이드바 미표시) | `// @local 내일 확인할 것` |

## 사용법

### 주석으로 직접 작성

코드에 주석을 작성하면 자동으로 인식됩니다:

```c
// @todo 페이지 테이블 초기화 로직 확인
void page_init (void) {
    ...
}
```

```c
/* @bookmark 스레드 생성 핵심 */
struct thread *thread_create (const char *name, int priority, ...) {
    ...
}
```

여러 줄 블록 주석도 지원합니다:

```c
/* @review
 * 이 함수는 인터럽트 비활성화 상태에서 호출되어야 함.
 * 락 획득 순서: a_lock → b_lock
 */
```

### 사이드바에서 추가

1. 코드에서 원하는 줄에 커서를 놓습니다
2. 사이드바 상단 `+` 버튼 클릭 또는 `Cmd+Shift+P` → `Annotation: 태그 추가`
3. 태그 유형 선택 → 내용 입력
4. 해당 줄 위에 `// @tag 내용` 주석이 자동 삽입됩니다

### 우클릭 메뉴

에디터에서 우클릭 → `Annotation` 서브메뉴에서 태그 유형을 바로 선택할 수 있습니다.

### 자동완성

`//` 또는 `/*` 입력 후 `@`를 타이핑하면 태그 자동완성이 나타납니다.

## 사이드바 기능

사이드바 Annotation 패널에서 모든 태그를 모아볼 수 있습니다:

- **클릭**: 해당 코드 위치로 이동
- **수정 버튼** (✏️): 사이드바에 표시되는 제목을 수정 (파일 내 주석은 유지)
- **삭제 버튼** (✕): 주석과 함께 삭제
- **보기 전환** (목록 아이콘): 유형별 / 파일별 그룹핑 토글
- **검색** (🔍): 태그 유형 필터 또는 텍스트 검색
- **새로고침** (↻): 파일 재스캔

## Git Diff에서 제외

모든 태그 주석(`@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint`, `@local`)은 git commit 시 자동으로 제거됩니다.

익스텐션이 활성화되면 다음이 자동 설정됩니다:

1. `git config filter.jungle-local.clean` — 커밋 시 태그 주석 제거
2. `git config filter.jungle-local.smudge` — checkout 시 원본 유지
3. `.gitattributes`에 `*.c filter=jungle-local` 추가

이로 인해:
- 로컬에서는 주석이 보입니다
- `git diff`에는 태그 주석이 나타나지 않습니다
- 팀원에게 push되지 않습니다

`@local`은 추가로 사이드바에도 표시되지 않는 완전한 개인 메모입니다.

## @warn 경고 기능

`@warn` 태그가 있는 줄 근처(±2줄)를 편집하면 경고 알림이 표시됩니다. 위험한 코드 영역에 표시해두면 실수를 방지할 수 있습니다.

컴파일 에러가 발생하면 해당 줄 위에 `// @warn` 주석이 **자동 삽입**됩니다. 에러가 해결되면 자동으로 정리됩니다.

## @breakpoint 디버그 조사식

`@breakpoint` 태그에 쉼표로 구분된 표현식을 작성하면, 디버그 세션 시작 시 자동으로:

1. 다음 줄에 **브레이크포인트** 설정
2. 표현식을 **Watch 패널에 등록**

```c
// @breakpoint f->R.rax, f->R.rdi, (char *)f->R.rsi, f->R.rdx
printf ("system call!\n");
```

디버그가 시작되면 `printf` 줄에서 멈추고, Watch 패널에서 시스템 콜 번호(`rax`), 인자(`rdi`, `rsi`, `rdx`)를 바로 확인할 수 있습니다. 디버그 종료 시 자동 정리됩니다.

## Phase 2: 자동 리뷰 생성

팀원이 push한 커밋을 pull 받으면, 새로 추가된 함수/변수를 자동으로 감지하여 `@review` 태그를 생성합니다.

- OpenAI API 키가 설정되어 있으면 AI가 한국어로 코드 설명 생성
- API 키가 없으면 Doxygen 스타일 시그니처 설명으로 대체
- 자기 커밋에는 리뷰를 생성하지 않음
- 사이드바에서 커밋별로 그룹핑되어 표시

### API 키 설정

```
Cmd+Shift+P → Annotation: Set OpenAI API Key
```

## AI 커밋 메시지

소스 제어 패널에서 ✨ 버튼을 클릭하면 staged diff를 분석하여 한국어 커밋 메시지 3개를 제안합니다.

커밋 메시지 형식: `<type>: <한국어 제목>`

## 추가 기능

- **Shadow Diff**: 백그라운드 git fetch로 원격 변경사항 감시
- **PR 만들기**: AI 기반 PR 템플릿 생성 + `gh` CLI 연동
- **코딩 스타일 검사**: `.clang-format` 기반 스타일 체크

## 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `jungleKit.project` | `pintos` | 대상 OS 프로젝트 타입 |
| `jungleKit.ai.model` | `gpt-4o-mini` | OpenAI 모델 |
| `jungleKit.sync.intervalMinutes` | `5` | Shadow Diff fetch 주기 (분) |
| `jungleKit.localComments.prefix` | `@local` | 로컬 주석 접두사 |

## 요구사항

- VS Code 1.85.0 이상
- 프로젝트에 `.c` 또는 `.h` 파일이 있거나 `Makefile`이 있을 때 자동 활성화
- AI 기능 사용 시 OpenAI API 키 필요

## 라이선스

MIT
