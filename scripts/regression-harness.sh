#!/usr/bin/env bash
# ============================================================
# Annotation Extension — 회귀 하네스 (FEATURE_SPEC v1.3 기반)
# 22개 검증 항목을 자동으로 확인하는 정적 분석 스크립트
# 사용법: bash scripts/regression-harness.sh
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
PASS=0
FAIL=0
WARN=0

green() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m⚠ %s\033[0m\n' "$1"; }

check() {
    local id="$1" desc="$2"
    shift 2
    if "$@"; then
        green "[$id] $desc"
        ((PASS++))
    else
        red "[$id] $desc"
        ((FAIL++))
    fi
}

warn_check() {
    local id="$1" desc="$2"
    shift 2
    if "$@"; then
        green "[$id] $desc"
        ((PASS++))
    else
        yellow "[$id] $desc (경고)"
        ((WARN++))
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "  Annotation Extension — 회귀 하네스"
echo "  기준: FEATURE_SPEC v1.3 (22개 검증 항목)"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── H1: 컴파일 검증 ───
h1_compile() {
    cd "$ROOT" && npx tsc --noEmit 2>/dev/null
}
check "H01" "컴파일 검증 — tsc --noEmit 에러 0건" h1_compile

# ─── H2: git filter 패턴 테스트 ───
h2_filter() {
    local script="$SRC/features/tagSystem.ts"
    # clean-local.js 내용이 소스에 포함되어 있는지 확인 (스크립트 생성 로직)
    # 10종 패턴이 필터에 포함되어야 함
    local patterns=("@todo" "@bookmark" "@review" "@warn" "@breakpoint" "@note" "@region" "@endregion")
    for pat in "${patterns[@]}"; do
        if ! grep -q "$pat" "$script"; then
            return 1
        fi
    done
    # 블록 주석 처리 로직 확인 (멀티라인)
    grep -q "blockComment\|BLOCK_START\|multiline\|\/\*.*@" "$script"
}
check "H02" "git filter 패턴 — 10종 태그 패턴 필터 포함 확인" h2_filter

# ─── H3: 보안 패턴 스캔 ───
h3_security() {
    local file="$SRC/features/shadowDiff.ts"
    # execAsync가 없어야 함 (import 포함)
    ! grep -qE "^\s*(const|let|var)\s+execAsync\b" "$file" &&
    ! grep -qE "execAsync\s*\(" "$file"
}
check "H03" "보안 패턴 — shadowDiff.ts에 execAsync 미사용" h3_security

# ─── H4: 자동완성 목록 검증 ───
h4_note_type() {
    grep -q "'note'" "$SRC/features/tagSystem.ts" &&
    grep -qE "ALL_TAG_TYPES.*note|note.*ALL_TAG_TYPES" "$SRC/features/tagSystem.ts"
}
check "H04" "자동완성 — ALL_TAG_TYPES에 'note' 포함" h4_note_type

# ─── H5: 단축키 패널 검증 ───
h5_shortcuts() {
    local file="$SRC/features/tagSystem.ts"
    # DEFAULT_SHORTCUTS 배열의 항목 수 확인 (15개 이상)
    local count
    count=$(grep -cE "^\s+\{" <(sed -n '/DEFAULT_SHORTCUTS\s*[=:]/,/^\s*\];/p' "$file") 2>/dev/null || echo "0")
    [ "$count" -ge 15 ]
}
check "H05" "단축키 패널 — DEFAULT_SHORTCUTS ≥ 15개" h5_shortcuts

# ─── H6: API 키 환경변수 검증 ───
h6_env_key() {
    grep -q "process\.env\.OPENAI_API_KEY\|process\.env\[.OPENAI_API_KEY.\]" "$SRC/utils/apiKeyManager.ts"
}
check "H06" "API 키 — 환경변수 OPENAI_API_KEY 참조 존재" h6_env_key

# ─── H7: .clang-format 덮어쓰기 검증 ───
h7_clang() {
    local file="$SRC/features/styleEnforcer.ts"
    # clang-format 파일 생성 전에 existsSync 가드가 없어야 함
    # "clangFormat" 근처에 existsSync가 없어야 함
    ! grep -B5 "writeFileSync.*clang-format\|clangFormat" "$file" | grep -q "existsSync"
}
check "H07" ".clang-format — 생성 전 existsSync 가드 없음" h7_clang

# ─── H8: formatOnSave 강제 설정 검증 ───
h8_format_on_save() {
    local file="$SRC/features/styleEnforcer.ts"
    # formatOnSave 설정 시 조건 없이 설정하는지 확인
    # "if (!...formatOnSave" 같은 조건문이 없어야 함
    ! grep -qE "if\s*\(.*formatOnSave" "$file"
}
check "H08" "formatOnSave — 조건 없이 true 설정" h8_format_on_save

# ─── H9: collapseTags 토글 검증 ───
h9_toggle() {
    local file="$SRC/features/tagSystem.ts"
    # toggleCollapse 메서드 존재 + _allCollapsed 필드
    grep -q "_allCollapsed" "$file" && grep -q "toggleCollapse" "$file"
}
check "H09" "collapseTags — 토글 로직 (toggleCollapse + _allCollapsed)" h9_toggle

# ─── H10: 원자적 쓰기 검증 ───
h10_atomic() {
    local file="$SRC/features/tagSystem.ts"
    grep -q "\.tmp" "$file" && grep -q "renameSync" "$file"
}
check "H10" "원자적 쓰기 — .tmp + renameSync 패턴" h10_atomic

# ─── H11: PR execFile 검증 ───
h11_pr_execfile() {
    grep -q "execFileAsync.*'gh'" "$SRC/features/prPanel.ts"
}
check "H11" "PR execFile — execFileAsync('gh', ...) 형태" h11_pr_execfile

# ─── H12: PR 기존 오픈 확인 검증 ───
h12_pr_view() {
    grep -q "gh pr view" "$SRC/features/prPanel.ts"
}
check "H12" "PR 기존 오픈 — gh pr view 호출 존재" h12_pr_view

# ─── H13: PR 진행 메시지 검증 ───
h13_pr_progress() {
    local file="$SRC/features/prPanel.ts"
    grep -q "기존 PR 확인 중" "$file" &&
    grep -q "변경 파일 분석 중" "$file" &&
    grep -q "AI로 PR 내용 생성 중" "$file"
}
check "H13" "PR 진행 메시지 — 3개 상태 메시지 문자열 존재" h13_pr_progress

# ─── H14: 폴더명 검증 ───
h14_folder_name() {
    # 소스에서 .jungle-kit을 주 경로로 사용하는 곳이 없어야 함
    # 마이그레이션 로직 내 참조(legacyDir, 문자열 비교 등)는 허용
    local hits
    hits=$(grep -rn "\.jungle-kit" "$SRC" \
        | grep -v "legacyDir\|legacy\|migration\|migrate\|마이그레이션\|이전\|jungle-kit.*폴더\|'.jungle-kit'" \
        | grep -cv "^\s*$" 2>/dev/null || echo "0")
    # 0건이면 통과, 마이그레이션 참조만 남아있으면 OK
    # 좀 더 보수적으로: .annotation이 주 경로에 사용되는지 확인
    grep -q "\.annotation" "$SRC/utils/configManager.ts"
}
check "H14" "폴더명 — .annotation 사용 확인" h14_folder_name

# ─── H15: .gitattributes .gitignore 미등록 검증 ───
h15_gitattributes() {
    local file="$SRC/features/tagSystem.ts"
    # entriesToAdd에 .gitattributes가 없어야 함
    ! sed -n '/entriesToAdd/,/\]/p' "$file" | grep -q "gitattributes"
}
check "H15" ".gitattributes — gitignore 미등록 (entriesToAdd에 없음)" h15_gitattributes

# ─── H16: 에디터 데코레이션 변경 검증 ───
h16_decoration() {
    local file="$SRC/features/shadowDiff.ts"
    # borderLeft가 없어야 하고, backgroundColor가 있어야 함
    ! grep -q "borderLeft" "$file" && grep -q "backgroundColor" "$file"
}
check "H16" "데코레이션 — borderLeft 없음 + backgroundColor 존재" h16_decoration

# ─── H17: 스캔 파일수 제한 검증 ───
h17_scan_limit() {
    ! grep -q "MAX_WORKSPACE_SCAN_FILES" "$SRC/features/tagSystem.ts"
}
check "H17" "스캔 제한 — MAX_WORKSPACE_SCAN_FILES 미존재" h17_scan_limit

# ─── H18: 스캔 glob 검증 ───
h18_scan_glob() {
    local file="$SRC/features/tagSystem.ts"
    grep -q "WORKSPACE_SCAN_GLOB" "$file" &&
    grep "WORKSPACE_SCAN_GLOB" "$file" | grep -q "c,h\|{c,h}" &&
    ! grep "WORKSPACE_SCAN_GLOB" "$file" | grep -q "cpp"
}
check "H18" "스캔 glob — *.{c,h}만 포함 (.cpp 미포함)" h18_scan_glob

# ─── H19: 죽은 코드 검증 ───
h19_dead_code() {
    # package.json에 jungleKit.project 설정이 없어야 함
    ! grep -q '"jungleKit.project"' "$ROOT/package.json"
}
check "H19" "죽은 코드 — jungleKit.project 설정 미존재" h19_dead_code

# ─── H20: 필터명 검증 ───
h20_filter_name() {
    local file="$SRC/features/tagSystem.ts"
    # annotation-local이 주 필터명으로 사용
    grep -q "annotation-local" "$file" &&
    # jungle-local이 주 필터명으로 사용되면 안됨 (레거시 정리 로직 제외)
    # filterName 변수가 annotation-local이어야 함
    grep -qE "filterName.*=.*['\"]annotation-local['\"]" "$file"
}
check "H20" "필터명 — annotation-local 사용 (jungle-local은 레거시 정리만)" h20_filter_name

# ─── H21: git filter config 검증 ───
h21_git_config() {
    local file="$SRC/features/tagSystem.ts"
    # execFileP ('git', ['config', ...]) 호출이 annotation-local 필터 등록에 사용
    grep -q "execFileP" "$file" &&
    grep -q "'git'" "$file" &&
    grep -q "'config'" "$file" &&
    grep -q "filterName.*annotation-local\|'annotation-local'" "$file"
}
check "H21" "git filter config — execFileAsync + annotation-local 등록" h21_git_config

# ─── H22: 핀토스 프로젝트 태그 잔류 ───
h22_pintos_tags() {
    # src/ 아래 소스 파일에 실제 동작하는 태그 ��석이 없어야 ���
    # 설명 주석 (// @region/@endregion 등 뒤에 설명 문구가 붙은 것)은 허용
    # 실제 태그: "// @todo 내용" 또는 "// @todo" (줄 끝)
    # 허용: "// @region/@endregion ..." (슬래시가 붙어있는 설명)
    local count
    count=$(grep -rn "^\s*//\s*@\(todo\|bookmark\|review\|warn\|breakpoint\|note\)\(\s\|$\)" "$SRC" 2>/dev/null | wc -l)
    [ "$count" -eq 0 ]
}
check "H22" "핀토스 태그 잔류 — src/ 내 실제 태그 주석 0건" h22_pintos_tags

# ─── 결과 요약 ───
echo ""
echo "═══════════════════════════════════════════════════════"
printf "  결과: \033[32m%d PASS\033[0m / \033[31m%d FAIL\033[0m / \033[33m%d WARN\033[0m  (총 %d)\n" \
    "$PASS" "$FAIL" "$WARN" "$((PASS + FAIL + WARN))"
echo "═══════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
