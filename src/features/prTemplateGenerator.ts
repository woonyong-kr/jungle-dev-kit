import * as vscode from 'vscode';
import { GitUtils } from '../utils/gitUtils';

export class PRTemplateGenerator {
	private git: GitUtils;

	constructor (git: GitUtils) {
		this.git = git;
	}

	async generate (): Promise<void> {
		const branch = await this.git.getCurrentBranch ();
		const base = await vscode.window.showInputBox ({
			prompt: '비교 대상 브랜치',
			value: 'dev',
		});
		if (!base) {return;}

		const files = await this.git.getChangedFiles (base);
		const functions = await this.git.getChangedFunctions (base);
		const { ahead } = await this.git.getAheadBehind (base);

		let template = `## ${branch} -> ${base}\n\n`;
		template += `### Summary\n`;
		template += `- Commits: ${ahead}\n`;
		template += `- Changed files: ${files.length}\n\n`;
		template += `### Changed Files\n\n`;
		template += `| File | Additions | Deletions |\n`;
		template += `|------|-----------|----------|\n`;
		for (const f of files) {
			template += `| ${f.path} | +${f.additions} | -${f.deletions} |\n`;
		}
		template += `\n### Modified Functions\n\n`;
		for (const fn of functions) {
			template += `- ${fn}\n`;
		}
		template += `\n### Test Results\n\n`;
		template += `<!-- paste make check result here -->\n`;

		const doc = await vscode.workspace.openTextDocument ({
			content: template,
			language: 'markdown',
		});
		await vscode.window.showTextDocument (doc);
	}
}
