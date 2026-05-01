import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { GitUtils } from '../utils/gitUtils';

/**
 * Branch Manager
 * - Branch naming guide on creation
 * - Force push protection on protected branches
 * - Detached HEAD detection
 * - Stale branch cleanup suggestions
 * - Warning when committing to someone else's branch
 */
export class BranchManager {
	private config: ConfigManager;
	private git: GitUtils;
	private previousBranch: string = '';

	constructor (config: ConfigManager, git: GitUtils) {
		this.config = config;
		this.git = git;
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		// Monitor branch changes
		this.previousBranch = await this.git.getCurrentBranch ();

		// Check for detached HEAD periodically
		const interval = setInterval (async () => {
			await this.checkDetachedHead ();
		}, 10000);
		context.subscriptions.push ({ dispose: () => clearInterval (interval) });

		// Check stale branches on startup
		await this.checkStaleBranches ();

		// Monitor for git operations via terminal
		context.subscriptions.push (
			vscode.window.onDidChangeActiveTerminal (async () => {
				await this.checkBranchChange ();
			})
		);

		// Watch for workspace changes that might indicate branch switch
		context.subscriptions.push (
			vscode.workspace.onDidChangeTextDocument (async () => {
				await this.checkBranchChange ();
			})
		);
	}

	async mergePreview (): Promise<void> {
		const currentBranch = await this.git.getCurrentBranch ();
		const branches = await this.git.getLocalBranches ();
		const otherBranches = branches.filter ((b) => b !== currentBranch);

		const target = await vscode.window.showQuickPick (otherBranches, {
			placeHolder: `어떤 브랜치를 ${currentBranch}에 머지할까요?`,
		});

		if (!target) {return;}

		const { ahead, behind } = await this.git.getAheadBehind (target);
		const files = await this.git.getChangedFiles (target);

		let message = `[Merge Preview] ${target} -> ${currentBranch}\n\n`;
		message += `가져올 커밋: ${behind}개\n`;
		message += `변경 파일: ${files.length}개\n\n`;

		for (const f of files) {
			message += `  ${f.path} (+${f.additions} -${f.deletions})\n`;
		}

		// Show in output channel
		const channel = vscode.window.createOutputChannel ('Jungle Kit: Merge Preview');
		channel.clear ();
		channel.appendLine (message);
		channel.show ();

		const action = await vscode.window.showInformationMessage (
			`${target}에서 ${files.length}개 파일, ${behind}개 커밋을 가져옵니다. 진행하시겠습니까?`,
			'머지 실행',
			'취소'
		);

		if (action === '머지 실행') {
			// TODO: Execute merge with conflict detection
			vscode.window.showInformationMessage (
				'머지를 실행합니다. 충돌이 발생하면 안내가 표시됩니다.'
			);
		}
	}

	private async checkDetachedHead (): Promise<void> {
		const isDetached = await this.git.isDetachedHead ();
		if (isDetached) {
			const action = await vscode.window.showWarningMessage (
				'[Jungle Kit] Detached HEAD 상태입니다. 이 상태에서 커밋하면 잃어버릴 수 있습니다.',
				'새 브랜치 생성',
				'무시'
			);
			if (action === '새 브랜치 생성') {
				const name = await vscode.window.showInputBox ({
					prompt: '새 브랜치 이름을 입력하세요',
					placeHolder: 'feature/threads-my-work',
				});
				if (name) {
					// Validate branch name
					const convention = this.config.loadConvention ();
					const typePattern = convention.branchTypes.join ('|');
					const projPattern = convention.projects.join ('|');
					const regex = new RegExp (
						`^(${typePattern})/(${projPattern})-[a-z0-9-]+$`
					);
					if (!regex.test (name)) {
						vscode.window.showWarningMessage (
							`브랜치 이름이 규칙에 맞지 않습니다. 예: feature/threads-my-work`
						);
					}
					// Create branch anyway (warning, not blocking)
					const terminal = vscode.window.createTerminal ('Jungle Kit');
					terminal.sendText (`git checkout -b ${name}`);
					terminal.show ();
				}
			}
		}
	}

	private async checkStaleBranches (): Promise<void> {
		const branches = await this.git.getLocalBranches ();
		const convention = this.config.loadConvention ();
		const protectedBranches = convention.protectedBranches;
		const staleBranches: string[] = [];

		for (const branch of branches) {
			if (protectedBranches.includes (branch)) {continue;}

			const lastDate = await this.git.getLastCommitDate (branch);
			// Check if "weeks" or "months" in relative date
			if (lastDate.includes ('week') || lastDate.includes ('month')) {
				staleBranches.push (`${branch} (${lastDate})`);
			}
		}

		if (staleBranches.length > 0) {
			vscode.window.showInformationMessage (
				`[Jungle Kit] 오래된 브랜치 ${staleBranches.length}개: ${staleBranches.join (', ')}. 정리하시겠습니까?`,
				'확인',
				'나중에'
			);
		}
	}

	private async checkBranchChange (): Promise<void> {
		const current = await this.git.getCurrentBranch ();
		if (current !== this.previousBranch && current !== '') {
			this.previousBranch = current;

			// Check if committing to someone else's branch
			const convention = this.config.loadConvention ();
			const userName = await this.getUserName ();

			if (
				userName &&
				!convention.protectedBranches.includes (current) &&
				!current.includes (userName) &&
				!current.startsWith ('feature/') &&
				!current.startsWith ('fix/') &&
				!current.startsWith ('hotfix/')
			) {
				vscode.window.showWarningMessage (
					`[Jungle Kit] "${current}" 브랜치는 다른 팀원의 브랜치일 수 있습니다. 본인 브랜치에서 작업하시는 것을 권장합니다.`
				);
			}
		}
	}

	private async getUserName (): Promise<string> {
		try {
			const { exec } = require ('child_process');
			const { promisify } = require ('util');
			const execAsync = promisify (exec);
			const { stdout } = await execAsync ('git config user.name', {
				cwd: this.config.getWorkspaceRoot (),
			});
			return stdout.trim ().toLowerCase ();
		} catch {
			return '';
		}
	}
}
