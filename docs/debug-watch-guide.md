# @breakpoint 조사식 가이드

## 개요

`@breakpoint` 어노테이션은 디버그 시 자동으로 VS Code 브레이크포인트와 조사식(Watch Expression)을 등록합니다.

```c
/* @breakpoint if_->rip, ehdr.e_entry, file_name */
```

위 주석을 작성하면:
- **다음 줄**에 브레이크포인트가 자동 설정됩니다 (파일 저장 시)
- 디버그 세션 시작 시 `if_->rip`, `ehdr.e_entry`, `file_name`이 조사식에 등록됩니다

---

## 조사식 작성 규칙

쉼표(`,`)로 구분하여 여러 표현식을 등록할 수 있습니다.

```c
/* @breakpoint 표현식1, 표현식2, 표현식3 */
```

---

## GDB (PintOS/QEMU) 환경에서 사용 가능한 조사식

PintOS는 QEMU + GDB로 디버그합니다. GDB 백엔드에서 Watch에 넣을 수 있는 표현식은 다음과 같습니다.

### 변수 / 구조체 멤버

| 조사식 | 설명 |
|--------|------|
| `변수명` | 지역/전역 변수 값 |
| `*ptr` | 포인터 역참조 |
| `struct->member` | 구조체 멤버 접근 |
| `array[i]` | 배열 인덱스 접근 |
| `thread_current()->name` | 함수 호출 결과 (GDB 지원) |
| `thread_current()->tid` | 현재 스레드 ID |

### 레지스터 (x86-64)

| 조사식 | 설명 |
|--------|------|
| `$rip` | 다음 실행 명령어 주소 |
| `$rax` | 반환값 / 시스템 콜 번호 |
| `$rdi` | 첫 번째 인자 |
| `$rsi` | 두 번째 인자 |
| `$rdx` | 세 번째 인자 |
| `$rcx` | 네 번째 인자 |
| `$rsp` | 스택 포인터 |
| `$rbp` | 베이스 포인터 |
| `$eflags` | 플래그 레지스터 |

### 캐스팅

| 조사식 | 설명 |
|--------|------|
| `(int)$rax` | 레지스터를 int로 캐스팅 |
| `(char *)$rdi` | 문자열 포인터로 해석 |
| `(struct thread *)$rdi` | 구조체 포인터로 해석 |
| `(void(*)())$rip` | 함수 포인터로 해석 (함수명 표시 가능) |

### 메모리 참조

| 조사식 | 설명 |
|--------|------|
| `*(int *)0x8004000` | 특정 주소의 int 값 |
| `*(char **)$rsp` | 스택 최상단의 포인터 |

### 제한 사항 (Watch에서 불가)

Watch 표현식에서는 다음이 **불가능**합니다:
- `info symbol $rip` (GDB 명령어)
- `x/i $rip` (메모리 덤프)
- `bt` (백트레이스)
- `info registers` (전체 레지스터)

이런 작업은 **Debug Console**에서 `-exec` 접두사를 붙여 사용합니다.

---

## Debug Console 명령어 (GDB)

VS Code 하단 **DEBUG CONSOLE** 탭에서 사용합니다. 모든 GDB 명령 앞에 `-exec`를 붙여야 합니다.

### 주소 → 함수명 변환

```
-exec info symbol $rip
```
출력 예: `syscall_handler + 18 in section .text`

### 다음 실행될 명령어 확인

```
-exec x/5i $rip
```
출력 예:
```
0x8048a3c <syscall_handler+18>: mov    %rax,%rdi
0x8048a3f <syscall_handler+21>: call   0x8048b20 <printf>
...
```

### 전체 레지스터 확인

```
-exec info registers
```

### 콜스택 확인

```
-exec bt
```

### 특정 주소의 함수 확인

```
-exec info symbol 0x8048a3c
```

### 메모리 덤프

```
-exec x/16xw $rsp
```
스택 최상단 16워드를 16진수로 출력

---

## 일반 디버거 (C/C++ 네이티브) 환경

LLDB 또는 네이티브 VS Code 디버거를 사용하는 경우:

### Watch에서 사용 가능

| 조사식 | 설명 |
|--------|------|
| `변수명` | 지역/전역 변수 |
| `*ptr` | 포인터 역참조 |
| `arr[0]` | 배열 요소 |
| `(int)(expr)` | 캐스팅 |
| `a + b` | 산술 연산 |
| `a == b` | 비교 연산 |
| `cond ? a : b` | 조건 연산 |

### Watch에서 사용 불가

| 표현식 | 이유 |
|--------|------|
| `sizeof(type)` | 일부 디버거에서 미지원 |
| `#define MACRO` | 매크로는 컴파일 시 제거됨 |
| `inline 함수` | 최적화로 인라인된 경우 호출 불가 |

---

## 실전 예시

### PintOS syscall_handler 디버깅

```c
void
syscall_handler (struct intr_frame *f UNUSED) {
    /* @breakpoint f->R.rax, f->R.rdi, f->R.rsi, f->R.rdx */
    printf ("system call!\n");
    thread_exit ();
}
```

디버그 중단 시:
- `f->R.rax` → 시스템 콜 번호 (예: 9 = SYS_WRITE)
- `f->R.rdi` → 첫 번째 인자 (fd)
- `f->R.rsi` → 두 번째 인자 (buffer 주소)
- `f->R.rdx` → 세 번째 인자 (size)

Debug Console에서 함수명 확인:
```
-exec info symbol f->R.rip
```

### PintOS load 함수 디버깅

```c
if_->rip = ehdr.e_entry;
/* @breakpoint if_->rip, ehdr.e_entry, file_name */
```

디버그 중단 시:
- `if_->rip` → 유저 프로그램 시작 주소
- `ehdr.e_entry` → ELF 엔트리 포인트
- `file_name` → 실행 파일명

---

## PintOS 시스템 콜 번호 참조 (x86-64)

| 번호 | 시스템 콜 | rdi | rsi | rdx |
|------|-----------|-----|-----|-----|
| 0 | SYS_HALT | - | - | - |
| 1 | SYS_EXIT | status | - | - |
| 2 | SYS_EXEC | cmd_line | - | - |
| 3 | SYS_WAIT | pid | - | - |
| 4 | SYS_CREATE | file | initial_size | - |
| 5 | SYS_REMOVE | file | - | - |
| 6 | SYS_OPEN | file | - | - |
| 7 | SYS_FILESIZE | fd | - | - |
| 8 | SYS_READ | fd | buffer | size |
| 9 | SYS_WRITE | fd | buffer | size |
| 10 | SYS_SEEK | fd | position | - |
| 11 | SYS_TELL | fd | - | - |
| 12 | SYS_CLOSE | fd | - | - |
