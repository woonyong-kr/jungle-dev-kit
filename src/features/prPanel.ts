import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GitUtils } from '../utils/gitUtils';
import { APIKeyManager } from '../utils/apiKeyManager';
import { ConfigManager, PR_DIFF_TRUNCATE_LIMIT } from '../utils/configManager';
import { TagSystem } from './tagSystem';

const execAsync = promisify (exec);

function escapeHtml (str: string): string {
	return str
		.replace (/&/g, '&amp;')
		.replace (/</g, '&lt;')
		.replace (/>/g, '&gt;')
		.replace (/"/g, '&quot;')
		.replace (/'/g, '&#039;');
}

/**
 * PR Panel
 * WebView-based PR creation panel.
 *
 * Features:
 * - AI-generated PR title and body from staged diff
 * - Collects @review tags from tags.json
 * - Reviewer selection from .jungle-kit/team.json
 * - One-click PR creation via `gh` CLI
 */
export class PRPanel {
	private git: GitUtils;
	private apiKeys: APIKeyManager;
	private config: ConfigManager;
	private tagSystem: TagSystem;

	constructor (git: GitUtils, apiKeys: APIKeyManager, config: ConfigManager, tagSystem: TagSystem) {
		this.git = git;
		this.apiKeys = apiKeys;
		this.config = config;
		this.tagSystem = tagSystem;
	}

	async openPanel (): Promise<void> {
		const panel = vscode.window.createWebviewPanel (
			'jungleKit.prPanel',
			'PR 만들기',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		// Gather data
		const currentBranch = await this.git.getCurrentBranch ();
		if (!currentBranch) {
			vscode.window.showErrorMessage ('detached HEAD 상태에서는 PR을 생성할 수 없습니다.');
			panel.dispose ();
			return;
		}

		// 로컬 + 리모트 브랜치에서 현재 브랜치를 제외
		const localBranches = await this.git.getLocalBranches ();
		const allBranches = await this.git.getAllBranches ();
		// 리모트 브랜치에서 "origin/" 접두어를 제거하고, HEAD 포인터 제외
		const remoteBranches = allBranches
			.filter ((b) => b.startsWith ('origin/') && !b.includes ('HEAD'))
			.map ((b) => b.replace (/^origin\//, ''));
		// 로컬 + 리모트 합치고 중복 제거, 현재 브랜치 제외
		const baseBranches = [...new Set ([...localBranches, ...remoteBranches])]
			.filter ((b) => b !== currentBranch);

		if (baseBranches.length === 0) {
			vscode.window.showErrorMessage ('PR 대상이 될 base 브랜치가 없습니다. 브랜치를 생성하거나 리모트를 fetch 하세요.');
			panel.dispose ();
			return;
		}

		const defaultBase = this.guessDefaultBase (baseBranches);

		const diff = await this.git.getStagedDiff () || await this.git.getDiffAgainst (defaultBase);
		const changedFiles = await this.git.getChangedFiles (defaultBase);
		const commits = await this.git.getRecentCommits (currentBranch, 10);
		const reviewTags = this.tagSystem.getReviewTags ();

		panel.webview.html = this.getWebviewContent (
			currentBranch,
			baseBranches,
			defaultBase,
			changedFiles,
			commits,
			reviewTags
		);

		// Handle messages from webview
		panel.webview.onDidReceiveMessage (async (message) => {
			switch (message.command) {
			case 'generateAI':
				await this.handleAIGenerate (panel, diff, currentBranch, changedFiles, commits, reviewTags);
				break;
			case 'createPR':
				await this.handleCreatePR (panel, message.data);
				break;
			case 'changeBase': {
				// base 브랜치가 바뀌면 diff와 파일 목록을 다시 계산
				const newBase = message.base as string;
				const newDiff = await this.git.getStagedDiff () || await this.git.getDiffAgainst (newBase);
				const newChangedFiles = await this.git.getChangedFiles (newBase);
				panel.webview.postMessage ({
					command: 'updateFiles',
					files: newChangedFiles,
				});
				// 내부 diff도 갱신 (AI 생성 시 사용)
				this._currentDiff = newDiff;
				this._currentChangedFiles = newChangedFiles;
				break;
			}
			}
		});

		// 내부 상태로 현재 diff/files 보관 (base 변경 시 갱신)
		this._currentDiff = diff;
		this._currentChangedFiles = changedFiles;
	}

	private _currentDiff: string | undefined;
	private _currentChangedFiles: Array<{ path: string; additions: number; deletions: number }> = [];

	/** 공통 base 브랜치 후보를 우선순위에 따라 추정 */
	private guessDefaultBase (branches: string[]): string {
		if (branches.length === 0) { return 'main'; }
		const preferred = ['dev', 'develop', 'main', 'master'];
		for (const name of preferred) {
			if (branches.includes (name)) { return name; }
		}
		return branches[0];
	}

	private async handleAIGenerate (
		panel: vscode.WebviewPanel,
		_diff: string,
		branch: string,
		_changedFiles: Array<{ path: string; additions: number; deletions: number }>,
		commits: Array<{ hash: string; message: string; author: string }>,
		reviewTags: Array<{ file: string; line: number; content: string }>
	): Promise<void> {
		// base 변경 시 갱신된 값 사용
		const diff = this._currentDiff ?? _diff;
		const changedFiles = this._currentChangedFiles.length > 0 ? this._currentChangedFiles : _changedFiles;
		const apiKey = await this.apiKeys.getKey ();
		if (!apiKey) {
			panel.webview.postMessage ({ command: 'error', text: 'API 키를 먼저 등록하세요.' });
			return;
		}

		try {
			let OpenAI: any;
			try {
				OpenAI = (await import ('openai')).default;
			} catch {
				panel.webview.postMessage ({ command: 'error', text: 'openai 모듈을 찾을 수 없습니다. 익스텐션을 재설치하세요.' });
				return;
			}
			const client = new OpenAI ({ apiKey });

			const model = vscode.workspace
				.getConfiguration ('jungleKit')
				.get<string> ('ai.model', 'gpt-4o-mini');

			// 컨텍스트 구성
			const filesSummary = changedFiles
				.map ((f) => `  ${f.path} (+${f.additions} -${f.deletions})`)
				.join ('\n');

			const commitsSummary = commits
				.map ((c) => `  ${c.hash.substring (0, 7)} ${c.message} (${c.author})`)
				.join ('\n');

			const reviewSummary = reviewTags.length > 0
				? reviewTags.map ((t) => `  ${t.file}:${t.line + 1} — ${t.content}`).join ('\n')
				: '  없음';

			const response = await client.chat.completions.create ({
				model,
				temperature: 0.3,
				max_tokens: 2000,
				messages: [
					{
						role: 'system',
						content: this.config.loadConventionFile ('pr-convention.md'),
					},
					{
						role: 'user',
						content: `브랜치: ${branch}

=== 변경 파일 ===
${filesSummary}

=== 커밋 로그 ===
${commitsSummary}

=== @review 포인트 ===
${reviewSummary}

=== Diff ===
${(diff || '').substring (0, PR_DIFF_TRUNCATE_LIMIT)}`,
					},
				],
			});

			const content = response.choices[0]?.message?.content || '';
			const titleMatch = content.match (/TITLE:\s*(.+)/);
			const bodyMatch = content.match (/BODY:\s*([\s\S]+)/);

			panel.webview.postMessage ({
				command: 'aiResult',
				title: titleMatch?.[1]?.trim () || branch,
				body: bodyMatch?.[1]?.trim () || content,
			});
		} catch (err: any) {
			panel.webview.postMessage ({
				command: 'error',
				text: `AI 생성 실패: ${err.message}`,
			});
		}
	}

	private async handleCreatePR (
		panel: vscode.WebviewPanel,
		data: { title: string; body: string; base: string; reviewers: string }
	): Promise<void> {
		const root = this.config.getWorkspaceRoot ();

		if (!root) {
			panel.webview.postMessage ({ command: 'error', text: '워크스페이스를 찾을 수 없습니다.' });
			return;
		}

		// Check if gh is installed — 없으면 GitHub Releases에서 바이너리 직접 설치
		try {
			await execAsync ('gh --version', { cwd: root });
		} catch {
			panel.webview.postMessage ({ command: 'status', text: 'GitHub CLI(gh) 설치 중...' });
			try {
				const installCmd = [
					'GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep \'"tag_name"\' | sed \'s/.*"v\\(.*\\)".*/\\1/\')',
					'curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" | tar xz -C /tmp',
					'sudo mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/',
					'rm -rf "/tmp/gh_${GH_VERSION}_linux_amd64"',
				].join (' && ');
				await execAsync (installCmd, { cwd: root, maxBuffer: 10 * 1024 * 1024, timeout: 120000 });
				await execAsync ('gh --version', { cwd: root });
				vscode.window.showInformationMessage ('[Annotation] GitHub CLI(gh) 자동 설치 완료');
			} catch {
				panel.webview.postMessage ({
					command: 'error',
					text: 'gh 자동 설치에 실패했습니다. 터미널에서 수동 설치:\ncurl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep tag_name 으로 버전 확인 후 바이너리를 다운로드하세요.',
				});
				return;
			}
		}

		// Check if gh is authenticated
		try {
			await execAsync ('gh auth status', { cwd: root });
		} catch (authErr: any) {
			panel.webview.postMessage ({
				command: 'error',
				text: 'GitHub CLI 인증이 필요합니다. 터미널에서 `gh auth login` 을 실행하세요.',
			});
			return;
		}

		// Check remote exists
		try {
			await execAsync ('git remote get-url origin', { cwd: root });
		} catch {
			panel.webview.postMessage ({
				command: 'error',
				text: 'git remote "origin"이 설정되어 있지 않습니다. `git remote add origin <URL>` 로 추가하세요.',
			});
			return;
		}

		// Push current branch first
		const branch = await this.git.getCurrentBranch ();
		if (!branch) {
			panel.webview.postMessage ({
				command: 'error',
				text: 'detached HEAD 상태에서는 PR을 생성할 수 없습니다.',
			});
			return;
		}

		try {
			const safeBranch = branch.replace (/[^a-zA-Z0-9_\-\/.]/g, '');
			// gh가 설치되어 있으면 credential helper로 등록 (HTTPS 인증 자동 처리)
			try { await execAsync ('gh auth setup-git', { cwd: root, timeout: 10000 }); } catch { /* 무시 */ }
			await execAsync (`git push -u origin ${safeBranch}`, { cwd: root, timeout: 30000 });
		} catch (pushErr: any) {
			const msg = pushErr.stderr || pushErr.message || '';
			// "Everything up-to-date" 는 정상 — 이미 푸시된 상태
			if (!msg.includes ('up-to-date') && !msg.includes ('up to date')) {
				panel.webview.postMessage ({
					command: 'error',
					text: `브랜치 푸시 실패: ${msg.trim ().split ('\n')[0]}`,
				});
				return;
			}
		}

		// Create PR
		const tempDir = path.join (root, '.jungle-kit');
		if (!fs.existsSync (tempDir)) {
			fs.mkdirSync (tempDir, { recursive: true });
		}
		const titleFile = path.join (tempDir, 'pr-title-temp.txt');
		const bodyFile = path.join (tempDir, 'pr-body-temp.md');
		try {
			// Write title and body to temp files to avoid all shell injection
			fs.writeFileSync (titleFile, data.title);
			fs.writeFileSync (bodyFile, data.body);

			// Read title from file via subshell to avoid shell metacharacter issues
			const safeTitle = fs.readFileSync (titleFile, 'utf-8').trim ()
				.replace (/'/g, "'\\''");
			const safeBase = data.base.replace (/[^a-zA-Z0-9_\-\/\.]/g, '');

			let cmd = `gh pr create --title '${safeTitle}' --body-file "${bodyFile}" --base "${safeBase}"`;
			if (data.reviewers.trim ()) {
				const safeReviewers = data.reviewers.trim ().replace (/[^a-zA-Z0-9_\-,]/g, '');
				cmd += ` --reviewer "${safeReviewers}"`;
			}

			const { stdout } = await execAsync (cmd, { cwd: root, timeout: 30000 });
			const prUrl = stdout.trim ();

			panel.webview.postMessage ({
				command: 'success',
				text: `PR이 생성되었습니다: ${prUrl}`,
				url: prUrl,
			});

			vscode.window.showInformationMessage (`PR 생성 완료: ${prUrl}`);
		} catch (err: any) {
			const stderr = err.stderr || err.message || '';
			let userMsg = 'PR 생성 실패';
			if (stderr.includes ('already exists')) {
				userMsg = '이 브랜치에 이미 열린 PR이 있습니다.';
			} else if (stderr.includes ('not a git repository')) {
				userMsg = '현재 디렉토리가 git 저장소가 아닙니다.';
			} else if (stderr.includes ('could not find')) {
				userMsg = `base 브랜치 "${data.base}"를 찾을 수 없습니다. 리모트에 존재하는지 확인하세요.`;
			} else {
				userMsg = `PR 생성 실패: ${stderr.trim ().split ('\n')[0] || err.message}`;
			}
			panel.webview.postMessage ({
				command: 'error',
				text: userMsg,
			});
		} finally {
			// Cleanup temp files (성공·실패 모두)
			try {fs.unlinkSync (titleFile);} catch {}
			try {fs.unlinkSync (bodyFile);} catch {}
		}
	}

	private getWebviewContent (
		branch: string,
		baseBranches: string[],
		defaultBase: string,
		changedFiles: Array<{ path: string; additions: number; deletions: number }>,
		commits: Array<{ hash: string; message: string; author: string; date: string }>,
		reviewTags: Array<{ file: string; line: number; content: string }>
	): string {
		const totalAdditions = changedFiles.reduce ((sum, f) => sum + f.additions, 0);
		const totalDeletions = changedFiles.reduce ((sum, f) => sum + f.deletions, 0);

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	* { box-sizing: border-box; margin: 0; padding: 0; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 0;
		line-height: 1.5;
	}

	/* ── Header ── */
	.header {
		padding: 20px 24px 16px;
		background: var(--vscode-sideBar-background);
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.header-top {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: 14px;
	}
	.header-title {
		display: flex; align-items: center; gap: 10px;
	}
	.header-title h1 {
		font-size: 15px; font-weight: 700; letter-spacing: -0.2px;
	}
	.header-title .icon {
		width: 28px; height: 28px; border-radius: 6px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; font-weight: 700;
	}
	.branch-flow {
		display: flex; align-items: center; gap: 8px;
		padding: 8px 12px;
		background: var(--vscode-editor-background);
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
	}
	.branch-tag {
		font-size: 11px; padding: 3px 10px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-radius: 4px;
		font-family: var(--vscode-editor-font-family, monospace);
		font-weight: 500;
	}
	.branch-arrow {
		color: var(--vscode-descriptionForeground);
		font-size: 13px; opacity: 0.6;
	}
	.base-select {
		width: auto !important; padding: 3px 8px !important;
		font-size: 11px !important; border-radius: 4px !important;
		font-family: var(--vscode-editor-font-family, monospace) !important;
		font-weight: 500 !important;
	}
	.diff-summary {
		display: flex; gap: 12px; font-size: 11px;
		color: var(--vscode-descriptionForeground);
		margin-left: auto; padding-left: 16px;
	}
	.diff-summary .add { color: #4EC9B0; font-weight: 600; }
	.diff-summary .del { color: #F14C4C; font-weight: 600; }
	.diff-summary .files { opacity: 0.8; }

	/* ── Main Content ── */
	.content { padding: 20px 24px; }

	/* ── Form ── */
	.form-group { margin-bottom: 18px; }
	.form-label {
		display: flex; align-items: center; gap: 6px;
		font-size: 11px; font-weight: 600;
		color: var(--vscode-descriptionForeground);
		text-transform: uppercase; letter-spacing: 0.8px;
		margin-bottom: 6px;
	}
	.form-label .required {
		color: var(--vscode-errorForeground, #F44336);
		font-size: 10px;
	}

	input, textarea, select {
		width: 100%; padding: 8px 12px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
		border-radius: 6px; outline: none;
		transition: border-color 0.15s, box-shadow 0.15s;
	}
	input:focus, textarea:focus, select:focus {
		border-color: var(--vscode-focusBorder);
		box-shadow: 0 0 0 1px var(--vscode-focusBorder);
	}
	textarea {
		min-height: 220px; resize: vertical;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12px; line-height: 1.7;
	}
	input:disabled { opacity: 0.5; cursor: not-allowed; }

	/* ── Title Row with AI Button ── */
	.title-row {
		display: flex; gap: 8px; align-items: stretch;
	}
	.title-row input { flex: 1; }

	/* ── Buttons ── */
	.btn {
		display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		padding: 8px 16px; font-size: 12px; font-weight: 600;
		border: none; border-radius: 6px; cursor: pointer;
		white-space: nowrap; transition: all 0.15s;
		letter-spacing: 0.2px;
	}
	.btn:hover { filter: brightness(1.12); }
	.btn:active { transform: scale(0.97); }

	.btn-ai {
		background: linear-gradient(135deg,
			var(--vscode-button-background),
			color-mix(in srgb, var(--vscode-button-background) 70%, #a855f7)
		);
		color: var(--vscode-button-foreground);
		padding: 8px 18px; font-size: 12px;
		box-shadow: 0 1px 4px rgba(0,0,0,0.15);
	}
	.btn-ai:hover {
		box-shadow: 0 2px 8px rgba(0,0,0,0.25);
		filter: brightness(1.08);
	}
	.btn-ai .spark { font-size: 13px; }

	.btn-create {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		padding: 10px 28px; font-size: 13px; font-weight: 700;
		border-radius: 6px;
		box-shadow: 0 1px 3px rgba(0,0,0,0.12);
	}
	.btn-create:hover {
		box-shadow: 0 2px 6px rgba(0,0,0,0.2);
	}

	/* ── Loading ── */
	.loading {
		display: none; align-items: center; gap: 8px;
		margin-top: 8px; padding: 8px 12px;
		background: var(--vscode-sideBar-background);
		border-radius: 6px;
		font-size: 11px; color: var(--vscode-descriptionForeground);
	}
	.loading.active { display: inline-flex; }
	.spinner {
		width: 14px; height: 14px;
		border: 2px solid var(--vscode-descriptionForeground);
		border-top-color: var(--vscode-button-background);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── Collapsible Sections ── */
	.panels { margin-top: 4px; }
	.section {
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px; margin-bottom: 8px;
		overflow: hidden;
	}
	.section-header {
		display: flex; align-items: center; gap: 8px;
		padding: 9px 14px; cursor: pointer;
		background: var(--vscode-sideBar-background);
		font-size: 11px; font-weight: 600;
		color: var(--vscode-descriptionForeground);
		text-transform: uppercase; letter-spacing: 0.5px;
		user-select: none;
		transition: background 0.1s;
	}
	.section-header:hover { background: var(--vscode-list-hoverBackground); }
	.section-header .badge {
		font-size: 10px; padding: 1px 7px; margin-left: auto;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-radius: 10px; font-weight: 500;
	}
	.section-body { padding: 0; max-height: 220px; overflow-y: auto; }
	.section.collapsed .section-body { display: none; }
	.section-header .chevron {
		transition: transform 0.2s ease; font-size: 10px;
		opacity: 0.6;
	}
	.section.collapsed .chevron { transform: rotate(-90deg); }

	/* ── File List ── */
	.file-item {
		display: flex; align-items: center;
		padding: 6px 14px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		font-family: var(--vscode-editor-font-family, monospace);
		gap: 8px;
		transition: background 0.1s;
	}
	.file-item:first-child { border-top: none; }
	.file-item:hover { background: var(--vscode-list-hoverBackground); }
	.file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.file-path .dir { opacity: 0.5; }
	.file-stats {
		display: flex; gap: 4px; flex-shrink: 0; font-size: 11px; font-weight: 500;
	}
	.file-stats .add { color: #4EC9B0; }
	.file-stats .del { color: #F14C4C; }
	.stat-bar {
		display: flex; gap: 1px; align-items: center;
		margin-left: 6px; flex-shrink: 0;
	}
	.stat-bar span {
		width: 4px; height: 10px; border-radius: 1px;
		background: var(--vscode-panel-border);
	}
	.stat-bar .bar-add { background: #4EC9B0; }
	.stat-bar .bar-del { background: #F14C4C; }

	/* ── Commit List ── */
	.commit-item {
		display: flex; align-items: baseline; gap: 10px;
		padding: 7px 14px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		transition: background 0.1s;
	}
	.commit-item:first-child { border-top: none; }
	.commit-item:hover { background: var(--vscode-list-hoverBackground); }
	.commit-hash {
		font-family: var(--vscode-editor-font-family, monospace);
		color: var(--vscode-textLink-foreground);
		font-size: 11px; flex-shrink: 0;
		font-weight: 500;
	}
	.commit-msg { flex: 1; }
	.commit-author {
		color: var(--vscode-descriptionForeground);
		font-size: 10px; flex-shrink: 0; font-style: italic;
	}

	/* ── Review Tags ── */
	.review-item {
		display: flex; align-items: baseline; gap: 10px;
		padding: 7px 14px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		transition: background 0.1s;
	}
	.review-item:first-child { border-top: none; }
	.review-item:hover { background: var(--vscode-list-hoverBackground); }
	.review-marker {
		flex-shrink: 0; font-size: 11px;
	}
	.review-loc {
		color: var(--vscode-textLink-foreground);
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px; flex-shrink: 0; font-weight: 500;
	}
	.review-content { flex: 1; opacity: 0.9; }

	/* ── Divider ── */
	.divider {
		height: 1px;
		background: var(--vscode-panel-border);
		margin: 8px 0 18px;
	}

	/* ── Footer ── */
	.footer {
		padding: 16px 24px;
		border-top: 1px solid var(--vscode-panel-border);
		background: var(--vscode-sideBar-background);
		display: flex; align-items: center; justify-content: flex-end; gap: 12px;
	}

	/* ── Messages ── */
	#messageArea { padding: 0 24px; }
	.message {
		margin: 12px 0; padding: 10px 14px;
		border-radius: 6px; font-size: 12px;
		display: flex; align-items: center; gap: 8px;
		animation: slideIn 0.2s ease;
	}
	@keyframes slideIn {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.msg-icon { font-size: 14px; flex-shrink: 0; }
	.error {
		background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.08));
		border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(244,67,54,0.3));
		color: var(--vscode-errorForeground, #F44336);
	}
	.success {
		background: rgba(76,175,80,0.08);
		border: 1px solid rgba(76,175,80,0.2);
		color: #4CAF50;
	}
	.success a {
		color: var(--vscode-textLink-foreground);
		text-decoration: underline;
	}
</style>
</head>
<body>
	<!-- Header -->
	<div class="header">
		<div class="header-top">
			<div class="header-title">
				<div class="icon">PR</div>
				<h1>Pull Request</h1>
			</div>
		</div>
		<div class="branch-flow">
			<span class="branch-tag">${escapeHtml (branch)}</span>
			<span class="branch-arrow">&rarr;</span>
			<select id="base" class="base-select" onchange="onBaseChange()">
				${baseBranches.map ((b) =>
					`<option value="${escapeHtml (b)}"${b === defaultBase ? ' selected' : ''}>${escapeHtml (b)}</option>`
				).join ('')}
			</select>
			<div class="diff-summary">
				<span class="files">${changedFiles.length} files</span>
				<span class="add">+${totalAdditions}</span>
				<span class="del">&minus;${totalDeletions}</span>
			</div>
		</div>
	</div>

	<div id="messageArea"></div>

	<div class="content">
		<!-- Title -->
		<div class="form-group">
			<label class="form-label">Title <span class="required">*</span></label>
			<div class="title-row">
				<input type="text" id="title" placeholder="feat: 변경 내용을 간결하게 작성" />
				<button class="btn btn-ai" onclick="generateAI()">
					<span class="spark">&#10023;</span> AI 생성
				</button>
			</div>
			<div class="loading" id="loading">
				<div class="spinner"></div>
				<span>diff 분석 중...</span>
			</div>
		</div>

		<!-- Body -->
		<div class="form-group">
			<label class="form-label">Description</label>
			<textarea id="body" placeholder="## 변경 개요&#10;&#10;## 주요 변경&#10;- [파일] 함수 — 변경 내용&#10;&#10;## 배경&#10;&#10;## 리뷰 포인트&#10;- ⚠️ 파일:라인 — 이슈&#10;&#10;## 검증"></textarea>
		</div>

		<div class="divider"></div>

		<!-- Panels: Files / Commits / Reviews -->
		<div class="panels">
			<div class="section" id="filesSection">
				<div class="section-header" onclick="toggleSection('filesSection')">
					<span class="chevron">&#9660;</span>
					<span>Changed Files</span>
					<span class="badge">${changedFiles.length}</span>
				</div>
				<div class="section-body">
					${changedFiles.map ((f) => {
						const parts = f.path.split ('/');
						const fileName = parts.pop ();
						const dir = parts.length > 0 ? parts.join ('/') + '/' : '';
						const total = f.additions + f.deletions;
						const maxBars = 5;
						const addBars = total > 0 ? Math.round ((f.additions / total) * maxBars) : 0;
						const delBars = total > 0 ? maxBars - addBars : 0;
						const bars = '<span class="bar-add"></span>'.repeat (addBars) + '<span class="bar-del"></span>'.repeat (delBars);
						return '<div class="file-item">'
							+ '<span class="file-path"><span class="dir">' + escapeHtml (dir) + '</span>' + escapeHtml (fileName || '') + '</span>'
							+ '<span class="file-stats"><span class="add">+' + f.additions + '</span><span class="del">-' + f.deletions + '</span></span>'
							+ '<span class="stat-bar">' + bars + '</span>'
							+ '</div>';
					}).join ('')}
				</div>
			</div>

			<div class="section" id="commitsSection">
				<div class="section-header" onclick="toggleSection('commitsSection')">
					<span class="chevron">&#9660;</span>
					<span>Commits</span>
					<span class="badge">${commits.length}</span>
				</div>
				<div class="section-body">
					${commits.length > 0
						? commits.map ((c) =>
							'<div class="commit-item">'
							+ '<span class="commit-hash">' + escapeHtml (c.hash.substring (0, 7)) + '</span>'
							+ '<span class="commit-msg">' + escapeHtml (c.message) + '</span>'
							+ '<span class="commit-author">' + escapeHtml (c.author) + '</span>'
							+ '</div>'
						).join ('')
						: '<div class="commit-item" style="color:var(--vscode-descriptionForeground);justify-content:center;">No commits</div>'}
				</div>
			</div>

			${reviewTags.length > 0 ? `
			<div class="section" id="reviewSection">
				<div class="section-header" onclick="toggleSection('reviewSection')">
					<span class="chevron">&#9660;</span>
					<span>Review Points</span>
					<span class="badge">${reviewTags.length}</span>
				</div>
				<div class="section-body">
					${reviewTags.map ((t) =>
						'<div class="review-item">'
						+ '<span class="review-marker">&#9888;&#65039;</span>'
						+ '<span class="review-loc">' + escapeHtml (t.file) + ':' + (t.line + 1) + '</span>'
						+ '<span class="review-content">' + escapeHtml (t.content) + '</span>'
						+ '</div>'
					).join ('')}
				</div>
			</div>` : ''}
		</div>

		<div class="divider"></div>

		<!-- Reviewers -->
		<div class="form-group">
			<label class="form-label">Reviewers</label>
			<input type="text" id="reviewers" placeholder="GitHub username (comma separated)" />
		</div>
	</div>

	<!-- Footer -->
	<div class="footer">
		<button class="btn btn-create" onclick="createPR()">PR 만들기</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function esc(s) {
			const d = document.createElement('div');
			d.textContent = s;
			return d.innerHTML;
		}

		function toggleSection(id) {
			document.getElementById(id).classList.toggle('collapsed');
		}

		function updateFileList(files) {
			const section = document.getElementById('filesSection');
			if (!section) return;
			const badge = section.querySelector('.badge');
			if (badge) badge.textContent = files.length;
			const body = section.querySelector('.section-body');
			if (!body) return;
			let totalAdd = 0, totalDel = 0;
			body.innerHTML = files.map(function(f) {
				totalAdd += f.additions;
				totalDel += f.deletions;
				const parts = f.path.split('/');
				const fileName = parts.pop() || '';
				const dir = parts.length > 0 ? parts.join('/') + '/' : '';
				const total = f.additions + f.deletions;
				const maxBars = 5;
				const addBars = total > 0 ? Math.round((f.additions / total) * maxBars) : 0;
				const delBars = total > 0 ? maxBars - addBars : 0;
				let bars = '';
				for (let i = 0; i < addBars; i++) bars += '<span class="bar-add"></span>';
				for (let i = 0; i < delBars; i++) bars += '<span class="bar-del"></span>';
				return '<div class="file-item">'
					+ '<span class="file-path"><span class="dir">' + esc(dir) + '</span>' + esc(fileName) + '</span>'
					+ '<span class="file-stats"><span class="add">+' + f.additions + '</span><span class="del">-' + f.deletions + '</span></span>'
					+ '<span class="stat-bar">' + bars + '</span>'
					+ '</div>';
			}).join('');
			// diff summary 갱신
			const summary = document.querySelector('.diff-summary');
			if (summary) {
				summary.innerHTML = '<span class="files">' + files.length + ' files</span>'
					+ '<span class="add">+' + totalAdd + '</span>'
					+ '<span class="del">&minus;' + totalDel + '</span>';
			}
		}

		function onBaseChange() {
			const base = document.getElementById('base').value;
			vscode.postMessage({ command: 'changeBase', base: base });
		}

		function generateAI() {
			document.getElementById('loading').classList.add('active');
			document.getElementById('messageArea').innerHTML = '';
			vscode.postMessage({ command: 'generateAI' });
		}

		function createPR() {
			const title = document.getElementById('title').value;
			if (!title.trim()) {
				document.getElementById('messageArea').innerHTML =
					'<div class="message error"><span class="msg-icon">&#10060;</span> 제목을 입력하세요.</div>';
				return;
			}
			vscode.postMessage({
				command: 'createPR',
				data: {
					title: title,
					body: document.getElementById('body').value,
					base: document.getElementById('base').value,
					reviewers: document.getElementById('reviewers').value,
				}
			});
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			const area = document.getElementById('messageArea');
			const loading = document.getElementById('loading');
			loading.classList.remove('active');

			switch (msg.command) {
				case 'aiResult':
					document.getElementById('title').value = msg.title;
					document.getElementById('body').value = msg.body;
					area.innerHTML = '<div class="message success"><span class="msg-icon">&#10003;</span> AI 생성 완료</div>';
					setTimeout(() => { area.innerHTML = ''; }, 3000);
					break;
				case 'error':
					area.innerHTML = '<div class="message error"><span class="msg-icon">&#10060;</span> ' + esc(msg.text) + '</div>';
					break;
				case 'success':
					area.innerHTML = '<div class="message success"><span class="msg-icon">&#10003;</span> ' + esc(msg.text) + '</div>';
					break;
				case 'updateFiles':
					// base 브랜치 변경 시 파일 목록과 통계를 갱신
					updateFileList(msg.files);
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}
