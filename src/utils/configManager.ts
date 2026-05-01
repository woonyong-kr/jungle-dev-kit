import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface JungleKitConfig {
	project: 'pintos' | 'xv6' | 'custom';
	convention: ConventionConfig;
	env: EnvConfig;
	style: StyleConfig;
}

export interface ConventionConfig {
	commitPrefix: string[];
	commitFormat: string;
	branchFormat: string;
	branchTypes: string[];
	projects: string[];
	protectedBranches: string[];
}

export interface EnvConfig {
	checks: Record<string, boolean>;
	autoFix: boolean;
	showOnStartup: boolean;
}

export interface StyleConfig {
	autoCreateClangFormat: boolean;
	clangFormatContent: string;
}

const DEFAULT_CONVENTION: ConventionConfig = {
	commitPrefix: ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'style'],
	commitFormat: '<type>(<scope>): <description>',
	branchFormat: '<type>/<project>-<description>',
	branchTypes: ['feature', 'fix', 'hotfix'],
	projects: ['threads', 'userprog', 'vm', 'filesys'],
	protectedBranches: ['main', 'dev', 'master'],
};

const DEFAULT_ENV: EnvConfig = {
	checks: {
		gcc: true,
		qemu: true,
		gdb: true,
		make: true,
		'pintos-activate': true,
		'clang-format': true,
		extensions: true,
	},
	autoFix: true,
	showOnStartup: true,
};

export class ConfigManager {
	private context: vscode.ExtensionContext;
	private configDir: string = '';

	constructor (context: vscode.ExtensionContext) {
		this.context = context;
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (ws) {
			this.configDir = path.join (ws.uri.fsPath, '.jungle-kit');
		}
	}

	getConfigDir (): string {
		return this.configDir;
	}

	getWorkspaceRoot (): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	}

	async initProject (): Promise<void> {
		if (!this.configDir) {
			vscode.window.showErrorMessage ('No workspace folder open');
			return;
		}

		if (!fs.existsSync (this.configDir)) {
			fs.mkdirSync (this.configDir, { recursive: true });
		}

		// Create config.json
		const configPath = path.join (this.configDir, 'config.json');
		if (!fs.existsSync (configPath)) {
			const config: JungleKitConfig = {
				project: 'pintos',
				convention: DEFAULT_CONVENTION,
				env: DEFAULT_ENV,
				style: {
					autoCreateClangFormat: true,
					clangFormatContent: '',
				},
			};
			fs.writeFileSync (configPath, JSON.stringify (config, null, 2));
		}

		// Create subdirectories
		const dirs = ['reviews', 'knowledge', 'notes'];
		for (const dir of dirs) {
			const dirPath = path.join (this.configDir, dir);
			if (!fs.existsSync (dirPath)) {
				fs.mkdirSync (dirPath, { recursive: true });
			}
		}

		// Add notes to .gitignore (local-only)
		await this.ensureGitignoreEntry ('notes/');

		vscode.window.showInformationMessage (
			'Jungle Dev Kit initialized: .jungle-kit/ created'
		);
	}

	loadConvention (): ConventionConfig {
		const configPath = path.join (this.configDir, 'config.json');
		if (fs.existsSync (configPath)) {
			try {
				const raw = fs.readFileSync (configPath, 'utf-8');
				const config = JSON.parse (raw) as JungleKitConfig;
				return { ...DEFAULT_CONVENTION, ...config.convention };
			} catch {
				return DEFAULT_CONVENTION;
			}
		}
		return DEFAULT_CONVENTION;
	}

	loadEnvConfig (): EnvConfig {
		const configPath = path.join (this.configDir, 'config.json');
		if (fs.existsSync (configPath)) {
			try {
				const raw = fs.readFileSync (configPath, 'utf-8');
				const config = JSON.parse (raw) as JungleKitConfig;
				return { ...DEFAULT_ENV, ...config.env };
			} catch {
				return DEFAULT_ENV;
			}
		}
		return DEFAULT_ENV;
	}

	private async ensureGitignoreEntry (entry: string): Promise<void> {
		const root = this.getWorkspaceRoot ();
		const gitignorePath = path.join (root, '.jungle-kit', '.gitignore');
		let content = '';
		if (fs.existsSync (gitignorePath)) {
			content = fs.readFileSync (gitignorePath, 'utf-8');
		}
		if (!content.includes (entry)) {
			content += `\n${entry}\n`;
			fs.writeFileSync (gitignorePath, content);
		}
	}
}
