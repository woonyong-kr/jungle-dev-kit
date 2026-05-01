import * as vscode from 'vscode';
import { GitUtils } from '../utils/gitUtils';

export class GitGuidePanel implements vscode.TreeDataProvider<GitGuideItem> {
	private git: GitUtils;
	private _onDidChangeTreeData = new vscode.EventEmitter<GitGuideItem | undefined> ();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor (git: GitUtils) {
		this.git = git;
		setInterval (() => this.refresh (), 30000);
	}

	refresh (): void {
		this._onDidChangeTreeData.fire (undefined);
	}

	getTreeItem (element: GitGuideItem): vscode.TreeItem {
		return element;
	}

	async getChildren (): Promise<GitGuideItem[]> {
		const items: GitGuideItem[] = [];

		try {
			const branch = await this.git.getCurrentBranch ();
			items.push (new GitGuideItem (
				`Branch: ${branch || 'detached HEAD'}`,
				branch ? 'git-branch' : 'warning'
			));

			if (branch) {
				const { ahead, behind } = await this.git.getRemoteAheadBehind ();
				if (behind > 0) {
					items.push (new GitGuideItem (
						`${behind} commits behind remote`,
						'cloud-download'
					));
					items.push (new GitGuideItem (
						'-> Pull needed before push',
						'arrow-right'
					));
				}
				if (ahead > 0) {
					items.push (new GitGuideItem (
						`${ahead} commits ahead of remote`,
						'cloud-upload'
					));
				}
				if (ahead === 0 && behind === 0) {
					items.push (new GitGuideItem ('Up to date with remote', 'check'));
				}
			}

			const hasChanges = await this.git.hasUncommittedChanges ();
			if (hasChanges) {
				items.push (new GitGuideItem (
					'Uncommitted changes exist',
					'edit'
				));
			}
		} catch {
			items.push (new GitGuideItem ('Git not available', 'error'));
		}

		return items;
	}
}

class GitGuideItem extends vscode.TreeItem {
	constructor (label: string, icon: string) {
		super (label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon (icon);
	}
}
