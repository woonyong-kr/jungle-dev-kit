import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/configManager';

type GoalStatus = 'active' | 'completed';

interface GoalRecord {
	text: string;
	successCriteria: string;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}

interface GoalFileData {
	version: number;
	current: GoalRecord | null;
	history: GoalRecord[];
}

const GOAL_FILE_VERSION = 1;
const STATUS_BAR_MAX_LENGTH = 34;

export class GoalTracker {
	private config: ConfigManager;
	private dataFilePath = '';
	private goal: GoalRecord | null = null;
	private history: GoalRecord[] = [];
	private statusBarItem: vscode.StatusBarItem | null = null;

	constructor (config: ConfigManager) {
		this.config = config;
	}

	activate (context: vscode.ExtensionContext): void {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		this.dataFilePath = path.join (root, '.annotation', 'goal.json');
		this.ensureStorage (root);
		this.loadGoal ();
		this.createStatusBarItem ();
		this.updateStatusBar ();

		context.subscriptions.push (
			vscode.workspace.onDidChangeConfiguration ((event) => {
				if (
					event.affectsConfiguration ('jungleKit.goal.showStatusBar')
					|| event.affectsConfiguration ('jungleKit.goal.includeInAI')
				) {
					this.updateStatusBar ();
				}
			})
		);

		context.subscriptions.push ({
			dispose: () => {
				this.statusBarItem?.dispose ();
				this.statusBarItem = null;
			},
		});
	}

	getActiveGoal (): GoalRecord | null {
		return this.goal?.status === 'active' ? this.goal : null;
	}

	getGoalPromptContext (): string {
		const activeGoal = this.getActiveGoal ();
		if (!activeGoal) { return ''; }

		const enabled = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<boolean> ('goal.includeInAI', true);

		if (!enabled) { return ''; }

		const criteriaLine = activeGoal.successCriteria.trim ()
			? `완료 기준: ${activeGoal.successCriteria.trim ()}`
			: '완료 기준: 명시되지 않음';

		return [
			'=== 현재 작업 Goal ===',
			`목표: ${activeGoal.text.trim ()}`,
			criteriaLine,
		].join ('\n');
	}

	async setGoal (): Promise<void> {
		const activeGoal = this.getActiveGoal ();
		const goalText = await vscode.window.showInputBox ({
			title: 'Goal 설정',
			prompt: '이번 작업에서 끝까지 유지할 목표를 입력하세요.',
			placeHolder: '예: PintOS userprog의 exec/wait 로직을 안정적으로 마무리하기',
			value: activeGoal?.text ?? '',
			ignoreFocusOut: true,
			validateInput: (value) => value.trim () ? null : 'Goal은 비워둘 수 없습니다.',
		});

		if (goalText === undefined) { return; }

		const successCriteria = await vscode.window.showInputBox ({
			title: 'Goal 완료 기준',
			prompt: '언제 이 Goal이 끝난 것으로 볼지 적어주세요. (선택)',
			placeHolder: '예: 테스트 통과 + 리팩터링 완료 + PR 설명 작성',
			value: activeGoal?.successCriteria ?? '',
			ignoreFocusOut: true,
		});

		if (successCriteria === undefined) { return; }

		const now = new Date ().toISOString ();
		this.goal = {
			text: goalText.trim (),
			successCriteria: successCriteria.trim (),
			status: 'active',
			createdAt: activeGoal?.createdAt ?? now,
			updatedAt: now,
			completedAt: null,
		};

		this.saveGoal ();
		this.updateStatusBar ();
		vscode.window.showInformationMessage ('[Annotation] Goal이 설정되었습니다.');
	}

