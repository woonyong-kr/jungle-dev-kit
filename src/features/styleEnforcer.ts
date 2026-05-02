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
	private clangFormatPath: string = '';

	constructor (config: ConfigManager) {
		this.config = config;
		this.diagnostics = vscode.languages.createDiagnosticCollection (
			'jungleKit-style'
		);
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		// Store .clang-format in .jungle-kit/styles/ (not workspace root)
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return;}

		const stylesDir = path.join (root, '.jungle-kit', 'styles');
		const clangFormatPath = path.join (stylesDir, '.clang-format');
		const vscodeSetting = vscode.workspace.getConfiguration ('jungleKit');

		if (
			vscodeSetting.get<boolean> ('style.autoCreateClangFormat', true) &&
			!fs.existsSync (clangFormatPath)
		) {
			if (!fs.existsSync (stylesDir)) {
				fs.mkdirSync (stylesDir, { recursive: true });
			}
			fs.writeFileSync (clangFormatPath, PINTOS_CLANG_FORMAT);
			console.log (
				'[Annotation] .jungle-kit/styles/.clang-format 생성'
			);
		}
		this.clangFormatPath = clangFormatPath;

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

		try {
			const styleFlag = this.clangFormatPath
				? `--style=file:${this.clangFormatPath}`
				: '';
			await execAsync (
				`clang-format --dry-run --Werror ${styleFlag} "${doc.uri.fsPath}"`,
				{ cwd: this.config.getWorkspaceRoot () }
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

		for (const line of lines) {
			// clang-format warnings: filename:line:col: warning: ...
			const match = line.match (/:(\d+):(\d+):\s*(warning|error):\s*(.*)/);
			if (match) {
				const lineNum = parseInt (match[1]) - 1;
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
