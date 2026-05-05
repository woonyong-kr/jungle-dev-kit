import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify (exec);

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/** shell 인자에 사용 가능한 안전한 git ref 문자만 허용 */
export function sanitizeRef (ref: string): string {
	return ref.replace (/[^a-zA-Z0-9_./~^@{}-]/g, '');
}

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
}

export class GitUtils {
	/** 매 호출 시 최신 워크스페이스 루트를 반환 (멀티루트·폴더 변경 대응) */
	private getCwd (): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	}

	private async run (cmd: string, timeout = 30000): Promise<string> {
		const cwd = this.getCwd ();
		if (!cwd) { return ''; }
		try {
			const { stdout } = await execAsync (cmd, { cwd, maxBuffer: MAX_BUFFER, timeout });
			return stdout.trim ();
		} catch (error: any) {
			console.warn (`[Annotation] git command failed: ${cmd.substring (0, 80)}`, error.message || '');
			return error.stdout?.trim () ?? '';
		}
	}

	async getCurrentBranch (): Promise<string> {
		return this.run ('git branch --show-current');
	}

	async getStagedDiff (): Promise<string> {
		return this.run ('git diff --cached');
	}

	async getDiffAgainst (base: string): Promise<string> {
		const current = await this.getCurrentBranch ();
		if (!current || !base) { return ''; }
		return this.run (`git diff ${sanitizeRef (base)}..${sanitizeRef (current)}`);
	}

	async getStagedFiles (): Promise<DiffFile[]> {
		const output = await this.run ('git diff --cached --numstat');
		return this.parseNumstat (output);
	}

	async getChangedFiles (base: string): Promise<DiffFile[]> {
		const current = await this.getCurrentBranch ();
		if (!current) { return []; }
		const output = await this.run (
			`git diff --numstat ${sanitizeRef (base)}..${sanitizeRef (current)}`
		);
		return this.parseNumstat (output);
	}

	async getAheadBehind (
		base: string
	): Promise<{ ahead: number; behind: number }> {
		const current = await this.getCurrentBranch ();
		if (!current) { return { ahead: 0, behind: 0 }; }
		const output = await this.run (
			`git rev-list --left-right --count ${sanitizeRef (base)}...${sanitizeRef (current)}`
		);
		const parts = output.split ('\t').map (Number);
		const behind = parts[0] || 0;
		const ahead = parts[1] || 0;
		return { ahead, behind };
	}

	async getRecentCommits (
		branch: string,
		count: number = 5
	): Promise<
		{ hash: string; author: string; message: string; date: string }[]
	> {
		const SEP = '__|__';
		const output = await this.run (
			`git log ${sanitizeRef (branch)} -${Math.max (1, Math.min (count, 100))} --format="%H${SEP}%an${SEP}%s${SEP}%ar"`
		);
		return output
			.split ('\n')
			.filter ((l) => l.length > 0)
			.map ((line) => {
				const parts = line.split (SEP);
				return {
					hash: parts[0] || '',
					author: parts[1] || '',
					message: parts[2] || '',
					date: parts[3] || '',
				};
			});
	}

	async getAllBranches (): Promise<string[]> {
		const output = await this.run (
			'git branch -a --format="%(refname:short)"'
		);
		return output.split ('\n').filter ((l) => l.length > 0);
	}

	async getLocalBranches (): Promise<string[]> {
		const output = await this.run (
			'git branch --format="%(refname:short)"'
		);
		return output.split ('\n').filter ((l) => l.length > 0);
	}

	async undoLastCommit (): Promise<void> {
		const cwd = this.getCwd ();
		if (!cwd) {
			vscode.window.showErrorMessage ('워크스페이스가 열려있지 않습니다.');
			return;
		}
		const confirm = await vscode.window.showWarningMessage (
			'마지막 커밋을 취소하고 변경사항을 staged로 되돌리겠습니까?',
			'취소 (soft reset)',
			'아니오'
		);
		if (confirm === '취소 (soft reset)') {
			try {
				await execAsync ('git reset --soft HEAD~1', {
					cwd,
					maxBuffer: MAX_BUFFER,
				});
				vscode.window.showInformationMessage (
					'마지막 커밋이 취소되었습니다. 변경사항은 staged에 있습니다.'
				);
			} catch (err: any) {
				vscode.window.showErrorMessage (
					`커밋 되돌리기 실패: ${err.message || err}`
				);
			}
		}
	}

	async fetch (): Promise<void> {
		await this.run ('git fetch --all --prune');
	}

	/**
	 * git diff --numstat 출력을 파싱한다.
	 * NOTE: --numstat 은 상태(A/M/D/R)를 제공하지 않으므로 기본값 'M'을 사용한다.
	 * 정확한 상태가 필요하면 --name-status 를 별도로 호출해서 병합해야 한다.
	 */
	private parseNumstat (output: string): DiffFile[] {
		return output
			.split ('\n')
			.filter ((l) => l.length > 0)
			.filter ((line) => !line.startsWith ('-\t-\t')) // 바이너리 파일 제외
			.map ((line) => {
				const parts = line.split ('\t');
				const filePath = parts.slice (2).join ('\t'); // 리네임 시 경로에 탭 포함 가능
				return {
					path: filePath || '',
					additions: parseInt (parts[0]) || 0,
					deletions: parseInt (parts[1]) || 0,
				};
			})
			.filter ((f) => f.path.length > 0);
	}
}
