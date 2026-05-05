import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitUtils, sanitizeRef } from '../utils/gitUtils';
import { ConfigManager } from '../utils/configManager';

const execFileAsync = promisify (execFile);

const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB

/**
 * Shadow Diff
 * Shows other team members' changes as visual overlays in the editor.
 *
 * Layers:
 * 1. Gutter markers — colored dots next to line numbers
 *    Blue: teammate modified this area. Red: conflict possible (same lines).
 * 2. CodeLens — shows above conflicting regions with teammate info
 * 3. Hover — shows inline diff when hovering over marked lines
 *
 * Integrates Pull Reminder functionality:
 * - Periodic background fetch
 * - Status bar ahead/behind indicator
 * - Auto pull/push via status bar click
 */

interface BranchChange {
	branch: string;
	author: string;
	file: string;
	hunks: Array<{ startLine: number; endLine: number; diff: string }>;
	lastCommitDate: string;
}

export class ShadowDiff implements vscode.CodeLensProvider {
	private git: GitUtils;
	private config: ConfigManager;
	private context!: vscode.ExtensionContext;
	private branchChanges: BranchChange[] = [];
	private fetchInterval: NodeJS.Timeout | undefined;

	private conflictDecoration!: vscode.TextEditorDecorationType;

	private _onDidChangeCodeLenses = new vscode.EventEmitter<void> ();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
	private _outputChannel: vscode.OutputChannel | null = null;
	private _disposed = false;

	constructor (config: ConfigManager, git: GitUtils) {
		this.config = config;
		this.git = git;
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		this.createDecorations ();
		this.registerCodeLens (context);
		this.registerHoverProvider (context);

		// Initial fetch and update
		await this.fetchAndAnalyze ();

		// Periodic background fetch
		const intervalMinutes = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<number> ('sync.intervalMinutes', 5);

		this.fetchInterval = setInterval (
			() => this.fetchAndAnalyze (),
			intervalMinutes * 60 * 1000
		);

		context.subscriptions.push ({
			dispose: () => {
				this._disposed = true;
				if (this.fetchInterval) {clearInterval (this.fetchInterval);}
				if (this._outputChannel) { this._outputChannel.dispose (); }
			},
		});

		// Update decorations when switching files
		context.subscriptions.push (
			vscode.window.onDidChangeActiveTextEditor (async (editor) => {
				if (editor) {await this.updateEditorDecorations (editor);}
			})
		);
	}

	async pullAndPush (): Promise<void> {
		try {
			const branch = await this.git.getCurrentBranch ();
			if (!branch) {
				vscode.window.showWarningMessage ('detached HEAD 상태에서는 동기화할 수 없습니다.');
				return;
			}

			const { behind } = await this.git.getAheadBehind (`origin/${branch}`);

			if (behind > 0) {
				await vscode.window.withProgress (
					{ location: vscode.ProgressLocation.Notification, title: 'Pull 중...' },
					async () => {
						const root = this.config.getWorkspaceRoot ();
						if (!root) { throw new Error ('워크스페이스가 열려있지 않습니다.'); }
						try {
							await execFileAsync ('git', ['pull', '--rebase'], { cwd: root, maxBuffer: MAX_BUFFER, timeout: 60000 });
						} catch (pullErr: any) {
							const msg = pullErr.stderr || pullErr.message || '';
							if (msg.includes ('CONFLICT') || msg.includes ('conflict')) {
								throw new Error ('rebase 충돌이 발생했습니다. 터미널에서 충돌을 해결한 후 `git rebase --continue` 또는 `git rebase --abort` 를 실행하세요.');
							}
							throw pullErr;
						}
					}
				);
				vscode.window.showInformationMessage ('Pull 완료');
			}

			const { ahead } = await this.git.getAheadBehind (`origin/${branch}`);
			if (ahead > 0) {
				await vscode.window.withProgress (
					{ location: vscode.ProgressLocation.Notification, title: 'Push 중...' },
					async () => {
						const root = this.config.getWorkspaceRoot ();
						if (!root) { throw new Error ('워크스페이스가 열려있지 않습니다.'); }
						await execFileAsync ('git', ['push', 'origin', sanitizeRef (branch)], { cwd: root, maxBuffer: MAX_BUFFER, timeout: 60000 });
					}
				);
				vscode.window.showInformationMessage ('Push 완료');
			}

			await this.fetchAndAnalyze ();
		} catch (err: any) {
			vscode.window.showErrorMessage (`동기화 실패: ${err.message}`);
		}
	}

	// --- Shadow Diff Core ---

	private _isFetching = false;
	private async fetchAndAnalyze (): Promise<void> {
		if (this._disposed || this._isFetching) { return; }
		this._isFetching = true;
		try {
			await this.git.fetch ();
			if (this._disposed) { return; }
			await this.analyzeRemoteBranches ();
			if (this._disposed) { return; }
			this.updateAllDecorations ();
			this._onDidChangeCodeLenses.fire ();
		} catch (err) {
			console.warn ('[Annotation] ShadowDiff fetch/analyze 실패:', err instanceof Error ? err.message : err);
		} finally {
			this._isFetching = false;
		}
	}

