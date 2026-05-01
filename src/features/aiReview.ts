import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';
import { GitUtils } from '../utils/gitUtils';
import { KnowledgeBase } from './knowledgeBase';

/**
 * AI Code Review
 * - Collects staged diff + related headers/source
 * - Sends to OpenAI with PintOS-specific system prompt
 * - Displays results as inline diagnostics
 * - Stores verified reviews for team learning
 */
export class AIReview implements vscode.TreeDataProvider<ReviewItem> {
	private config: ConfigManager;
	private apiKeys: APIKeyManager;
	private git: GitUtils;
	private kb: KnowledgeBase;
	private diagnostics: vscode.DiagnosticCollection;
	private _onDidChangeTreeData = new vscode.EventEmitter<ReviewItem | undefined> ();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor (
		config: ConfigManager,
		apiKeys: APIKeyManager,
		git: GitUtils,
		kb: KnowledgeBase
	) {
		this.config = config;
		this.apiKeys = apiKeys;
		this.git = git;
		this.kb = kb;
		this.diagnostics = vscode.languages.createDiagnosticCollection ('jungleKit-ai-review');
	}

	async reviewCurrentChanges (): Promise<void> {
		const key = await this.apiKeys.requireKey ();
		if (!key) {return;}

		const diff = await this.git.getStagedDiff ();
		if (!diff) {
			vscode.window.showWarningMessage ('No staged changes to review');
			return;
		}

		// Check knowledge base first
		const cached = this.kb.findRelevant (diff);
		if (cached) {
			vscode.window.showInformationMessage (
				'[Jungle Kit] Found cached review from knowledge base'
			);
			// TODO: Display cached review
			return;
		}

		// TODO: Collect context files (headers, related source)
		// TODO: Build system prompt with PintOS review rules
		// TODO: Call OpenAI API
		// TODO: Parse response and display as diagnostics
		// TODO: Add thumbs up/down feedback mechanism

		vscode.window.showInformationMessage (
			'[Jungle Kit] AI Review - implementation in progress'
		);
	}

	getTreeItem (element: ReviewItem): vscode.TreeItem {
		return element;
	}

	async getChildren (): Promise<ReviewItem[]> {
		return [new ReviewItem ('No reviews yet', 'info')];
	}
}

class ReviewItem extends vscode.TreeItem {
	constructor (label: string, icon: string) {
		super (label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon (icon);
	}
}
