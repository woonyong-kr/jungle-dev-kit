import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';
import { GitUtils } from '../utils/gitUtils';

export class SmartCommit {
	private config: ConfigManager;
	private apiKeys: APIKeyManager;
	private git: GitUtils;

	constructor (config: ConfigManager, apiKeys: APIKeyManager, git: GitUtils) {
		this.config = config;
		this.apiKeys = apiKeys;
		this.git = git;
	}

	async generate (): Promise<void> {
		const key = await this.apiKeys.requireKey ();
		if (!key) {return;}

		const diff = await this.git.getStagedDiff ();
		if (!diff) {
			vscode.window.showWarningMessage ('No staged changes');
			return;
		}

		// TODO: Send diff to OpenAI
		// TODO: Generate 3 commit message suggestions
		// TODO: Show QuickPick for selection
		// TODO: Set selected message in SCM input box

		vscode.window.showInformationMessage (
			'[Jungle Kit] Smart Commit - implementation in progress'
		);
	}
}
