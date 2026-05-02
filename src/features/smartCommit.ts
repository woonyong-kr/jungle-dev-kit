import * as vscode from 'vscode';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';
import { GitUtils } from '../utils/gitUtils';

const COMMIT_PROMPT = `당신은 Git 커밋 메시지 작성 전문가입니다.
주어진 diff를 분석하고 아래 규칙에 맞는 커밋 메시지를 3개 제안하세요.

규칙:
- 형식: <type>: <한국어 제목>
- type: feat, fix, refactor, docs, test, chore, style, perf, build
- 제목은 한국어로, 한 줄, 마침표 없이
- 행위가 아닌 변경의 결과를 서술
- "수정", "변경", "업데이트" 같은 모호한 단어 지양
- 구체적 표현 선호 (예: "자식 노드 비교 순서를 바로잡아")

출력 형식 (엄격히 준수):
1: <type>: <제목>
2: <type>: <제목>
3: <type>: <제목>

3개만 출력하세요. 설명이나 부연은 하지 마세요.`;

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

	private async callAI (apiKey: string, diff: string): Promise<string[]> {
		const model = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<string> ('ai.model', 'gpt-4o-mini');

		const trimmedDiff = diff.length > 4000
			? diff.substring (0, 4000) + '\n... (truncated)'
			: diff;

		const OpenAI = (await import ('openai')).default;
		const client = new OpenAI ({ apiKey });

		const completion = await client.chat.completions.create ({
			model,
			messages: [
				{ role: 'system', content: COMMIT_PROMPT },
				{ role: 'user', content: trimmedDiff },
			],
			temperature: 0.3,
			max_completion_tokens: 200,
		});

		const response = completion.choices[0]?.message?.content || '';
		return this.parseResponse (response);
	}

	private parseResponse (response: string): string[] {
		const suggestions: string[] = [];
		const lines = response.split ('\n');

		for (const line of lines) {
			const match = line.match (/^\d:\s*(.+)/);
			if (match) {
				suggestions.push (match[1].trim ());
			}
		}

		// Fallback: if parsing failed, use the whole response
		if (suggestions.length === 0 && response.trim ().length > 0) {
			suggestions.push (response.trim ());
		}

		return suggestions;
	}

	private async showSuggestions (suggestions: string[]): Promise<void> {
		if (suggestions.length === 0) {
			vscode.window.showWarningMessage ('커밋 메시지를 생성하지 못했습니다.');
			return;
		}

		const selected = await vscode.window.showQuickPick (suggestions, {
			placeHolder: '커밋 메시지를 선택하세요',
			title: 'AI 커밋 메시지 제안',
		});

		if (!selected) {return;}

		// Set the selected message in the SCM input box
		const gitExt = vscode.extensions.getExtension ('vscode.git');
		if (gitExt) {
			const gitApi = gitExt.exports.getAPI (1);
			if (gitApi && gitApi.repositories.length > 0) {
				gitApi.repositories[0].inputBox.value = selected;
				vscode.window.showInformationMessage (
					`[Annotation] 커밋 메시지가 설정되었습니다.`
				);
			}
		}
	}
}
