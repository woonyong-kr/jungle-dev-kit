# Annotation

코드 주석 태그 기반 팀 협업 도구 -- VS Code 익스텐션.

`@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint`, `@note`, `@region` / `@endregion` 주석 태그를 작성하면 사이드바에서 전체 워크스페이스의 태그를 모아보고, gutter 아이콘과 배경 하이라이트로 시각적으로 표시합니다. 모든 태그 주석은 git clean filter를 통해 커밋 시 자동 제거되므로 git diff에 노출되지 않습니다.

---

## 목차

1. [설치](#설치)
2. [빠른 시작](#빠른-시작)
3. [태그 종류와 색상](#태그-종류와-색상)
4. [주석 작성 방법](#주석-작성-방법)
5. [태그 추가 방법](#태그-추가-방법)
6. [사이드바 -- Annotation Explorer](#사이드바----annotation-explorer)
7. [태그 네비게이션](#태그-네비게이션)
8. [Git Diff 자동 제외](#git-diff-자동-제외)
9. [@breakpoint -- 디버그 브레이크포인트와 조사식](#breakpoint----디버그-브레이크포인트와-조사식)
10. [@region / @endregion -- 코드 접기](#region--endregion----코드-접기)
11. [@review -- 코드 리뷰 자동 생성](#review----코드-리뷰-자동-생성)
12. [@warn -- 런타임 에러 기록](#warn----런타임-에러-기록)
13. [AI 커밋 메시지 생성](#ai-커밋-메시지-생성)
14. [Shadow Diff -- 팀원 변경사항 시각화](#shadow-diff----팀원-변경사항-시각화)
15. [PR 만들기](#pr-만들기)
16. [코딩 스타일 검사](#코딩-스타일-검사)
17. [환경 검증](#환경-검증)
18. [단축키 설정](#단축키-설정)
19. [API 키 관리](#api-키-관리)
20. [프로젝트 초기화](#프로젝트-초기화)
22. [설정](#설정)
23. [활성화 조건](#활성화-조건)
24. [파일 구조](#파일-구조)
25. [요구사항](#요구사항)
26. [라이선스](#라이선스)

---

## 설치

### VS Code Marketplace

VS Code 확장 탭(Ctrl+Shift+X)에서 `Annotation`을 검색하여 설치합니다. Publisher는 `woonyong`입니다.

### VSIX 수동 설치

릴리스 페이지에서 `.vsix` 파일을 다운로드한 후:

```bash
code --install-extension jungle-dev-kit-<version>.vsix --force
```

### Docker / Dev Container 환경

호스트에서 컨테이너로 vsix 파일을 복사한 후 컨테이너 내부에서 설치합니다:

```bash
# 호스트에서 컨테이너로 복사
docker cp jungle-dev-kit-<version>.vsix <container_id>:/tmp/

# 컨테이너 내부에서 설치
code --install-extension /tmp/jungle-dev-kit-<version>.vsix --force
```

설치 후 반드시 `Cmd+Shift+P` (Windows/Linux: `Ctrl+Shift+P`) -> `Developer: Reload Window`를 실행하여 익스텐션을 활성화합니다.

---

## 빠른 시작

1. C/C++ 파일이 있는 프로젝트 폴더를 VS Code로 엽니다.
2. 익스텐션이 자동 활성화되면 사이드바 Activity Bar에 Annotation 아이콘이 나타납니다.
3. 코드에 `// @todo 할 일 메모`와 같은 주석을 작성합니다.
4. 파일을 저장하면 사이드바에 태그가 자동으로 등록됩니다.
5. 사이드바에서 태그를 클릭하면 해당 코드 위치로 즉시 이동합니다.
6. `git diff`를 실행해보면 태그 주석이 diff에 나타나지 않는 것을 확인할 수 있습니다.

---

## 태그 종류와 색상

총 8종의 태그를 지원합니다. 각 태그는 고유한 색상과 gutter 아이콘을 가집니다.

| 태그 | gutter 색상 | 용도 | 사이드바 표시 |
|------|-------------|------|:---:|
| `@bookmark` | 파랑 `#4FC3F7` | 중요 코드 위치 표시. 핵심 로직, 진입점, 자주 참조하는 코드에 사용합니다. | O |
| `@todo` | 녹색 `#66BB6A` | 할 일 메모. 아직 구현하지 않은 항목이나 개선이 필요한 부분에 사용합니다. | O |
| `@review` | 주황 `#FB8C00` | 코드 리뷰 포인트. 팀원의 코드를 리뷰할 때 자동 또는 수동으로 생성됩니다. 커밋 해시별로 그룹핑됩니다. | O |
| `@warn` | 빨강 `#EF5350` | 런타임 에러 기록. 위험한 코드 영역에 표시하여 수정 시 실수를 방지합니다. | O |
| `@breakpoint` | 주황 `#FF7043` | 디버그 브레이크포인트 + 조사식 자동 등록. 디버그 세션 시작 시 자동으로 브레이크포인트를 설정합니다. | O |
| `@region` | 보라 `#B39DDB` | 코드 접기 영역의 시작점을 정의합니다. 사이드바에서 트리 구조로 표시됩니다. | O |
| `@endregion` | 보라 `#B39DDB` | 코드 접기 영역의 끝점을 정의합니다. `@region`과 짝을 이루어 접기 범위를 결정합니다. | X |
| `@note` | (없음) | 개인 메모용. 사이드바에 표시되지 않으며 git diff에서만 제외됩니다. | X |

각 태그의 배경 하이라이트는 해당 색상의 투명도 20% 버전이 적용됩니다. 여러 줄 블록 주석의 경우 gutter 아이콘은 첫 줄에만 표시되고, 나머지 줄에는 배경 하이라이트만 적용됩니다.

### 언제 어떤 태그를 쓰는가

PintOS 프로젝트처럼 4명이 한 저장소에서 동시에 작업하는 상황을 예로 들겠습니다.

팀원 A가 `thread_create`를 구현하다가 `palloc_get_page` 호출 부분이 아직 미완성이라면 `@todo palloc 실패 시 예외 처리 추가`를 남깁니다. 사이드바에서 todo 목록을 보면 팀 전체의 미완성 항목이 한눈에 보이고, 다른 팀원이 이어서 작업할 수 있습니다. 태그는 git diff에 나타나지 않으므로 커밋 히스토리를 오염시키지 않습니다.

팀원 B가 A의 코드를 pull 받으면 `@review` 태그가 자동 생성되어 "어떤 함수가 추가됐고 어떤 역할인지"를 사이드바에서 바로 확인할 수 있습니다. 별도의 코드 리뷰 도구 없이 에디터 안에서 리뷰가 이루어집니다.

`@warn`은 "이 코드를 건드리면 위험하다"는 경고입니다. 예를 들어 인터럽트를 비활성화한 상태에서만 호출해야 하는 함수에 `@warn 인터럽트 OFF 상태에서만 호출`을 남기면, 해당 영역을 편집할 때 자동으로 경고가 뜹니다.

`@breakpoint`는 디버깅 세션마다 같은 위치에 브레이크포인트를 반복 설정하는 번거로움을 없앱니다. 조사식까지 함께 등록되므로 `process_exec`을 디버깅할 때 매번 변수를 Watch에 추가하는 작업이 사라집니다.

`@bookmark`는 "이 함수가 어디 있었지?" 하고 찾아 헤매는 시간을 줄입니다. 수십 개 파일에 흩어진 핵심 진입점을 사이드바에 모아두면 코드 탐색 속도가 크게 빨라집니다.

`@region`은 500줄 이상의 긴 파일에서 논리적 구역을 나눠 접을 수 있게 합니다. 중첩도 되므로 "메모리 관리 > malloc 구현 > 블록 분할"처럼 계층적으로 코드를 정리할 수 있습니다.

`@note`는 순수한 개인 메모입니다. "여기 왜 이렇게 했더라"를 적어두되 사이드바에 노출하고 싶지 않을 때 사용합니다. 다른 태그와 마찬가지로 git diff에서 제외됩니다.

---

## 주석 작성 방법

세 가지 주석 형식을 모두 지원합니다.

### 한 줄 주석 (//)

```c
// @todo 페이지 테이블 초기화 로직 확인
void page_init (void) { ... }
```

주의: 인라인 주석(`int x; // @todo`)은 지원되지 않습니다. 태그 주석은 반드시 줄의 시작(들여쓰기 허용)에서 작성해야 합니다. 인라인 주석을 사용하면 git clean filter가 해당 줄의 코드까지 함께 제거하는 것을 방지하기 위해 의도적으로 무시됩니다.

### 한 줄 블록 주석 (/* ... */)

```c
/* @bookmark 스레드 생성 핵심 */
struct thread *thread_create (const char *name, ...) { ... }
```

### 여러 줄 블록 주석

```c
/* @review
 * 이 함수는 인터럽트 비활성화 상태에서 호출되어야 합니다.
 * 락 획득 순서를 반드시 지켜야 합니다: a_lock -> b_lock
 */
```

여러 줄 블록 주석에서는 두 번째 줄부터 `*` 접두어가 없어도 인식됩니다. `*/`가 나올 때까지 모든 줄을 하나의 태그 내용으로 취급합니다.

### 자동완성

C/C++ 파일에서 `//` 또는 `/*` 입력 후 `@`를 타이핑하면 태그 자동완성 목록이 나타납니다. 목록에는 `@bookmark`, `@todo`, `@review`, `@warn`, `@breakpoint`, `@note`, `@region`, `@endregion` 전체가 포함됩니다.

### 주석 내 특수문자 처리

태그 내용에 `*/`가 포함되면 C 블록 주석이 조기 종료되는 것을 방지하기 위해 자동으로 `* /`(공백 삽입)로 이스케이프됩니다. 이는 사이드바의 `+` 버튼이나 컨텍스트 메뉴를 통해 태그를 추가할 때 자동 적용됩니다.

---

## 태그 추가 방법

네 가지 방법으로 태그를 추가할 수 있습니다.

### 1. 직접 작성

코드에 주석을 직접 타이핑합니다. 파일 저장 또는 텍스트 변경 시 300ms debounce 후 자동으로 스캔되어 사이드바에 등록됩니다.

### 2. 사이드바 `+` 버튼

사이드바 상단의 `+` 버튼을 클릭하면 다음 순서로 진행됩니다:

1. 태그 유형 선택 목록이 표시됩니다 (`@bookmark`, `@todo`, `@review`, `@warn`, `@breakpoint`, `@region`).
2. 내용 입력 창이 표시됩니다 (선택 사항 -- 빈 내용도 가능).
3. 현재 커서 위치에 `/* @tag 내용 */` 형식으로 주석이 자동 삽입됩니다.

### 3. 우클릭 컨텍스트 메뉴

에디터에서 우클릭하면 `Annotation` 서브메뉴가 나타납니다. `@todo 추가`, `@bookmark 추가`, `@review 추가`, `@warn 추가`, `@breakpoint 추가` 중 선택할 수 있습니다. 내용 입력 후 현재 커서 위치에 삽입됩니다.

### 4. 명령 팔레트

`Cmd+Shift+P` (Windows/Linux: `Ctrl+Shift+P`)를 열고 다음 명령을 검색합니다:

- `TODO 추가`
- `북마크 추가`
- `리뷰 추가`
- `경고 추가`
- `브레이크포인트 추가`

---

## 사이드바 -- Annotation Explorer

사이드바 Activity Bar에 Annotation 전용 아이콘이 추가됩니다. 워크스페이스 전체의 모든 태그를 한 곳에서 모아봅니다.

### 보기 모드

두 가지 보기 모드를 제공합니다. 상단 목록 아이콘을 클릭하여 전환합니다.

**유형별 그룹 (기본)**: `@bookmark`, `@todo`, `@review` 등 태그 유형별로 묶어서 표시합니다. 각 유형 그룹 옆에 해당 태그의 총 개수가 표시됩니다.

**파일별 그룹**: 파일 단위로 묶어서 표시합니다. 각 파일 그룹에는 해당 파일에 포함된 태그 개수가 표시됩니다.

### 항목 정보

각 사이드바 항목에는 다음 정보가 표시됩니다:

- 태그 유형에 해당하는 색상 아이콘
- 태그 내용 (또는 사용자가 수정한 표시 제목)
- 파일 이름과 줄 번호 (description 위치)

### 조작 방법

**클릭**: 해당 코드 위치로 이동합니다. 파일이 열리지 않았으면 자동으로 파일을 열고 해당 줄로 스크롤합니다.

**수정 버튼 (연필 아이콘)**: 사이드바에 표시되는 제목을 수정합니다. 파일 내 주석 원문은 변경되지 않습니다. 수정한 제목은 `.annotation/annotations.json`에 저장됩니다.

**삭제 버튼 (X 아이콘)**: 파일 내 주석과 사이드바 항목을 함께 삭제합니다. 여러 줄 블록 주석의 경우 전체 블록이 삭제됩니다.

**새로고침 (상단 아이콘)**: 워크스페이스 전체의 모든 파일을 다시 스캔하여 태그 목록을 갱신합니다.

**검색 (상단 아이콘)**: 태그 유형 필터 또는 텍스트 검색을 수행합니다. 유형 필터를 선택하면 해당 유형의 태그만 사이드바에 표시됩니다. 텍스트 검색은 태그 내용에서 일치하는 항목만 필터링합니다.

**모두 접기 (상단 아이콘)**: 사이드바의 트리 전체를 접습니다.

**모든 태그 삭제 (상단 아이콘)**: 워크스페이스 내 모든 어노테이션을 삭제합니다. 실행 전 확인 팝업이 표시됩니다.

**파일 태그 삭제**: 파일별 보기 모드에서 특정 파일 그룹을 우클릭하면 해당 파일의 모든 태그를 일괄 삭제할 수 있습니다.

### 드래그 앤 드롭

같은 태그 유형 내에서 사이드바 항목을 드래그하여 순서를 변경할 수 있습니다. 단일 항목 드래그 시 두 항목의 위치가 교환(swap)되고, 여러 항목을 선택하여 드래그하면 선택한 항목들이 드롭 위치에 삽입됩니다. 변경된 순서는 `.annotation/annotations.json`에 `sortOrder` 필드로 저장됩니다.

### @region 트리 구조

`@region` 태그는 사이드바에서 트리 구조로 표시됩니다. `@region`과 `@endregion`이 중첩되면 부모-자식 관계가 자동으로 형성됩니다. `@endregion`은 사이드바에 별도로 표시되지 않습니다.

```c
// @region 메모리 관리        <-- 사이드바에 부모 노드로 표시
// @region malloc 구현         <-- 사이드바에 자식 노드로 표시
void *malloc (size_t size) { ... }
// @endregion
void free (void *ptr) { ... }
// @endregion
```

---

## 태그 네비게이션

### 파일 내 이동

- `Alt+]` -- 현재 파일에서 다음 태그로 커서를 이동합니다.
- `Alt+[` -- 현재 파일에서 이전 태그로 커서를 이동합니다.

커서 위치 기준으로 가장 가까운 다음/이전 태그를 찾습니다. 파일의 마지막/첫 태그에 도달하면 더 이상 이동하지 않습니다.

### 워크스페이스 전체 이동

사이드바에 포커스가 있을 때 같은 단축키(`Alt+]`, `Alt+[`)를 누르면 워크스페이스 전체의 태그를 순회합니다. 현재 파일의 마지막 태그에서 다음 태그로 이동하면 다른 파일의 태그로 전환됩니다.

### 커서 위치 태그 삭제

현재 커서가 위치한 줄의 어노테이션 태그를 삭제하는 `현재 줄 태그 삭제` 명령이 있습니다. 기본 단축키는 지정되어 있지 않으며, 단축키 설정 패널에서 원하는 키를 지정할 수 있습니다.

---

## Git Diff 자동 제외

이 기능은 Annotation 익스텐션의 핵심입니다. 태그 주석이 로컬에서는 보이지만 git diff와 커밋에는 포함되지 않도록 합니다.

### 자동 설정 과정

익스텐션이 활성화되면 다음 항목이 자동으로 설정됩니다:

1. `.annotation/scripts/clean-local.js` -- Node.js 기반 clean filter 스크립트가 생성됩니다.
2. `git config filter.annotation-local.clean` -- 커밋 시 태그 주석을 제거하는 clean filter가 등록됩니다.
3. `.gitattributes`에 `*.c filter=annotation-local`과 `*.h filter=annotation-local` 줄이 추가됩니다.

### 필터 제거 규칙

필터 스크립트가 다음 세 가지 패턴을 모두 처리합니다:

**한 줄 주석**: `// @tag ...` 형식의 줄 전체를 삭제합니다.

**한 줄 블록 주석**: `/* @tag ... */` 형식의 줄 전체를 삭제합니다.

**여러 줄 블록 주석**: `/* @tag ...`로 시작하는 줄부터 `*/`로 끝나는 줄까지 전체 블록을 삭제합니다.

대상 태그: `@todo`, `@bookmark`, `@review`, `@warn`, `@breakpoint`, `@note`, `@region`, `@endregion`

### 앵커 규칙

모든 필터 패턴은 줄 시작 앵커(`^`)를 사용합니다. 따라서 `int x; // @todo` 같은 인라인 주석은 필터 대상에서 제외되며, 코드가 실수로 삭제되는 것을 방지합니다.

### 결과

- 로컬 에디터에서는 태그 주석이 그대로 보입니다.
- `git diff`를 실행하면 태그 주석이 나타나지 않습니다.
- `git commit`을 하면 태그 주석이 제거된 상태로 커밋됩니다.
- 팀원에게 push해도 태그 주석은 전달되지 않습니다.
- `.annotation/` 디렉토리는 `.gitignore`에 자동 등록되어 원격 저장소에 올라가지 않습니다.

### 이미 커밋된 태그 처리

이전에 태그 주석이 포함된 상태로 커밋한 파일이 있다면, 필터를 적용한 후 다음 명령을 실행하여 모든 추적 파일에 clean filter를 일괄 적용할 수 있습니다:

```bash
git add --renormalize .
```

이 명령은 모든 추적 파일을 clean filter를 통해 다시 처리하므로, 기존에 커밋된 태그 주석이 제거된 상태로 변경사항이 staging됩니다.

---

## @breakpoint -- 디버그 브레이크포인트와 조사식

`@breakpoint` 태그는 디버그 기능과 연동됩니다.

### 기본 사용법

```c
/* @breakpoint */
process_create_initd (file_name);
```

위 예시에서는 `process_create_initd` 줄에 VS Code 브레이크포인트가 자동으로 설정됩니다.

### 조사식(Watch Expression) 등록

태그 내용에 쉼표로 구분된 표현식을 작성하면 Watch 패널에 자동 등록됩니다:

```c
/* @breakpoint (void *) t->tf.R.rip, (void *) t->tf.R.rdi, (char *) t->tf.R.rsi */
process_create_initd (file_name);
```

위 예시에서는 `process_create_initd` 줄에 브레이크포인트가 설정되고, Watch 패널에 3개의 표현식이 등록됩니다.

### 동작 세부사항

- 브레이크포인트는 태그 주석 다음 줄부터 최대 10줄을 탐색하여 실제 실행 가능한 코드 줄에 설정됩니다. 주석 줄, 빈 줄, `*/` 줄은 건너뜁니다.
- 파일 저장 시 브레이크포인트 위치가 자동으로 동기화됩니다. 코드가 이동하면 브레이크포인트도 따라갑니다.
- Watch 표현식의 중복 등록을 방지합니다. 한 번 등록된 표현식은 `workspaceState`에 기록되어 재등록되지 않습니다.
- 디버그 세션이 시작되면 모든 `@breakpoint` 태그의 브레이크포인트가 활성화되고, 세션이 종료되면 자동으로 제거됩니다.
- 열려 있는 문서가 있으면 디스크 파일 대신 메모리의 문서 내용을 기준으로 줄 번호를 계산하므로, 미저장 편집 상태에서도 정확한 위치에 브레이크포인트가 설정됩니다.

---

## @region / @endregion -- 코드 접기

코드 영역을 논리적으로 구분하고 접을 수 있습니다.

### 기본 사용법

```c
// @region 메모리 관리
void *malloc (size_t size) { ... }
void free (void *ptr) { ... }
// @endregion
```

`@region`과 `@endregion` 사이의 코드를 VS Code의 코드 접기 기능으로 접을 수 있습니다.

### 중첩 지원

```c
// @region 커널 초기화
void kernel_init (void) {
    // @region 메모리 초기화
    mem_init ();
    palloc_init ();
    // @endregion

    // @region 스레드 초기화
    thread_init ();
    // @endregion
}
// @endregion
```

중첩된 `@region`은 사이드바에서 트리 구조로 표시됩니다. 스택 기반 알고리즘으로 부모-자식 관계를 자동으로 매칭합니다.

### 지원 언어

C, C++, TypeScript, JavaScript, Python, Java 파일에서 동작합니다.

---

## @review -- 코드 리뷰 자동 생성

### 자동 생성 (pull 시)

팀원이 push한 커밋을 pull 받으면, 새로 추가된 함수나 변수를 자동으로 감지하여 `@review` 태그를 생성합니다.

- OpenAI API 키가 설정되어 있으면 AI가 한국어로 코드 설명을 생성합니다.
- API 키가 없으면 Doxygen 스타일 시그니처 설명으로 대체됩니다.
- 자기 커밋에는 리뷰를 생성하지 않습니다. `git config user.name`과 커밋 작성자를 비교하여 판별합니다.
- 가상(virtual) 항목으로 사이드바에만 표시됩니다. 파일에 실제 주석을 작성하지 않습니다.

### 수동 생성 (리뷰 확인)

사이드바 상단의 체크리스트 아이콘을 클릭하면 최근 30개 커밋 목록이 표시됩니다. 원하는 커밋을 선택하면 해당 커밋의 변경사항에 대한 리뷰 태그가 일괄 생성됩니다.

### 사이드바 그룹핑

`@review` 태그는 유형별 보기에서 커밋 해시별로 그룹핑됩니다:

- `uncommitted` -- 수동으로 작성한 리뷰
- `abc1234 -- 작성자 (3)` -- 특정 커밋의 자동 리뷰 (괄호 안은 리뷰 개수)

---

## @warn -- 런타임 에러 기록

`@warn` 태그가 있는 줄 근처(위아래 2줄 이내)를 편집하면 콘솔에 경고 로그가 출력됩니다.

```c
/* @warn 이 함수 수정 시 락 획득 순서 a_lock -> b_lock 반드시 유지 */
void critical_section (void) { ... }
```

위험한 코드 영역에 `@warn`을 표시해두면, 해당 영역을 수정할 때 주의사항을 자동으로 알려줍니다. `@warn`은 수동으로만 추가됩니다.

---

## AI 커밋 메시지 생성

소스 제어 패널(SCM) 상단 또는 사이드바 메뉴에서 `커밋 메시지 생성`을 클릭합니다.

### 동작 과정

1. 현재 staged된 변경사항의 diff를 수집합니다.
2. `resources/conventions/commit-convention.md` 규칙에 따라 `<type>: <한국어 제목>` 형식의 커밋 메시지를 생성합니다.
3. 생성된 메시지가 SCM input box에 자동으로 설정됩니다.
4. diff가 4,000바이트를 초과하면 자동으로 잘립니다.

### 요구사항

- OpenAI API 키가 등록되어 있어야 합니다.
- staged된 변경사항이 있어야 합니다.
- SCM input box 설정이 실패하면 생성된 메시지가 클립보드에 자동 복사됩니다.

---

## Shadow Diff -- 팀원 변경사항 시각화

백그라운드에서 주기적으로 `git fetch`를 실행하여 원격 브랜치의 변경사항을 감시합니다.

### 시각 표시

- 빨간색 배경 강조: 같은 줄을 로컬에서도 수정함 (충돌 가능 영역)
- CodeLens: 충돌 가능 영역 위에 `작성자 (브랜치) -- 시간` 정보가 표시됩니다.
- Hover: 마우스를 올리면 팀원의 diff 미리보기를 확인할 수 있습니다.

참고: 변경 영역 전체를 노란색으로 칠하던 배경 표시는 제거되었습니다.

### Pull and Push

사이드바 메뉴에서 `Pull & Push`를 클릭하면 `git pull --rebase`를 먼저 실행한 후 `git push`를 순차적으로 실행합니다.

### 설정

`jungleKit.sync.intervalMinutes`로 백그라운드 fetch 주기를 조절할 수 있습니다 (기본값: 5분).

---

## PR 만들기

사이드바 메뉴에서 `PR 만들기`를 클릭하면 WebView 기반 PR 생성 패널이 열립니다.

### 기능

- 현재 브랜치에서 base 브랜치(main, master 등)로의 PR을 생성합니다.
- base 브랜치를 변경하면 변경 파일 목록과 diff가 자동으로 갱신됩니다.
- `AI 생성` 버튼을 클릭하면 `resources/conventions/pr-convention.md` 규칙에 따라 제목과 본문을 AI가 작성합니다.
- 변경 파일 목록, 커밋 로그, `@review` 포인트를 접이식 패널로 확인할 수 있습니다.
- `origin` remote의 HTTPS 토큰, `GH_TOKEN`/`GITHUB_TOKEN`, 또는 git credential helper에 저장된 GitHub 자격증명으로 GitHub API를 호출해 PR을 직접 생성합니다. reviewer 지정도 가능합니다.
- `gh auth login` 없이도 동작하도록 설계되어 있으며, 브랜치 push만 가능하면 PR 생성까지 이어집니다.

### 요구사항

- GitHub에 push 가능한 `origin` remote, `GH_TOKEN`/`GITHUB_TOKEN`, 또는 git credential helper에 저장된 GitHub 자격증명
- OpenAI API 키 (AI 생성 기능 사용 시)

---

## 코딩 스타일 검사

`.clang-format` 기반 코딩 스타일 검사를 자동으로 수행합니다.

### 자동 동작

- 익스텐션 활성화 시 워크스페이스 루트에 `.clang-format` 파일이 자동 생성됩니다 (PintOS GNU 스타일 기반).
- C/C++ 파일 저장 시 `clang-format --dry-run --Werror`를 실행합니다.
- 스타일 위반이 있으면 Problems 패널에 `[Style]` 진단이 표시됩니다.
- 어노테이션 태그가 포함된 줄은 스타일 검사에서 자동 제외됩니다. 블록 주석의 경우 전체 범위가 제외됩니다.
- `editor.formatOnSave`가 C/C++ 파일에 자동으로 활성화됩니다.

### 수동 실행

`Cmd+Shift+P` -> `코딩 스타일 검사`

### 요구사항

- `clang-format`이 시스템에 설치되어 있어야 합니다 (`sudo apt install clang-format`).

---

## 환경 검증

익스텐션 시작 시 개발 환경을 자동으로 검증합니다.

| 검사 항목 | 기본 활성화 | 설치 명령 |
|-----------|:-----------:|-----------|
| gcc | O | `sudo apt install gcc` |
| qemu-system-x86_64 | O | `sudo apt install qemu-system-x86` |
| gdb | O | `sudo apt install gdb` |
| make | O | `sudo apt install build-essential` |
| clang-format | O | `sudo apt install clang-format` |
| C/C++ 확장 (ms-vscode.cpptools) | O | `code --install-extension ms-vscode.cpptools` |

모든 항목이 통과하면 정보 메시지로 알려줍니다. 누락된 도구가 있으면 Output 채널(`Annotation: Environment`)에 `[FAIL]` 표시와 설치 명령을 안내합니다.

`.annotation/config.json`의 `env.checks`에서 개별 항목을 `false`로 설정하여 비활성화할 수 있습니다. `env.showOnStartup`을 `false`로 설정하면 시작 시 자동 검증이 비활성화됩니다.

---

## 단축키 설정

사이드바 메뉴에서 `단축키 설정`을 클릭하면 WebView 기반 설정 패널이 열립니다.

### 기본 단축키

| 기능 | 기본 키 | 설명 |
|------|---------|------|
| 이전 태그로 이동 | `Alt+[` | 현재 파일 또는 워크스페이스에서 이전 어노테이션 태그로 커서 이동 |
| 다음 태그로 이동 | `Alt+]` | 현재 파일 또는 워크스페이스에서 다음 어노테이션 태그로 커서 이동 |
| 태그 삭제 | (미지정) | 현재 커서가 위치한 줄의 어노테이션 태그를 삭제 |

### 단축키 변경 방법

1. 단축키 설정 패널에서 변경하려는 항목의 수정 버튼(연필 아이콘)을 클릭합니다.
2. 새로운 키 조합을 입력합니다 (예: `alt+d`, `cmd+shift+k`).
3. `적용` 버튼을 눌러 VS Code `keybindings.json`에 반영합니다.

빈 값을 입력하면 해당 단축키가 미지정 상태가 됩니다. `초기화` 버튼으로 기본값을 복원할 수 있습니다.

---

## API 키 관리

OpenAI API 키는 VS Code SecretStorage를 통해 OS 키체인에 안전하게 저장됩니다. macOS에서는 Keychain, Windows에서는 Credential Manager, Linux에서는 libsecret을 사용합니다. 평문으로 디스크에 기록되지 않습니다.

- **등록**: `Cmd+Shift+P` -> `OpenAI API 키 등록`. `sk-`로 시작하는 20자 이상의 키를 입력합니다.
- **삭제**: `Cmd+Shift+P` -> `OpenAI API 키 삭제`. 확인 팝업 후 삭제됩니다.
- AI 기능(커밋 메시지 생성, PR 생성, 리뷰 생성)을 호출할 때 키가 등록되어 있지 않으면 등록 안내 팝업이 자동으로 표시됩니다.

---

## 프로젝트 초기화

`Cmd+Shift+P` -> `프로젝트 초기화`를 실행하면 다음 구조가 생성됩니다:

- `.annotation/` 디렉토리
- `.annotation/config.json` -- 프로젝트 설정 (커밋 컨벤션, 환경 검증 옵션, 스타일 설정)
- `.annotation/notes/` 서브 디렉토리
- `.annotation/.gitignore`에 `annotations.json`, `keybindings.json`, `notes/` 자동 추가

프로젝트 초기화 없이도 익스텐션의 기본 기능(태그 인식, 사이드바, gutter 표시)은 동작합니다. 초기화는 git filter, 스타일 검사, 환경 검증 등의 고급 기능을 위해 필요합니다.

---

## 설정

VS Code 설정(`Cmd+,`)에서 `jungleKit`으로 검색하여 변경할 수 있습니다.

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `jungleKit.ai.model` | `gpt-4o-mini` | AI 기능에 사용할 OpenAI 모델. `gpt-4o` 또는 `gpt-4o-mini`를 지정합니다. |
| `jungleKit.sync.intervalMinutes` | `5` | Shadow Diff 백그라운드 fetch 주기(분 단위). |
| `jungleKit.style.autoCreateClangFormat` | `true` | `.clang-format` 파일 자동 생성 여부. |

---

## 활성화 조건

다음 중 하나라도 충족되면 익스텐션이 자동 활성화됩니다:

- 워크스페이스에 `Makefile.build` 파일이 존재하는 경우
- 워크스페이스에 `Makefile` 파일이 존재하는 경우
- 워크스페이스에 `.c` 파일이 존재하는 경우
- 워크스페이스에 `.h` 파일이 존재하는 경우
- 워크스페이스에 `.annotation/config.json` 파일이 존재하는 경우
- `프로젝트 초기화` 명령을 수동으로 실행한 경우

---

## 파일 구조

익스텐션이 생성하는 프로젝트 내 파일 구조입니다:

```text
.annotation/
  annotations.json      -- 어노테이션 메타데이터 (displayLabel, sortOrder 등)
  keybindings.json      -- 단축키 설정
  config.json           -- 프로젝트 설정
  .gitignore            -- 로컬 상태 파일 제외
  scripts/
    clean-local.js      -- git clean filter (Node.js)
  notes/                -- 개인 메모 (gitignore 대상)

.clang-format           -- 워크스페이스 루트 코딩 스타일 파일
```

---

## 요구사항

- VS Code 1.85.0 이상
- Git이 설치되어 있어야 합니다
- C/C++ 파일이 있는 프로젝트에서 최적으로 동작합니다
- AI 기능 사용 시 OpenAI API 키가 필요합니다
- PR 생성 시 GitHub에 push 가능한 `origin` remote, `GH_TOKEN`/`GITHUB_TOKEN`, 또는 git credential helper 자격증명이 필요합니다
- 스타일 검사 시 `clang-format`이 필요합니다

---

## 라이선스

MIT
