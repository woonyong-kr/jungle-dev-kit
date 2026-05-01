import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';
import { KnowledgeBase } from './knowledgeBase';

export class TestFailureExplainer {
	private config: ConfigManager;
	private apiKeys: APIKeyManager;
	private kb: KnowledgeBase;

	constructor (config: ConfigManager, apiKeys: APIKeyManager, kb: KnowledgeBase) {
		this.config = config;
		this.apiKeys = apiKeys;
		this.kb = kb;
	}

	async explain (): Promise<void> {
		const key = await this.apiKeys.requireKey ();
		if (!key) {return;}

		// TODO: Parse make check results
		// TODO: Find failed tests
		// TODO: Compare .output vs .ck files
		// TODO: Read test source code
		// TODO: Send to OpenAI for analysis
		// TODO: Display in panel
		// TODO: Cache in knowledge base

		vscode.window.showInformationMessage (
			'[Jungle Kit] Test Failure Explainer - implementation in progress'
		);
	}
}
