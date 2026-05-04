import * as vscode from 'vscode';
import { ConfigManager, AI_DIFF_TRUNCATE_LIMIT } from '../utils/configManager';
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
			vscode.window.showWarningMessage (
				'스테이징된 변경사항이 없습니다. git add 후 다시 시도하세요.'
			);
			return;
		}

		await vscode.window.withProgress (
			{
				location: vscode.ProgressLocation.Notification,
				title: '[Annotation] 커밋 메시지 생성 중...',
				cancellable: false,
			},
			async () => {
				try {
					const suggestions = await this.callAI (key, diff);
					await this.showSuggestions (suggestions);
				} catch (error: any) {
					vscode.window.showErrorMessage (
						`[Annotation] 커밋 메시지 생성 실패: ${error.message || error}`
					);
				}
			}
		);
	}

	private async callAI (apiKey: string, diff: string): Promise<string> {
		const model = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<string> ('ai.model', 'gpt-4o-mini');

		const trimmedDiff = diff.length > AI_DIFF_TRUNCATE_LIMIT
			? diff.substring (0, AI_DIFF_TRUNCATE_LIMIT) + '\n... (truncated)'
			: diff;

		let OpenAI: any;
		try {
			OpenAI = (await import ('openai')).default;
		} catch {
			throw new Error ('openai 모듈을 찾을 수 없습니다. 익스텐션을 재설치하세요.');
		}
		const client = new OpenAI ({ apiKey });

		const completion = await client.chat.completions.create ({
			model,
			messages: [
				{ role: 'system', content: this.config.loadConventionFile ('commit-convention.md') },
				{ role: 'user', content: trimmedDiff },
			],
			temperature: 0.3,
			max_completion_tokens: 500,
		});

		const response = completion.choices[0]?.message?.content || '';
		return this.parseResponse (response);
	}

	private parseResponse (response: string): string {
		// 코드블록(```)이 포함된 경우 내부 텍스트만 추출
		const codeBlockMatch = response.match (/```[\s\S]*?\n([\s\S]*?)```/);
		if (codeBlockMatch) {
			return codeBlockMatch[1].trim ();
		}
		return response.trim ();
	}

	private async showSuggestions (suggestions: string): Promise<void> {
		if (!suggestions) {
			vscode.window.showWarningMessage ('커밋 메시지를 생성하지 못했습니다.');
			return;
		}

		// SCM input box에 바로 설정
		const gitExt = vscode.extensions.getExtension ('vscode.git');
		if (!gitExt) {
			vscode.window.showWarningMessage ('Git 확장을 찾을 수 없습니다. 커밋 메시지를 클립보드에 복사합니다.');
			await vscode.env.clipboard.writeText (suggestions);
			return;
		}
		if (!gitExt.isActive) {
			await gitExt.activate ();
		}
		const gitApi = gitExt.exports.getAPI (1);
		if (!gitApi || gitApi.repositories.length === 0) {
			vscode.window.showWarningMessage ('Git 리포지토리를 찾을 수 없습니다. 커밋 메시지를 클립보드에 복사합니다.');
			await vscode.env.clipboard.writeText (suggestions);
			return;
		}
		gitApi.repositories[0].inputBox.value = suggestions;
		vscode.window.showInformationMessage (
			`[Annotation] 커밋 메시지가 설정되었습니다.`
		);
	}
}
