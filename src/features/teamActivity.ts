import * as vscode from 'vscode';
import { ShadowDiff } from './shadowDiff';

/**
 * Team Activity
 * Shows team activity in the status bar.
 * Click opens a Quick Pick with per-member details.
 */
export class TeamActivity {
	private shadowDiff: ShadowDiff;
	private statusBarItem!: vscode.StatusBarItem;

	constructor (shadowDiff: ShadowDiff) {
		this.shadowDiff = shadowDiff;
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		this.statusBarItem = vscode.window.createStatusBarItem (
			vscode.StatusBarAlignment.Left,
			99
		);
		this.statusBarItem.command = 'jungleKit.showTeamActivity';
		this.context = context;
		context.subscriptions.push (this.statusBarItem);

		this.updateStatusBar ();

		// Refresh every 30 seconds
		const interval = setInterval (() => this.updateStatusBar (), 30000);
		context.subscriptions.push ({
			dispose: () => clearInterval (interval),
		});
	}

	private context!: vscode.ExtensionContext;

	private updateStatusBar (): void {
		const members = this.shadowDiff.getTeamMembers ();
		const activeCount = members.length;

		if (activeCount === 0) {
			this.statusBarItem.text = '$(organization) --';
			this.statusBarItem.tooltip = '활동 중인 팀원 없음';
		} else {
			this.statusBarItem.text = `$(organization) ${activeCount}`;
			this.statusBarItem.tooltip = `${activeCount}명 활동 중 -- 클릭하여 확인`;
		}

		this.statusBarItem.show ();
	}

	async showTeamActivity (): Promise<void> {
		const members = this.shadowDiff.getTeamMembers ();

		if (members.length === 0) {
			vscode.window.showInformationMessage ('현재 활동 중인 팀원이 없습니다.');
			return;
		}

		const items = members.map ((m) => ({
			label: m.name,
			description: m.branch,
			detail: `${m.lastActive} | ${m.fileCount}개 파일 변경`,
			member: m,
		}));

		const selected = await vscode.window.showQuickPick (items, {
			placeHolder: '팀원 활동 현황',
			matchOnDescription: true,
		});

		if (selected) {
			// Show diff for the selected member's branch
			const changes = this.shadowDiff.getBranchChanges ()
				.filter ((c) => c.author === selected.member.name);

			if (changes.length === 0) {return;}

			const fileItems = changes.map ((c) => ({
				label: c.file,
				description: `${c.hunks.length}개 변경 영역`,
				change: c,
			}));

			const selectedFile = await vscode.window.showQuickPick (fileItems, {
				placeHolder: `${selected.member.name}의 변경 파일`,
			});

			if (selectedFile) {
				// Open the file and navigate to the first change
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!root) {return;}

				const fileUri = vscode.Uri.file (`${root}/${selectedFile.change.file}`);
				const doc = await vscode.workspace.openTextDocument (fileUri);
				const editor = await vscode.window.showTextDocument (doc);

				if (selectedFile.change.hunks.length > 0) {
					const firstHunk = selectedFile.change.hunks[0];
					const position = new vscode.Position (firstHunk.startLine, 0);
					editor.selection = new vscode.Selection (position, position);
					editor.revealRange (
						new vscode.Range (position, position),
						vscode.TextEditorRevealType.InCenter
					);
				}
			}
		}
	}
}
