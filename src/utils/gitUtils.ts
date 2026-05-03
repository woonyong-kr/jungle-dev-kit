import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DIFF_FILE_EXTENSIONS } from './configManager';

const execAsync = promisify (exec);

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/** shell 인자에 사용 가능한 안전한 git ref 문자만 허용 */
function sanitizeRef (ref: string): string {
	return ref.replace (/[^a-zA-Z0-9_\-\/.~^@{}]/g, '');
}

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	status: 'A' | 'M' | 'D' | 'R';
}

export class GitUtils {
	private cwd: string;

	constructor () {
		this.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	}

	private async run (cmd: string): Promise<string> {
		try {
			const { stdout } = await execAsync (cmd, {
				cwd: this.cwd,
				maxBuffer: MAX_BUFFER,
			});
			return stdout.trim ();
		} catch (error: any) {
			return error.stdout?.trim () ?? '';
		}
	}

	async getCurrentBranch (): Promise<string> {
		return this.run ('git branch --show-current');
	}

	async isDetachedHead (): Promise<boolean> {
		const branch = await this.getCurrentBranch ();
		return branch === '';
	}

	async getStagedDiff (): Promise<string> {
		return this.run ('git diff --cached');
	}

	async getUnstagedDiff (): Promise<string> {
		return this.run ('git diff');
	}

	async getDiffAgainst (base: string): Promise<string> {
		const current = await this.getCurrentBranch ();
		return this.run (`git diff ${sanitizeRef (base)}..${sanitizeRef (current)}`);
	}

	async getStagedFiles (): Promise<DiffFile[]> {
		const output = await this.run ('git diff --cached --numstat');
		return this.parseNumstat (output);
	}

	async getChangedFiles (base: string): Promise<DiffFile[]> {
		const current = await this.getCurrentBranch ();
		const output = await this.run (
			`git diff --numstat ${sanitizeRef (base)}..${sanitizeRef (current)}`
		);
		return this.parseNumstat (output);
	}

	async getChangedFunctions (base: string): Promise<string[]> {
		const current = await this.getCurrentBranch ();
		const output = await this.run (
			`git diff -U0 ${sanitizeRef (base)}..${sanitizeRef (current)} -- ${DIFF_FILE_EXTENSIONS} | grep -E '^@@.*@@' | sed 's/.*@@ //'`
		);
		return output
			.split ('\n')
			.filter ((l) => l.length > 0)
			.map ((l) => l.trim ());
	}

	async getAheadBehind (
		base: string
	): Promise<{ ahead: number; behind: number }> {
		const current = await this.getCurrentBranch ();
		const output = await this.run (
			`git rev-list --left-right --count ${sanitizeRef (base)}...${sanitizeRef (current)}`
		);
		const parts = output.split ('\t').map (Number);
		const behind = parts[0] || 0;
		const ahead = parts[1] || 0;
		return { ahead, behind };
	}

	async getRemoteAheadBehind (): Promise<{
		ahead: number;
		behind: number;
	}> {
		const branch = await this.getCurrentBranch ();
		await this.run ('git fetch origin');
		return this.getAheadBehind (`origin/${branch}`);
	}

	async getRecentCommits (
		branch: string,
		count: number = 5
	): Promise<
		{ hash: string; author: string; message: string; date: string }[]
	> {
		const output = await this.run (
			`git log ${sanitizeRef (branch)} -${Math.max (1, Math.min (count, 100))} --format="%H|%an|%s|%ar"`
		);
		return output
			.split ('\n')
			.filter ((l) => l.length > 0)
			.map ((line) => {
				const parts = line.split ('|');
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

	async isBranchMerged (branch: string, into: string): Promise<boolean> {
		const output = await this.run (
			`git branch --merged ${sanitizeRef (into)} --format="%(refname:short)"`
		);
		return output.split ('\n').includes (branch);
	}

	async getLastCommitDate (branch: string): Promise<string> {
		return this.run (
			`git log ${sanitizeRef (branch)} -1 --format="%ar"`
		);
	}

	async hasUncommittedChanges (): Promise<boolean> {
		const output = await this.run ('git status --porcelain');
		return output.length > 0;
	}

	async undoLastCommit (): Promise<void> {
		const confirm = await vscode.window.showWarningMessage (
			'마지막 커밋을 취소하고 변경사항을 staged로 되돌리겠습니까?',
			'취소 (soft reset)',
			'아니오'
		);
		if (confirm === '취소 (soft reset)') {
			await this.run ('git reset --soft HEAD~1');
			vscode.window.showInformationMessage (
				'마지막 커밋이 취소되었습니다. 변경사항은 staged에 있습니다.'
			);
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
			.map ((line) => {
				const [add, del, filePath] = line.split ('\t');
				return {
					path: filePath,
					additions: parseInt (add) || 0,
					deletions: parseInt (del) || 0,
					status: 'M' as const,
				};
			});
	}
}
