import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { GitUtils } from '../utils/gitUtils';

/**
 * Pull Reminder
 * - Auto fetch on startup and branch switch
 * - Status bar indicator showing ahead/behind count
 * - Block push when behind remote
 * - Background periodic fetch
 * - Show who committed what before pulling
 */
export class PullReminder {
	private config: ConfigManager;
	private git: GitUtils;
	private statusBarItem: vscode.StatusBarItem;
	private fetchInterval: NodeJS.Timeout | undefined;

	constructor (config: ConfigManager, git: GitUtils) {
		this.config = config;
		this.git = git;
		this.statusBarItem = vscode.window.createStatusBarItem (
			vscode.StatusBarAlignment.Left,
			100
		);
		this.statusBarItem.command = 'jungleKit.pullAndPush';
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		const enabled = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<boolean> ('pullReminder.enabled', true);

		if (!enabled) {return;}

		context.subscriptions.push (this.statusBarItem);
		this.statusBarItem.show ();

		// Initial check
		await this.updateStatus ();

		// Periodic background fetch
		const intervalMin = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<number> ('pullReminder.intervalMinutes', 30);

		this.fetchInterval = setInterval (
			() => this.updateStatus (),
			intervalMin * 60 * 1000
		);

		context.subscriptions.push ({
			dispose: () => {
				if (this.fetchInterval) {
					clearInterval (this.fetchInterval);
				}
			},
		});
	}

	async updateStatus (): Promise<void> {
		try {
			const branch = await this.git.getCurrentBranch ();
			if (!branch) {
				this.statusBarItem.text = '$(git-branch) detached';
				this.statusBarItem.tooltip = 'Detached HEAD state';
				return;
			}

			await this.git.fetch ();
			const { ahead, behind } = await this.git.getRemoteAheadBehind ();

			let icon = '$(git-branch)';
			if (behind > 0) {
				icon = '$(cloud-download)';
				this.statusBarItem.backgroundColor = new vscode.ThemeColor (
					'statusBarItem.warningBackground'
				);
			} else {
				this.statusBarItem.backgroundColor = undefined;
			}

			this.statusBarItem.text =
				`${icon} ${branch} ${behind > 0 ? behind + ' behind' : ''} ${ahead > 0 ? ahead + ' ahead' : ''}`.trim ();

			this.statusBarItem.tooltip = [
				`Branch: ${branch}`,
				`Remote behind: ${behind} commits`,
				`Local ahead: ${ahead} commits`,
				'',
				'Click to Pull & Push',
			].join ('\n');

			// Show notification if behind
			if (behind > 0) {
				await this.showPullNotification (branch, behind);
			}
		} catch {
			this.statusBarItem.text = '$(git-branch) offline';
		}
	}

	private async showPullNotification (
		branch: string,
		behind: number
	): Promise<void> {
		const commits = await this.git.getRecentCommits (
			`origin/${branch}`,
			Math.min (behind, 5)
		);

		const commitList = commits
			.map ((c) => `  - ${c.author}: ${c.message} (${c.date})`)
			.join ('\n');

		const action = await vscode.window.showInformationMessage (
			`[Jungle Kit] ${branch}에 새 커밋 ${behind}개가 있습니다`,
			'상세 보기 & Pull',
			'나중에'
		);

		if (action === '상세 보기 & Pull') {
			const channel = vscode.window.createOutputChannel (
				'Jungle Kit: Remote Changes'
			);
			channel.clear ();
			channel.appendLine (`=== ${branch} 원격 새 커밋 (${behind}개) ===`);
			channel.appendLine ('');
			channel.appendLine (commitList);
			channel.show ();

			const confirmPull = await vscode.window.showInformationMessage (
				'Pull을 실행하시겠습니까?',
				'Pull',
				'취소'
			);

			if (confirmPull === 'Pull') {
				await this.executePull ();
			}
		}
	}

	async pullAndPush (): Promise<void> {
		const branch = await this.git.getCurrentBranch ();
		if (!branch) {
			vscode.window.showErrorMessage ('현재 브랜치를 확인할 수 없습니다');
			return;
		}

		// Check if behind remote
		const { ahead, behind } = await this.git.getRemoteAheadBehind ();

		if (behind > 0) {
			vscode.window.showInformationMessage (
				`먼저 ${behind}개 커밋을 pull 받습니다...`
			);
			await this.executePull ();
		}

		if (ahead > 0) {
			const terminal = vscode.window.createTerminal ('Jungle Kit');
			terminal.sendText (`git push origin ${branch}`);
			terminal.show ();
		} else if (behind === 0) {
			vscode.window.showInformationMessage ('이미 최신 상태입니다');
		}

		await this.updateStatus ();
	}

	private async executePull (): Promise<void> {
		const terminal = vscode.window.createTerminal ('Jungle Kit');
		terminal.sendText ('git pull --rebase');
		terminal.show ();

		vscode.window.showInformationMessage (
			'Pull 완료 후 충돌이 있으면 직접 해결해야 합니다'
		);
	}
}