	private async analyzeRemoteBranches (): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return;}

		const currentBranch = await this.git.getCurrentBranch ();
		if (!currentBranch) {return;}

		// Get all remote branches
		const branches = await this.git.getAllBranches ();
		const remoteBranches = branches.filter (
			(b) => b.startsWith ('origin/') && !b.includes ('HEAD') && b !== `origin/${currentBranch}`
		);

		const newChanges: BranchChange[] = [];

		for (const remoteBranch of remoteBranches) {
			try {
				// Get diff between current branch and remote branch (only C/H files)
				const { stdout: diffOutput } = await execFileAsync (
					'git', ['diff', `${sanitizeRef (currentBranch)}...${sanitizeRef (remoteBranch)}`, '--', '*.c', '*.h'],
					{ cwd: root, maxBuffer: MAX_BUFFER }
				);

				if (!diffOutput.trim ()) {continue;}

				// Get author of the branch
				const { stdout: authorOutput } = await execFileAsync (
					'git', ['log', sanitizeRef (remoteBranch), '-1', '--format=%an'],
					{ cwd: root }
				);
				const author = authorOutput.trim ();

				// Get last commit date
				const { stdout: dateOutput } = await execFileAsync (
					'git', ['log', sanitizeRef (remoteBranch), '-1', '--format=%ar'],
					{ cwd: root }
				);

				// Parse hunks per file
				const fileChanges = this.parseDiffToHunks (diffOutput);

				for (const [file, hunks] of fileChanges.entries ()) {
					newChanges.push ({
						branch: remoteBranch.replace ('origin/', ''),
						author,
						file,
						hunks,
						lastCommitDate: dateOutput.trim (),
					});
				}
			} catch {
				// Skip branches that fail
			}
		}

		// 원자적 교체 — 분석 도중 읽기 측에서 부분 데이터 참조 방지
		this.branchChanges = newChanges;
	}

	private parseDiffToHunks (diff: string): Map<string, BranchChange['hunks']> {
		const result = new Map<string, BranchChange['hunks']> ();
		let currentFile = '';
		let currentHunk: { startLine: number; endLine: number; diff: string } | null = null;

		for (const line of diff.split ('\n')) {
			// Detect file header
			const fileMatch = line.match (/^diff --git a\/(.+) b\/(.+)/);
			if (fileMatch) {
				currentFile = fileMatch[2];
				if (!result.has (currentFile)) {
					result.set (currentFile, []);
				}
				continue;
			}

			// Detect hunk header
			const hunkMatch = line.match (/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
			if (hunkMatch && currentFile) {
				const startLine = parseInt (hunkMatch[1]) - 1;
				const lineCount = parseInt (hunkMatch[2] || '1');
				currentHunk = {
					startLine,
					endLine: startLine + lineCount - 1,
					diff: line + '\n',
				};
				result.get (currentFile)?.push (currentHunk);
				continue;
			}

			// Accumulate diff content
			if (currentHunk && (line.startsWith ('+') || line.startsWith ('-') || line.startsWith (' '))) {
				currentHunk.diff += line + '\n';
			}
		}

		return result;
	}

	// --- Decorations ---

	private createDecorations (): void {
		// Subtle background: conflict possible (same lines modified locally and remotely)
		this.conflictDecoration = vscode.window.createTextEditorDecorationType ({
			backgroundColor: 'rgba(244, 67, 54, 0.06)',
			isWholeLine: true,
			overviewRulerColor: 'rgba(244, 67, 54, 0.6)',
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		});

		this.context.subscriptions.push (this.conflictDecoration);
	}

	private async updateAllDecorations (): Promise<void> {
		if (vscode.window.activeTextEditor) {
			await this.updateEditorDecorations (vscode.window.activeTextEditor);
		}
	}

	private async updateEditorDecorations (editor: vscode.TextEditor): Promise<void> {
		const relativePath = vscode.workspace.asRelativePath (editor.document.uri);
		const fileChanges = this.branchChanges.filter ((c) => c.file === relativePath);

		const conflictRanges: vscode.DecorationOptions[] = [];
		// Check which lines in this file are locally modified (working tree + staged)
		const localModifiedLines = await this.getLocalModifiedLines (relativePath);

		for (const change of fileChanges) {
			for (const hunk of change.hunks) {
				for (let line = hunk.startLine; line <= hunk.endLine && line < editor.document.lineCount; line++) {
					const lineText = editor.document.lineAt (line).text;
					const hoverContent = new vscode.MarkdownString ();
					hoverContent.appendMarkdown (
						`**${change.author}** (${change.branch}, ${change.lastCommitDate})\n\n`
					);
					hoverContent.appendCodeblock (
						hunk.diff.substring (0, 500),
						'diff'
					);

					const decoration: vscode.DecorationOptions = {
						range: new vscode.Range (line, 0, line, lineText.length),
						hoverMessage: hoverContent,
					};

					// Check if this line is also locally modified
					if (localModifiedLines.has (line)) {
						conflictRanges.push (decoration);
					}
				}
			}
		}

		editor.setDecorations (this.conflictDecoration, conflictRanges);
	}

	private async getLocalModifiedLines (relativePath: string): Promise<Set<number>> {
		const lines = new Set<number> ();
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return lines;}

		try {
			// execFile로 호출하여 shell injection 방지 (파일 경로를 인자로 전달)
			const { stdout: stagedDiff } = await execFileAsync (
				'git', ['diff', '--cached', '-U0', '--', relativePath],
				{ cwd: root }
			).catch (() => ({ stdout: '' }));

			const { stdout: unstagedDiff } = await execFileAsync (
				'git', ['diff', '-U0', '--', relativePath],
				{ cwd: root }
			).catch (() => ({ stdout: '' }));

			const combinedDiff = stagedDiff + '\n' + unstagedDiff;

			// Parse hunk headers to extract locally modified line numbers
			for (const line of combinedDiff.split ('\n')) {
				const hunkMatch = line.match (/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
				if (hunkMatch) {
					const start = parseInt (hunkMatch[1]) - 1;
					const count = parseInt (hunkMatch[2] || '1');
					for (let i = start; i < start + count; i++) {
						lines.add (i);
					}
				}
			}
		} catch {
			// If git diff fails, return empty set (all changes treated as modified, not conflict)
		}

		return lines;
	}

	// --- CodeLens (conflict warnings above functions) ---

	private registerCodeLens (context: vscode.ExtensionContext): void {
		context.subscriptions.push (
			vscode.languages.registerCodeLensProvider (
				[{ language: 'c' }, { language: 'cpp' }],
				this
			)
		);
	}

	provideCodeLenses (document: vscode.TextDocument): vscode.CodeLens[] {
		const relativePath = vscode.workspace.asRelativePath (document.uri);
		const fileChanges = this.branchChanges.filter ((c) => c.file === relativePath);

		if (fileChanges.length === 0) {return [];}

		const lenses: vscode.CodeLens[] = [];
		const processedLines = new Set<number> ();

		for (const change of fileChanges) {
			for (const hunk of change.hunks) {
				// Only show CodeLens at the start of each hunk (avoid spam)
				if (processedLines.has (hunk.startLine)) {continue;}
				processedLines.add (hunk.startLine);

				if (hunk.startLine >= document.lineCount) {continue;}

				const range = new vscode.Range (hunk.startLine, 0, hunk.startLine, 0);
				lenses.push (new vscode.CodeLens (range, {
					title: `${change.author} (${change.branch}) -- ${change.lastCommitDate}`,
					command: 'jungleKit.showShadowDiff',
					arguments: [change, hunk],
				}));
			}
		}

		return lenses;
	}

	async showShadowDiff (change: BranchChange, hunk: BranchChange['hunks'][0]): Promise<void> {
		if (!this._outputChannel) {
			this._outputChannel = vscode.window.createOutputChannel ('Annotation: Shadow Diff');
		}
		const channel = this._outputChannel;
		channel.clear ();
		channel.appendLine (`Branch: ${change.branch}`);
		channel.appendLine (`Author: ${change.author}`);
		channel.appendLine (`File: ${change.file}`);
		channel.appendLine (`Lines: ${hunk.startLine + 1}-${hunk.endLine + 1}`);
		channel.appendLine ('---');
		channel.appendLine (hunk.diff);
		channel.show ();
	}

	// --- Hover Provider ---

	private registerHoverProvider (context: vscode.ExtensionContext): void {
		context.subscriptions.push (
			vscode.languages.registerHoverProvider (
				[{ language: 'c' }, { language: 'cpp' }],
				{
					provideHover: (document, position) => {
						return this.provideHover (document, position);
					},
				}
			)
		);
	}

	private provideHover (
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const relativePath = vscode.workspace.asRelativePath (document.uri);
		const line = position.line;

		const relevantChanges = this.branchChanges.filter ((c) =>
			c.file === relativePath &&
			c.hunks.some ((h) => line >= h.startLine && line <= h.endLine)
		);

		if (relevantChanges.length === 0) {return undefined;}

		const contents = new vscode.MarkdownString ();
		contents.isTrusted = true;

		for (const change of relevantChanges) {
			const hunk = change.hunks.find ((h) => line >= h.startLine && line <= h.endLine);
			if (!hunk) {continue;}

			contents.appendMarkdown (`**${change.author}** \`${change.branch}\` (${change.lastCommitDate})\n\n`);
			contents.appendCodeblock (hunk.diff.substring (0, 300), 'diff');
			contents.appendMarkdown ('\n---\n');
		}

		return new vscode.Hover (contents);
	}

}
