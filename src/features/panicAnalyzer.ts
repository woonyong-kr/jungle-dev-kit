import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';
import { KnowledgeBase } from './knowledgeBase';

export class PanicAnalyzer {
	private config: ConfigManager;
	private apiKeys: APIKeyManager;
	private kb: KnowledgeBase;

	constructor (config: ConfigManager, apiKeys: APIKeyManager, kb: KnowledgeBase) {
		this.config = config;
		this.apiKeys = apiKeys;
		this.kb = kb;
	}

	async analyzeFromTerminal (): Promise<void> {
		const key = await this.apiKeys.requireKey ();
		if (!key) {return;}

		// TODO: Read terminal output, detect KERNEL PANIC pattern
		// TODO: Parse backtrace addresses
		// TODO: Use addr2line to resolve to source:line
		// TODO: Read source files at crash location
		// TODO: Send to OpenAI with PintOS context
		// TODO: Display analysis in output panel
		// TODO: Cache in knowledge base

		vscode.window.showInformationMessage (
			'[Jungle Kit] Panic Analyzer - implementation in progress'
		);
	}
}