	async showGoal (): Promise<void> {
		const activeGoal = this.getActiveGoal ();
		if (!activeGoal) {
			const lastCompleted = this.history.find ((item) => item.status === 'completed');
			const message = lastCompleted
				? `[Annotation] 현재 활성 Goal이 없습니다. 마지막 완료 Goal: ${lastCompleted.text}`
				: '[Annotation] 현재 활성 Goal이 없습니다.';
			const action = await vscode.window.showInformationMessage (message, 'Goal 설정');
			if (action === 'Goal 설정') {
				await this.setGoal ();
			}
			return;
		}

		const items: Array<vscode.QuickPickItem & { action?: 'edit' | 'copy' | 'complete' | 'clear' }> = [
			{
				label: '$(target) 현재 Goal',
				description: activeGoal.text,
				detail: this.buildGoalDetail (activeGoal),
			},
			{
				label: '$(edit) Goal 수정',
				action: 'edit',
			},
			{
				label: '$(copy) Goal 복사',
				action: 'copy',
			},
			{
				label: '$(check) Goal 완료 처리',
				action: 'complete',
			},
			{
				label: '$(trash) Goal 삭제',
				action: 'clear',
			},
		];

		const selected = await vscode.window.showQuickPick (items, {
			title: 'Goal 보기',
			placeHolder: '현재 Goal을 확인하거나 관리하세요',
			ignoreFocusOut: true,
		});

		switch (selected?.action) {
		case 'edit':
			await this.setGoal ();
			break;
		case 'copy':
			await vscode.env.clipboard.writeText (this.serializeGoalForClipboard (activeGoal));
			vscode.window.showInformationMessage ('[Annotation] Goal을 클립보드에 복사했습니다.');
			break;
		case 'complete':
			await this.completeGoal ();
			break;
		case 'clear':
			await this.clearGoal ();
			break;
		default:
			break;
		}
	}

	async completeGoal (): Promise<void> {
		const activeGoal = this.getActiveGoal ();
		if (!activeGoal) {
			vscode.window.showInformationMessage ('[Annotation] 완료 처리할 활성 Goal이 없습니다.');
			return;
		}

		const confirm = await vscode.window.showInformationMessage (
			`"${activeGoal.text}" Goal을 완료 처리할까요?`,
			{ modal: true },
			'완료'
		);

		if (confirm !== '완료') { return; }

		const completedAt = new Date ().toISOString ();
		const completedGoal: GoalRecord = {
			...activeGoal,
			status: 'completed',
			updatedAt: completedAt,
			completedAt,
		};

		this.history = [completedGoal, ...this.history]
			.filter ((item, index, array) =>
				array.findIndex ((candidate) =>
					candidate.createdAt === item.createdAt
					&& candidate.text === item.text
					&& candidate.status === item.status
				) === index
			)
			.slice (0, 20);

		this.goal = null;
		this.saveGoal ();
		this.updateStatusBar ();

		const nextAction = await vscode.window.showInformationMessage (
			'[Annotation] Goal을 완료 처리했습니다.',
			'새 Goal 설정'
		);

		if (nextAction === '새 Goal 설정') {
			await this.setGoal ();
		}
	}

	async clearGoal (): Promise<void> {
		const activeGoal = this.getActiveGoal ();
		if (!activeGoal) {
			vscode.window.showInformationMessage ('[Annotation] 삭제할 활성 Goal이 없습니다.');
			return;
		}

		const confirm = await vscode.window.showWarningMessage (
			`현재 Goal "${activeGoal.text}"를 삭제할까요?`,
			{ modal: true },
			'삭제'
		);

		if (confirm !== '삭제') { return; }

		this.goal = null;
		this.saveGoal ();
		this.updateStatusBar ();
		vscode.window.showInformationMessage ('[Annotation] Goal을 삭제했습니다.');
	}

	private createStatusBarItem (): void {
		if (!this.statusBarItem) {
			this.statusBarItem = vscode.window.createStatusBarItem (vscode.StatusBarAlignment.Left, 95);
			this.statusBarItem.command = 'jungleKit.showGoal';
		}
	}

