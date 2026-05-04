import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConfigManager } from '../utils/configManager';

const execAsync = promisify (exec);

const PINTOS_CLANG_FORMAT = `# PintOS C Coding Style (GNU-based)
# Auto-formatted on save (editor.formatOnSave: true)
BasedOnStyle: GNU
Language: Cpp
UseTab: ForIndentation
TabWidth: 4
IndentWidth: 4
ContinuationIndentWidth: 8
IndentCaseLabels: false
IndentGotoLabels: false
NamespaceIndentation: None
ColumnLimit: 79
AlwaysBreakAfterReturnType: TopLevelDefinitions
AlwaysBreakAfterDefinitionReturnType: TopLevel
BreakBeforeBraces: Custom
BraceWrapping:
  AfterFunction: false
  AfterControlStatement: Never
  AfterEnum: false
  AfterStruct: false
  AfterUnion: false
  BeforeElse: false
  BeforeWhile: false
  SplitEmptyFunction: false
SpaceBeforeParens: Always
SpaceInEmptyParentheses: false
SpacesInParentheses: false
SpaceAfterCStyleCast: true
SpacesBeforeTrailingComments: 1
PointerAlignment: Right
DerivePointerAlignment: false
AlignConsecutiveMacros: true
AlignConsecutiveDeclarations: false
AlignConsecutiveAssignments: false
AlignTrailingComments: true
AlignEscapedNewlines: Left
AlignOperands: true
SortIncludes: false
IncludeBlocks: Preserve
AllowShortFunctionsOnASingleLine: None
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false
AllowShortBlocksOnASingleLine: false
AllowShortCaseLabelsOnASingleLine: false
BreakBeforeBinaryOperators: None
BreakBeforeTernaryOperators: true
MaxEmptyLinesToKeep: 1
KeepEmptyLinesAtTheStartOfBlocks: false
`;

export class StyleEnforcer {
	private config: ConfigManager;
	private diagnostics: vscode.DiagnosticCollection;
	constructor (config: ConfigManager) {
		this.config = config;
		this.diagnostics = vscode.languages.createDiagnosticCollection (
			'jungleKit-style'
		);
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		// .clang-format은 워크스페이스 루트에 생성해야
		// VS Code의 formatOnSave와 CLI clang-format 모두 자동 감지한다.
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return;}

		const clangFormatPath = path.join (root, '.clang-format');
		const vscodeSetting = vscode.workspace.getConfiguration ('jungleKit');

		if (vscodeSetting.get<boolean> ('style.autoCreateClangFormat', true)) {
			// 매 활성화 시 강제 덮어쓰기 — 사용자 수정분도 최신 컨벤션으로 통일
			fs.writeFileSync (clangFormatPath, PINTOS_CLANG_FORMAT);
			console.log (
				'[Annotation] .clang-format 강제 동기화 (워크스페이스 루트)'
			);
		}

		// 기존 .jungle-kit/styles/ 에 있던 파일 → 루트로 마이그레이션
		const legacyPath = path.join (root, '.jungle-kit', 'styles', '.clang-format');
		if (fs.existsSync (legacyPath)) {
			try { fs.unlinkSync (legacyPath); } catch {}
			console.log ('[Annotation] 레거시 .jungle-kit/styles/.clang-format 제거');
		}

		// Ensure formatOnSave is enabled for C/C++ files
		// Use language-override sections in workspace settings
		const wsConfig = vscode.workspace.getConfiguration (undefined, null);
		const cOverride = wsConfig.get<Record<string, any>> ('[c]') || {};
		if (!cOverride['editor.formatOnSave']) {
			await wsConfig.update ('[c]', { ...cOverride, 'editor.formatOnSave': true },
				vscode.ConfigurationTarget.Workspace);
		}
		const cppOverride = wsConfig.get<Record<string, any>> ('[cpp]') || {};
		if (!cppOverride['editor.formatOnSave']) {
			await wsConfig.update ('[cpp]', { ...cppOverride, 'editor.formatOnSave': true },
				vscode.ConfigurationTarget.Workspace);
		}

		// Watch for file saves to run style check
		context.subscriptions.push (
			vscode.workspace.onDidSaveTextDocument ((doc) => {
				if (doc.languageId === 'c' || doc.languageId === 'cpp') {
					this.checkFile (doc);
				}
			})
		);

		context.subscriptions.push (this.diagnostics);
	}

	async checkCurrentFile (): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage ('No active file');
			return;
		}
		await this.checkFile (editor.document);
	}

	private async checkFile (doc: vscode.TextDocument): Promise<void> {
		if (doc.languageId !== 'c' && doc.languageId !== 'cpp') {
			return;
		}

		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		try {
			// 워크스페이스 루트의 .clang-format을 자동 감지하도록 cwd 설정
			await execAsync (
				`clang-format --dry-run --Werror "${doc.uri.fsPath}"`,
				{ cwd: root }
			);
			// No output = no violations
			this.diagnostics.set (doc.uri, []);
		} catch (error: any) {
			const output = error.stderr || error.stdout || '';
			const diags = this.parseClangFormatOutput (output, doc);
			this.diagnostics.set (doc.uri, diags);
		}
	}

	private parseClangFormatOutput (
		output: string,
		doc: vscode.TextDocument
	): vscode.Diagnostic[] {
		const diags: vscode.Diagnostic[] = [];
		const lines = output.split ('\n');
		// 어노테이션 블록 주석이 차지하는 줄 번호를 수집 (스타일 검사 제외 대상)
		const skipLines = new Set<number> ();
		const tagRe = /@(todo|bookmark|review|warn|breakpoint|note|region|endregion)\b/;
		for (let i = 0; i < doc.lineCount; i++) {
			const text = doc.lineAt (i).text;
			if (!tagRe.test (text)) { continue; }
			skipLines.add (i);
			// 블록 주석 시작이면 */ 까지 전부 제외
			if (/\/\*/.test (text) && !/\*\//.test (text)) {
				for (let j = i + 1; j < Math.min (i + 30, doc.lineCount); j++) {
					skipLines.add (j);
					if (/\*\//.test (doc.lineAt (j).text)) { break; }
				}
			}
		}

		for (const line of lines) {
			// clang-format warnings: filename:line:col: warning: ...
			const match = line.match (/:(\d+):(\d+):\s*(warning|error):\s*(.*)/);
			if (match) {
				const lineNum = parseInt (match[1]) - 1;
				// 어노테이션 태그가 있는 줄은 스타일 검사에서 제외
				if (skipLines.has (lineNum)) {
					continue;
				}
				const col = parseInt (match[2]) - 1;
				const severity =
					match[3] === 'error'
						? vscode.DiagnosticSeverity.Error
						: vscode.DiagnosticSeverity.Warning;
				const message = `[Style] ${match[4]}`;
				const range = new vscode.Range (lineNum, col, lineNum, col + 1);
				diags.push (new vscode.Diagnostic (range, message, severity));
			}
		}

		return diags;
	}
}
