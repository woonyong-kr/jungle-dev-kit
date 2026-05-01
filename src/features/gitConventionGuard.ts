import * as vscode from 'vscode';
import { ConfigManager, ConventionConfig } from '../utils/configManager';
import { GitUtils } from '../utils/gitUtils';

/**
 * Git Convention Guard
 * - Pre-fills default commit message based on staged files
 * - Validates commit message format before commit
 * - Guides branch naming on creation
 */
export class GitConventionGuard {
	private config: ConfigManager;
	private git: GitUtils;
	private convention: ConventionConfig;

	constructor (config: ConfigManager, git: GitUtils) {
		this.config = config;
		this.git = git;
		this.convention = config.loadConvention ();
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		// Watch for SCM input changes to pre-fill commit messages
		const gitExt = vscode.extensions.getExtension ('vscode.git');
		if (!gitExt) {return;}

		const gitApi = gitExt.exports.getAPI (1);
		if (!gitApi || gitApi.repositories.length === 0) {return;}

		const repo = gitApi.repositories[0];

		// Pre-fill commit message when staging changes
		context.subscriptions.push (
			repo.state.onDidChange (async () => {
				if (
					repo.state.indexChanges.length > 0 &&
					repo.inputBox.value === ''
				) {
					const defaultMsg = await this.generateDefaultMessage (
						repo.state.indexChanges
					);
					repo.inputBox.value = defaultMsg;
				}
			})
		);

		// Validate commit message format
		// VS Code git extension doesn't have a pre-commit hook API,
		// so we use postCommitCommand to warn after invalid commits
		context.subscriptions.push (
			repo.state.onDidChange (() => {
				// Check if a new commit was made with invalid format
				this.validateLastCommit (repo);
			})
		);
	}

	private async generateDefaultMessage (
		changes: any[]
	): Promise<string> {
		const files = changes.map ((c: any) => {
			const parts = c.uri.fsPath.split ('/');
			return parts[parts.length - 1];
		});

		// Detect project scope from file paths
		const scope = this.detectScope (changes);

		// Detect type from file extensions and paths
		const type = this.detectType (changes);

		const fileList = files.slice (0, 3).join (', ');
		const suffix = files.length > 3 ? ` 외 ${files.length - 3}개` : '';

		return `${type}(${scope}): ${fileList}${suffix}`;
	}

	private detectScope (changes: any[]): string {
		for (const change of changes) {
			const fsPath: string = change.uri.fsPath;
			for (const proj of this.convention.projects) {
				if (fsPath.includes (`/${proj}/`) || fsPath.includes (`\\${proj}\\`)) {
					return proj;
				}
			}
		}
		return 'general';
	}

	private detectType (changes: any[]): string {
		const hasNew = changes.some ((c: any) => c.status === 1); // Added
		const hasMod = changes.some ((c: any) => c.status === 5); // Modified
		const hasDocs = changes.every ((c: any) => {
			const ext = c.uri.fsPath.split ('.').pop ();
			return ['md', 'txt', 'rst'].includes (ext);
		});

		if (hasDocs) {return 'docs';}
		if (hasNew && !hasMod) {return 'feat';}
		return 'feat';
	}

	validateCommitMessage (message: string): {
		valid: boolean;
		error?: string;
		suggestion?: string;
	} {
		const trimmed = message.trim ();

		if (trimmed.length === 0) {
			return { valid: false, error: 'Commit message is empty' };
		}

		// Check prefix
		const prefixPattern = this.convention.commitPrefix.join ('|');
		const regex = new RegExp (`^(${prefixPattern})\\(.*\\):\\s.+`);

		if (!regex.test (trimmed)) {
			const suggestion = `${this.convention.commitPrefix[0]}(scope): ${trimmed}`;
			return {
				valid: false,
				error: `Commit message must match: ${this.convention.commitFormat}`,
				suggestion,
			};
		}

		return { valid: true };
	}

	validateBranchName (name: string): {
		valid: boolean;
		error?: string;
		suggestion?: string;
	} {
		const typePattern = this.convention.branchTypes.join ('|');
		const projPattern = this.convention.projects.join ('|');
		const regex = new RegExp (
			`^(${typePattern})/(${projPattern})-[a-z0-9-]+$`
		);

		if (!regex.test (name)) {
			return {
				valid: false,
				error: `Branch name must match: ${this.convention.branchFormat}`,
				suggestion: `feature/threads-your-description`,
			};
		}

		return { valid: true };
	}

	private async validateLastCommit (repo: any): Promise<void> {
		// This is called on state change; we check the HEAD commit message
		try {
			const head = repo.state.HEAD;
			if (!head?.commit) {return;}

			const message = head.commit.message || '';
			const result = this.validateCommitMessage (message);

			if (!result.valid) {
				vscode.window.showWarningMessage (
					`[Jungle Kit] Commit message convention violation: ${result.error}`,
					'OK'
				);
			}
		} catch {
			// Ignore errors during state transitions
		}
	}
}
