import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DiffFile, GitUtils } from '../utils/gitUtils';
import { APIKeyManager } from '../utils/apiKeyManager';
import { ConfigManager, PR_DIFF_TRUNCATE_LIMIT } from '../utils/configManager';
import { GitHubPrClient } from '../utils/githubPrClient';
import { TagSystem } from './tagSystem';

const execFileAsync = promisify (execFile);

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
 * - Reviewer selection from .annotation/team.json
 * - One-click PR creation via GitHub API
 */
export class PRPanel {
	private git: GitUtils;
	private apiKeys: APIKeyManager;
	private config: ConfigManager;
	private tagSystem: TagSystem;
	private _isCreatingPR = false;
	private _panel: vscode.WebviewPanel | null = null;
	private _panelState: { diff?: string; changedFiles: DiffFile[] } = { changedFiles: [] };

	constructor (git: GitUtils, apiKeys: APIKeyManager, config: ConfigManager, tagSystem: TagSystem) {
		this.git = git;
		this.apiKeys = apiKeys;
		this.config = config;
		this.tagSystem = tagSystem;
	}

	async openPanel (): Promise<void> {
		// 토글: 이미 열려있으면 닫기
		if (this._panel) {
			this._panel.dispose ();
			return;
		}

		const panel = vscode.window.createWebviewPanel (
			'jungleKit.prPanel',
			'PR 만들기',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this._panel = panel;

		// 패널 닫힐 때 참조 정리
		panel.onDidDispose (() => {
			this._panel = null;
		});

		try {
		// Gather data
		const currentBranch = await this.git.getCurrentBranch ();
		if (!this._panel) { return; } // 비동기 중 패널 닫힘 방어
		if (!currentBranch) {
			vscode.window.showErrorMessage ('detached HEAD 상태에서는 PR을 생성할 수 없습니다.');
			panel.dispose ();
			return;
		}

		// 로컬 + 리모트 브랜치에서 현재 브랜치를 제외
		const localBranches = await this.git.getLocalBranches ();
		if (!this._panel) { return; }
		const allBranches = await this.git.getAllBranches ();
		if (!this._panel) { return; }
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
		if (!this._panel) { return; }
		const changedFiles = await this.git.getChangedFiles (defaultBase);
		if (!this._panel) { return; }
		const commits = await this.git.getRecentCommits (currentBranch, 10);
		if (!this._panel) { return; }
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
			try {
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
				if (!this._panel) { break; }
				const newChangedFiles = await this.git.getChangedFiles (newBase);
				if (!this._panel) { break; }
				panel.webview.postMessage ({
					command: 'updateFiles',
					files: newChangedFiles,
				});
				this.setPanelState (newDiff, newChangedFiles);
				break;
			}
			}
			} catch (e: any) {
				console.error ('[Annotation] PR panel message handler error:', e);
				try {
					panel.webview.postMessage ({
						command: 'error',
						text: `예기치 않은 오류: ${e.message || e}`,
					});
				} catch { /* panel disposed */ }
			}
		});

		this.setPanelState (diff, changedFiles);

		// 기존 PR 자동 감지 — 패널 열자마자 이미 PR이 있으면 알림
		this.checkExistingPR (panel);
		} catch (err: any) {
			console.error ('[Annotation] PR panel open failed:', err);
			vscode.window.showErrorMessage (`[Annotation] PR 패널 로드 실패: ${err.message || err}`);
			try { panel.dispose (); } catch { /* already disposed */ }
		}
	}

	/** 현재 브랜치에 이미 열린 PR이 있는지 확인하여 WebView에 알림 */
	private async checkExistingPR (panel: vscode.WebviewPanel): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }
		try {
			const client = await GitHubPrClient.resolve (root);
			const branch = await this.git.getCurrentBranch ();
			if (!client || !client.hasToken || !branch) { return; }
			panel.webview.postMessage ({ command: 'status', text: '기존 PR 확인 중...' });
			const existingPr = await client.findExistingPullRequest (branch);
			if (!this._panel || !existingPr) { return; }
			if (existingPr.state === 'open' && existingPr.html_url) {
				panel.webview.postMessage ({
					command: 'existingPR',
					url: existingPr.html_url,
					title: existingPr.title || '',
				});
			}
		} catch (err: any) {
			console.log ('[Annotation] checkExistingPR skipped:', err?.message || 'api not available');
		}
	}

	private setPanelState (diff: string | undefined, changedFiles: DiffFile[]): void {
		this._panelState = { diff, changedFiles };
	}

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
		_changedFiles: DiffFile[],
		commits: Array<{ hash: string; message: string; author: string }>,
		reviewTags: Array<{ file: string; line: number; content: string }>
	): Promise<void> {
		const diff = this._panelState.diff ?? _diff;
		const changedFiles = this._panelState.changedFiles.length > 0 ? this._panelState.changedFiles : _changedFiles;
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
			panel.webview.postMessage ({ command: 'status', text: '변경 파일 분석 중...' });
			const filesSummary = changedFiles
				.map ((f) => `  ${f.path} (+${f.additions} -${f.deletions})`)
				.join ('\n');

			const commitsSummary = commits
				.map ((c) => `  ${c.hash.substring (0, 7)} ${c.message} (${c.author})`)
				.join ('\n');

			const reviewSummary = reviewTags.length > 0
				? reviewTags.map ((t) => `  ${t.file}:${t.line + 1} — ${t.content}`).join ('\n')
				: '  없음';
			const promptSections = [
				`브랜치: ${branch}`,
				'',
				'=== 변경 파일 ===',
				filesSummary,
				'',
				'=== 커밋 로그 ===',
				commitsSummary,
				'',
				'=== @review 포인트 ===',
				reviewSummary,
				'',
				'=== Diff ===',
				this.truncateDiffSmart (diff || '', PR_DIFF_TRUNCATE_LIMIT),
			].filter ((section) => section && section.trim ().length > 0);

			panel.webview.postMessage ({ command: 'status', text: 'AI로 PR 내용 생성 중...' });
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
						content: promptSections.join ('\n'),
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
				text: `AI 생성 실패: ${err instanceof Error ? err.message : String (err)}`,
			});
		}
	}

	/** diff를 파일 단위로 분할하여 한도 내에서 균등 배분 */
	private truncateDiffSmart (diff: string, limit: number): string {
		if (diff.length <= limit) { return diff; }

		// "diff --git" 기준으로 파일별 분할
		const chunks = diff.split (/(?=^diff --git )/m);
		if (chunks.length <= 1) { return diff.substring (0, limit); }

		// 1차: 파일당 균등 할당량 계산
		const perFile = Math.floor (limit / chunks.length);
		if (perFile <= 0) { return diff.substring (0, limit); }
		const result: string[] = [];
		let used = 0;

		for (const chunk of chunks) {
			if (used >= limit) { break; }
			const remaining = limit - used;
			if (chunk.length <= perFile && chunk.length <= remaining) {
				// 할당량 내에 들어오면 전체 포함
				result.push (chunk);
				used += chunk.length;
			} else {
				// 초과 시 헤더 보존 + body 절삭
				const budget = Math.min (perFile, remaining);
				const lines = chunk.split ('\n');
				const header = lines.slice (0, 5).join ('\n');
				const body = lines.slice (5).join ('\n');
				const allowed = Math.max (budget - header.length - 20, 0);
				const truncated = header + '\n' + body.substring (0, allowed) + '\n... (truncated)';
				result.push (truncated);
				used += truncated.length;
			}
		}

		return result.join ('');
	}

	private async handleCreatePR (
		panel: vscode.WebviewPanel,
		data: { title: string; body: string; base: string; reviewers: string }
	): Promise<void> {
		if (this._isCreatingPR) {
			panel.webview.postMessage ({ command: 'status', text: 'PR 생성이 이미 진행 중입니다...' });
			return;
		}
		this._isCreatingPR = true;
		try {
		const root = this.config.getWorkspaceRoot ();

		if (!root) {
			panel.webview.postMessage ({ command: 'error', text: '워크스페이스를 찾을 수 없습니다.' });
			return;
		}

		const client = await GitHubPrClient.resolve (root);
		if (!client) {
			panel.webview.postMessage ({
				command: 'error',
				text: 'GitHub origin remote를 해석할 수 없습니다. GitHub remote 또는 인증 토큰을 확인하세요.',
			});
			return;
		}
		if (!client.hasToken) {
			panel.webview.postMessage ({
				command: 'error',
				text: 'GitHub API 토큰을 찾을 수 없습니다. HTTPS remote, GH_TOKEN/GITHUB_TOKEN, 또는 git credential helper를 확인하세요.',
			});
			return;
		}

		// Push current branch first
		panel.webview.postMessage ({ command: 'status', text: '브랜치 푸시 중...' });
		const branch = await this.git.getCurrentBranch ();
		if (!branch) {
			panel.webview.postMessage ({
				command: 'error',
				text: 'detached HEAD 상태에서는 PR을 생성할 수 없습니다.',
			});
			return;
		}

		try {
			const safeBranch = branch.replace (/[^a-zA-Z0-9_./-]/g, '');
			if (safeBranch !== branch) {
				panel.webview.postMessage ({
					command: 'error',
					text: `브랜치 이름에 허용되지 않는 문자가 포함되어 있습니다: "${branch}"`,
				});
				return;
			}
			await execFileAsync ('git', ['push', '-u', 'origin', safeBranch], { cwd: root, timeout: 30000 });
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
		panel.webview.postMessage ({ command: 'status', text: 'PR 생성 중...' });
		try {
			const title = data.title.trim ();
			const body = data.body;
			const safeBase = data.base.replace (/[^a-zA-Z0-9_./-]/g, '');
			const reviewers = data.reviewers
				.split (',')
				.map ((reviewer) => reviewer.trim ())
				.filter ((reviewer) => /^[a-zA-Z0-9_-]+$/.test (reviewer));

			const existingPr = await client.findExistingPullRequest (branch);
			if (existingPr?.html_url) {
				panel.webview.postMessage ({
					command: 'success',
					text: `이미 열린 PR이 있습니다: ${existingPr.html_url}\n새 커밋을 push하면 PR이 자동 업데이트됩니다.`,
					url: existingPr.html_url,
				});
				return;
			}

			const createdPr = await client.createPullRequest ({
				title,
				body,
				head: branch,
				base: safeBase,
			});

			if (reviewers.length > 0) {
				await client.requestPullRequestReviewers (createdPr.number, reviewers);
			}

			const prUrl = createdPr.html_url;

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
				userMsg = '이 브랜치에 이미 열린 PR이 있습니다. 새 커밋을 push하면 자동 반영됩니다.';
			} else if (stderr.includes ('could not find')) {
				userMsg = `base 브랜치 "${data.base}"를 찾을 수 없습니다. 리모트에 존재하는지 확인하세요.`;
			} else if (stderr.includes ('Authentication') || stderr.includes ('token')) {
				userMsg = 'GitHub 인증 토큰을 찾을 수 없습니다. origin remote의 HTTPS 토큰 또는 GH_TOKEN/GITHUB_TOKEN을 확인하세요.';
			} else {
				userMsg = `PR 생성 실패: ${stderr.trim ().split ('\n')[0] || err.message}`;
			}
			panel.webview.postMessage ({
				command: 'error',
				text: userMsg,
			});
		}
		} finally {
			this._isCreatingPR = false;
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
			<textarea id="body" placeholder="## 변경 개요&#10;핵심 변경과 목표 1~2문장 요약&#10;&#10;## 주요 변경&#10;- [파일명] 함수/구조체 -- 무엇을 왜 어떻게 변경했는지 서술&#10;&#10;## 설계 고려사항&#10;- 검토한 대안, 트레이드오프 서술&#10;&#10;## 리뷰 포인트&#10;- [주의] 파일:라인 -- 잠재적 이슈&#10;&#10;## 검증&#10;- 테스트 방법 및 결과"></textarea>
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
						+ '<span class="review-marker" style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:bold;">!</span>'
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
					'<div class="message error"><span class="msg-icon">&#10007;</span> 제목을 입력하세요.</div>';
				return;
			}
			// 버튼 비활성화 + 로딩 표시
			const btn = document.querySelector('.btn-create');
			if (btn) { btn.disabled = true; btn.textContent = 'PR 생성 중...'; }
			document.getElementById('messageArea').innerHTML =
				'<div class="message" style="color:#90CAF9;">PR 생성 중... 잠시 기다려주세요.</div>';
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
				case 'error': {
					area.innerHTML = '<div class="message error"><span class="msg-icon">&#10007;</span> ' + esc(msg.text) + '</div>';
					const errBtn = document.querySelector('.btn-create');
					if (errBtn) { errBtn.disabled = false; errBtn.textContent = 'PR 만들기'; }
					break;
				}
				case 'success': {
					let successHtml = esc(msg.text);
					if (msg.url) {
						successHtml += ' <a href="' + esc(msg.url) + '" target="_blank">PR 열기 &rarr;</a>';
					}
					area.innerHTML = '<div class="message success"><span class="msg-icon">&#10003;</span> ' + successHtml + '</div>';
					const okBtn = document.querySelector('.btn-create');
					if (okBtn) { okBtn.disabled = true; okBtn.textContent = 'PR 생성 완료'; }
					break;
				}
				case 'status':
					area.innerHTML = '<div class="message" style="color:#90CAF9;">' + esc(msg.text) + '</div>';
					break;
				case 'existingPR': {
					const prHtml = '<a href="' + esc(msg.url) + '" target="_blank">' + esc(msg.title || msg.url) + '</a>';
					area.innerHTML = '<div class="message success" style="margin:12px 24px;">'
						+ '<span class="msg-icon">[PR]</span> '
						+ '이 브랜치에 이미 열린 PR이 있습니다: ' + prHtml
						+ '<br><small style="opacity:0.7;">새 커밋을 push하면 PR이 자동 업데이트됩니다. 새 PR을 만들려면 기존 PR을 먼저 닫으세요.</small>'
						+ '</div>';
					const existBtn = document.querySelector('.btn-create');
					if (existBtn) { existBtn.textContent = 'PR 업데이트 (push)'; }
					break;
				}
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
