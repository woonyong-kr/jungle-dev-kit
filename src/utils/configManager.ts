import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** git diff 대상 확장자 (shell glob) — 프로젝트 전역에서 사용 */
export const DIFF_FILE_EXTENSIONS = "'*.c' '*.h'";

/** AI diff 절삭 한도 (bytes) */
export const AI_DIFF_TRUNCATE_LIMIT = 4000;

/** PR diff 절삭 한도 (bytes) */
export const PR_DIFF_TRUNCATE_LIMIT = 6000;

export interface JungleKitConfig {
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
	showOnStartup: boolean;
}

export interface StyleConfig {
	autoCreateClangFormat: boolean;
}

const DEFAULT_CONVENTION: ConventionConfig = {
	commitPrefix: ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'style'],
	commitFormat: '<type>: <한국어 제목>',
	branchFormat: '<type>/<project>-<description>',
	branchTypes: ['feature', 'fix', 'hotfix'],
	projects: ['threads', 'userprog', 'vm', 'filesys'],
	protectedBranches: ['main', 'master'],
};

const DEFAULT_ENV: EnvConfig = {
	checks: {
		gcc: true,
		qemu: true,
		gdb: true,
		make: true,
		'clang-format': true,
		extensions: true,
	},
	showOnStartup: true,
};

export class ConfigManager {
	private context: vscode.ExtensionContext;

	constructor (context: vscode.ExtensionContext) {
		this.context = context;
	}

	/** 워크스페이스 변경 시에도 항상 최신 경로를 반환 */
	getConfigDir (): string {
		const root = this.getWorkspaceRoot ();
		return root ? path.join (root, '.annotation') : '';
	}

	getWorkspaceRoot (): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	}

	async initProject (): Promise<void> {
		if (!this.getConfigDir ()) {
			vscode.window.showErrorMessage ('No workspace folder open');
			return;
		}

		try {
			if (!fs.existsSync (this.getConfigDir ())) {
				fs.mkdirSync (this.getConfigDir (), { recursive: true });
			}

			// Create config.json
			const configPath = path.join (this.getConfigDir (), 'config.json');
			if (!fs.existsSync (configPath)) {
				const config: JungleKitConfig = {
					convention: DEFAULT_CONVENTION,
					env: DEFAULT_ENV,
					style: {
						autoCreateClangFormat: true,
					},
				};
				fs.writeFileSync (configPath, JSON.stringify (config, null, 2));
			}

			// Create subdirectories
			const dirs = ['notes'];
			for (const dir of dirs) {
				const dirPath = path.join (this.getConfigDir (), dir);
				if (!fs.existsSync (dirPath)) {
					fs.mkdirSync (dirPath, { recursive: true });
				}
			}

			// Add notes to .gitignore (local-only)
			await this.ensureGitignoreEntry ('notes/');

			console.log ('[Annotation] initialized: .annotation/ created');
		} catch (err: any) {
			vscode.window.showErrorMessage (`[Annotation] 프로젝트 초기화 실패: ${err.message || err}`);
		}
	}

loadEnvConfig (): EnvConfig {
		const configPath = path.join (this.getConfigDir (), 'config.json');
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

	/**
	 * 익스텐션 번들의 resources/conventions/ 에서 컨벤션 파일을 읽는다.
	 * 사용자가 파일을 직접 수정하면 AI 프롬프트에 반영된다.
	 */
	loadConventionFile (fileName: string): string {
		const extPath = this.context.extensionPath;
		const filePath = path.join (extPath, 'resources', 'conventions', fileName);

		try {
			return fs.readFileSync (filePath, 'utf-8');
		} catch {
			console.warn (`[Annotation] convention file not found: ${filePath}`);
			return '';
		}
	}

	private async ensureGitignoreEntry (entry: string): Promise<void> {
		const root = this.getWorkspaceRoot ();
		if (!root) { return; }
		try {
			const gitignorePath = path.join (root, '.gitignore');
			let content = '';
			try { content = fs.readFileSync (gitignorePath, 'utf-8'); } catch { /* 파일 없으면 새로 생성 */ }
			if (!content.includes (entry)) {
				content += `\n${entry}\n`;
				fs.writeFileSync (gitignorePath, content);
			}
		} catch (err) {
			console.warn ('[Annotation] .gitignore 업데이트 실패:', err);
		}
	}
}
