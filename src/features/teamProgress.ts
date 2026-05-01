import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { GitUtils } from '../utils/gitUtils';

export class TeamProgress implements vscode.TreeDataProvider<ProgressItem> {
	private config: ConfigManager;
	private git: GitUtils;
	private _onDidChangeTreeData = new vscode.EventEmitter<ProgressItem | undefined> ();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor (config: ConfigManager, git: GitUtils) {
		this.config = config;
		this.git = git;
	}

	getTreeItem (element: ProgressItem): vscode.TreeItem {
		return element;
	}

	async getChildren (): Promise<ProgressItem[]> {
		// TODO: Read progress.json from each branch
		return [new ProgressItem ('Run "Update My Progress" to start', 'info')];
	}

	async updateMyProgress (): Promise<void> {
		// TODO: Parse make check output, write progress.json, commit
		vscode.window.showInformationMessage ('[Jungle Kit] Progress updated');
	}
}

class ProgressItem extends vscode.TreeItem {
	constructor (label: string, icon: string) {
		super (label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon (icon);
	}
}
