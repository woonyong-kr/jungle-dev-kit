import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GitUtils } from '../utils/gitUtils';
import { APIKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { TagSystem } from './tagSystem';

const execAsync = promisify (exec);

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
		const diff = await this.git.getStagedDiff () || await this.git.getDiffAgainst ('dev');
		const changedFiles = await this.git.getChangedFiles ('dev');
		const commits = await this.git.getRecentCommits (currentBranch, 10);
		const reviewTags = this.tagSystem.getReviewTags ();

		panel.webview.html = this.getWebviewContent (
			currentBranch,
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
			}
		});
	}

	private async handleAIGenerate (
		panel: vscode.WebviewPanel,
		diff: string,
		branch: string,
		changedFiles: Array<{ path: string; additions: number; deletions: number }>,
		commits: Array<{ hash: string; message: string; author: string }>,
		reviewTags: Array<{ file: string; line: number; content: string }>
	): Promise<void> {
		const apiKey = await this.apiKeys.getKey ();
		if (!apiKey) {
			panel.webview.postMessage ({ command: 'error', text: 'API 키를 먼저 등록하세요.' });
			return;
		}

		try {
			const OpenAI = (await import ('openai')).default;
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
${diff.substring (0, 6000)}`,
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

		// Check if gh is installed
		try {
			await execAsync ('gh --version', { cwd: root });
		} catch {
			panel.webview.postMessage ({
				command: 'error',
				text: 'GitHub CLI(gh)가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요.',
			});
			return;
		}

		// Push current branch first
		try {
			const branch = await this.git.getCurrentBranch ();
			await execAsync (`git push -u origin ${branch}`, { cwd: root });
		} catch {
			// May already be pushed
		}

		// Create PR
		try {
			const tempDir = path.join (root, '.jungle-kit');

			// Write title and body to temp files to avoid all shell injection
			const titleFile = path.join (tempDir, 'pr-title-temp.txt');
			const bodyFile = path.join (tempDir, 'pr-body-temp.md');
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

			const { stdout } = await execAsync (cmd, { cwd: root });
			const prUrl = stdout.trim ();

			// Cleanup temp files
			try {fs.unlinkSync (bodyFile);} catch {}
			try {fs.unlinkSync (titleFile);} catch {}

			panel.webview.postMessage ({
				command: 'success',
				text: `PR이 생성되었습니다: ${prUrl}`,
				url: prUrl,
			});

			vscode.window.showInformationMessage (`PR 생성 완료: ${prUrl}`);
		} catch (err: any) {
			panel.webview.postMessage ({
				command: 'error',
				text: `PR 생성 실패: ${err.message}`,
			});
		}
	}

	private getWebviewContent (
		branch: string,
		changedFiles: Array<{ path: string; additions: number; deletions: number }>,
		commits: Array<{ hash: string; message: string; author: string; date: string }>,
		reviewTags: Array<{ file: string; line: number; content: string }>
	): string {
		const fileRows = changedFiles
			.map ((f) => `<tr><td>${f.path}</td><td>+${f.additions}</td><td>-${f.deletions}</td></tr>`)
			.join ('');

		const commitList = commits
			.map ((c) => `<li><code>${c.hash.substring (0, 7)}</code> ${c.message} (${c.author})</li>`)
			.join ('');

		const reviewList = reviewTags
			.map ((t) => `<li>${t.file}:${t.line + 1} -- ${t.content}</li>`)
			.join ('');

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

	/* Top bar */
	.topbar {
		display: flex; align-items: center; justify-content: space-between;
		padding: 12px 20px;
		background: var(--vscode-sideBar-background);
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.topbar-left { display: flex; align-items: center; gap: 10px; }
	.topbar h1 { font-size: 14px; font-weight: 600; letter-spacing: 0.3px; }
	.topbar .icon { font-size: 16px; opacity: 0.7; }
	.branch-flow {
		display: flex; align-items: center; gap: 6px;
		font-size: 12px; color: var(--vscode-descriptionForeground);
	}
	.branch-tag {
		font-size: 11px; padding: 2px 8px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace);
	}
	.branch-arrow { color: var(--vscode-descriptionForeground); font-size: 14px; }

	/* Content */
	.content { padding: 16px 20px; }

	/* Form */
	.form-group { margin-bottom: 14px; }
	.form-label {
		display: block; font-size: 11px; font-weight: 600;
		color: var(--vscode-descriptionForeground);
		text-transform: uppercase; letter-spacing: 0.8px;
		margin-bottom: 5px;
	}
	.form-row { display: flex; gap: 8px; align-items: stretch; }

	input, textarea, select {
		width: 100%; padding: 7px 10px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		border-radius: 4px; outline: none;
		transition: border-color 0.15s;
	}
	input:focus, textarea:focus, select:focus {
		border-color: var(--vscode-focusBorder);
	}
	textarea {
		min-height: 200px; resize: vertical;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12px; line-height: 1.7;
	}
	input:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Buttons */
	.btn {
		display: inline-flex; align-items: center; justify-content: center;
		padding: 7px 16px; font-size: 12px; font-weight: 600;
		border: none; border-radius: 4px; cursor: pointer;
		white-space: nowrap; transition: all 0.15s;
		letter-spacing: 0.3px;
	}
	.btn:hover { filter: brightness(1.1); }
	.btn:active { transform: scale(0.98); }
	.btn-primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn-secondary {
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}
	.btn-ai {
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
		font-size: 11px; padding: 6px 12px;
	}
	.btn-ai:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}

	/* Collapsible sections */
	.section {
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px; margin-bottom: 10px;
		overflow: hidden;
	}
	.section-header {
		display: flex; align-items: center; gap: 8px;
		padding: 7px 12px; cursor: pointer;
		background: var(--vscode-sideBar-background);
		font-size: 11px; font-weight: 600;
		color: var(--vscode-descriptionForeground);
		text-transform: uppercase; letter-spacing: 0.5px;
		user-select: none;
	}
	.section-header:hover { background: var(--vscode-list-hoverBackground); }
	.section-header .count {
		font-size: 10px; padding: 1px 6px; margin-left: auto;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		border-radius: 8px; font-weight: normal;
	}
	.section-body { padding: 0; max-height: 200px; overflow-y: auto; }
	.section.collapsed .section-body { display: none; }
	.section-header .chevron { transition: transform 0.15s; font-size: 9px; }
	.section.collapsed .chevron { transform: rotate(-90deg); }

	/* File table */
	.file-table { width: 100%; border-collapse: collapse; }
	.file-table tr:hover { background: var(--vscode-list-hoverBackground); }
	.file-table td {
		padding: 5px 12px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		font-family: var(--vscode-editor-font-family, monospace);
	}
	.file-table td:nth-child(2), .file-table td:nth-child(3) {
		width: 60px; text-align: right;
	}
	.file-table .add { color: #4EC9B0; }
	.file-table .del { color: #F14C4C; }

	/* Commit list */
	.commit-list { list-style: none; }
	.commit-list li {
		padding: 5px 12px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		display: flex; align-items: baseline; gap: 8px;
	}
	.commit-list li:hover { background: var(--vscode-list-hoverBackground); }
	.commit-list code {
		font-family: var(--vscode-editor-font-family, monospace);
		color: var(--vscode-textLink-foreground);
		font-size: 11px; flex-shrink: 0;
	}
	.commit-list .msg { flex: 1; }
	.commit-list .author {
		color: var(--vscode-descriptionForeground);
		font-size: 10px; flex-shrink: 0;
	}

	/* Review list */
	.review-list { list-style: none; }
	.review-list li {
		padding: 5px 12px; font-size: 12px;
		border-top: 1px solid var(--vscode-panel-border);
		display: flex; gap: 8px;
	}
	.review-list li:hover { background: var(--vscode-list-hoverBackground); }
	.review-list .loc {
		color: var(--vscode-textLink-foreground);
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px; flex-shrink: 0;
	}

	/* Footer */
	.footer {
		padding: 14px 20px;
		border-top: 1px solid var(--vscode-panel-border);
		display: flex; align-items: center; gap: 10px;
	}

	/* Messages */
	.message {
		margin: 10px 20px; padding: 10px 14px;
		border-radius: 4px; font-size: 12px;
	}
	.error {
		background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.08));
		border: 1px solid var(--vscode-inputValidation-errorBorder, #F44336);
		color: var(--vscode-errorForeground, #F44336);
	}
	.success {
		background: rgba(76,175,80,0.08);
		border: 1px solid rgba(76,175,80,0.25);
		color: #4CAF50;
	}

	/* Loading */
	.loading { display: none; align-items: center; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
	.loading.active { display: inline-flex; }
	.spinner {
		width: 12px; height: 12px;
		border: 2px solid var(--vscode-descriptionForeground);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Divider */
	.divider { height: 1px; background: var(--vscode-panel-border); margin: 6px 0 14px; }
</style>
</head>
<body>
	<div class="topbar">
		<div class="topbar-left">
			<span class="icon">⎇</span>
			<h1>Pull Request</h1>
		</div>
		<div class="branch-flow">
			<span class="branch-tag">${branch}</span>
			<span class="branch-arrow">→</span>
			<select id="base" style="width:auto;padding:2px 6px;font-size:11px;border-radius:3px;">
				<option value="dev" selected>dev</option>
				<option value="main">main</option>
				<option value="master">master</option>
			</select>
		</div>
	</div>

	<div class="content">
		<div class="form-group">
			<label class="form-label">Title</label>
			<div class="form-row">
				<input type="text" id="title" placeholder="feat: 변경 내용을 한국어로 작성" style="flex:1;" />
				<button class="btn btn-ai" onclick="generateAI()">✦ AI 생성</button>
			</div>
			<div class="loading" id="loading" style="margin-top:6px;">
				<div class="spinner"></div>
				<span>AI가 diff를 분석하고 있습니다...</span>
			</div>
		</div>

		<div class="form-group">
			<label class="form-label">Description</label>
			<textarea id="body" placeholder="## 변경 내용&#10;&#10;## 변경 이유&#10;&#10;## 구현 방법&#10;&#10;## 주의사항"></textarea>
		</div>

		<div class="divider"></div>

		<div class="section" id="filesSection">
			<div class="section-header" onclick="toggleSection('filesSection')">
				<span class="chevron">▼</span>
				<span>Files Changed</span>
				<span class="count">${changedFiles.length}</span>
			</div>
			<div class="section-body">
				<table class="file-table">
					${changedFiles.map ((f) =>
						'<tr><td>' + f.path + '</td><td class="add">+' + f.additions + '</td><td class="del">-' + f.deletions + '</td></tr>'
					).join ('')}
				</table>
			</div>
		</div>

		<div class="section" id="commitsSection">
			<div class="section-header" onclick="toggleSection('commitsSection')">
				<span class="chevron">▼</span>
				<span>Commits</span>
				<span class="count">${commits.length}</span>
			</div>
			<div class="section-body">
				<ul class="commit-list">
					${commits.length > 0
						? commits.map ((c) =>
							'<li><code>' + c.hash.substring (0, 7) + '</code><span class="msg">' + c.message + '</span><span class="author">' + c.author + '</span></li>'
						).join ('')
						: '<li style="color:var(--vscode-descriptionForeground);justify-content:center;">커밋 없음</li>'}
				</ul>
			</div>
		</div>

		${reviewTags.length > 0 ? `
		<div class="section" id="reviewSection">
			<div class="section-header" onclick="toggleSection('reviewSection')">
				<span class="chevron">▼</span>
				<span>Review Points</span>
				<span class="count">${reviewTags.length}</span>
			</div>
			<div class="section-body">
				<ul class="review-list">
					${reviewTags.map ((t) =>
						'<li><span class="loc">' + t.file + ':' + (t.line + 1) + '</span><span>' + t.content + '</span></li>'
					).join ('')}
				</ul>
			</div>
		</div>` : ''}

		<div class="divider"></div>

		<div class="form-group">
			<label class="form-label">Reviewers</label>
			<input type="text" id="reviewers" placeholder="GitHub ID (쉼표로 구분)" />
		</div>
	</div>

	<div class="footer">
		<button class="btn btn-primary" onclick="createPR()">PR 생성</button>
	</div>

	<div id="messageArea"></div>

	<script>
		const vscode = acquireVsCodeApi();

		function toggleSection(id) {
			document.getElementById(id).classList.toggle('collapsed');
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
					'<div class="message error">제목을 입력하세요.</div>';
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
					area.innerHTML = '<div class="message success">AI 생성 완료</div>';
					setTimeout(() => { area.innerHTML = ''; }, 3000);
					break;
				case 'error':
					area.innerHTML = '<div class="message error">' + msg.text + '</div>';
					break;
				case 'success':
					area.innerHTML = '<div class="message success">' + msg.text + '</div>';
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}