	private updateStatusBar (): void {
		if (!this.statusBarItem) { return; }

		const showStatusBar = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<boolean> ('goal.showStatusBar', true);

		if (!showStatusBar) {
			this.statusBarItem.hide ();
			return;
		}

		const activeGoal = this.getActiveGoal ();
		if (!activeGoal) {
			this.statusBarItem.text = '$(target) Goal 설정';
			this.statusBarItem.tooltip = '현재 작업 Goal을 설정합니다.';
			this.statusBarItem.show ();
			return;
		}

		this.statusBarItem.text = `$(target) ${this.truncate (activeGoal.text, STATUS_BAR_MAX_LENGTH)}`;
		this.statusBarItem.tooltip = new vscode.MarkdownString (
			[
				'**현재 Goal**',
				'',
				`- 목표: ${activeGoal.text}`,
				`- 완료 기준: ${activeGoal.successCriteria || '미지정'}`,
				`- 마지막 수정: ${this.formatDate (activeGoal.updatedAt)}`,
				'',
				'클릭하면 Goal을 관리할 수 있습니다.',
			].join ('\n')
		);
		this.statusBarItem.tooltip.isTrusted = true;
		this.statusBarItem.show ();
	}

	private ensureStorage (root: string): void {
		const annotationDir = path.join (root, '.annotation');
		if (!fs.existsSync (annotationDir)) {
			fs.mkdirSync (annotationDir, { recursive: true });
		}

		const gitignorePath = path.join (annotationDir, '.gitignore');
		const requiredEntries = ['goal.json'];

		if (fs.existsSync (gitignorePath)) {
			const content = fs.readFileSync (gitignorePath, 'utf-8');
			const missing = requiredEntries.filter ((entry) => !content.includes (entry));
			if (missing.length > 0) {
				fs.appendFileSync (gitignorePath, '\n' + missing.join ('\n') + '\n');
			}
		} else {
			fs.writeFileSync (gitignorePath, requiredEntries.join ('\n') + '\n');
		}
	}

	private loadGoal (): void {
		if (!this.dataFilePath || !fs.existsSync (this.dataFilePath)) {
			this.goal = null;
			this.history = [];
			return;
		}

		try {
			const raw = fs.readFileSync (this.dataFilePath, 'utf-8');
			const parsed = JSON.parse (raw) as GoalFileData;
			this.goal = parsed.current ?? null;
			this.history = Array.isArray (parsed.history) ? parsed.history : [];
		} catch (err) {
			console.error ('[Annotation] goal.json 로드 실패:', err);
			this.goal = null;
			this.history = [];
		}
	}

	private saveGoal (): void {
		if (!this.dataFilePath) { return; }

		const payload: GoalFileData = {
			version: GOAL_FILE_VERSION,
			current: this.goal,
			history: this.history,
		};

		try {
			const tmpPath = this.dataFilePath + '.tmp';
			fs.writeFileSync (tmpPath, JSON.stringify (payload, null, 2));
			fs.renameSync (tmpPath, this.dataFilePath);
		} catch (err) {
			console.error ('[Annotation] goal.json 저장 실패:', err);
			vscode.window.showWarningMessage ('[Annotation] Goal 저장에 실패했습니다.');
		}
	}

	private buildGoalDetail (goal: GoalRecord): string {
		const criteria = goal.successCriteria || '미지정';
		return `완료 기준: ${criteria} • 마지막 수정: ${this.formatDate (goal.updatedAt)}`;
	}

	private serializeGoalForClipboard (goal: GoalRecord): string {
		return [
			`목표: ${goal.text}`,
			`완료 기준: ${goal.successCriteria || '미지정'}`,
			`마지막 수정: ${this.formatDate (goal.updatedAt)}`,
		].join ('\n');
	}

	private truncate (value: string, maxLength: number): string {
		return value.length > maxLength
			? value.slice (0, maxLength - 1) + '…'
			: value;
	}

	private formatDate (isoDate: string): string {
		try {
			return new Date (isoDate).toLocaleString ();
		} catch {
			return isoDate;
		}
	}
}
