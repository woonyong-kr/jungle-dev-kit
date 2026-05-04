import * as vscode from 'vscode';

const SECRET_KEY = 'jungleKit.openaiApiKey';

/**
 * API key manager using VS Code SecretStorage.
 * Keys are stored in the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux libsecret). Never written to disk as plaintext.
 */
export class APIKeyManager {
	private secrets: vscode.SecretStorage;

	constructor (context: vscode.ExtensionContext) {
		this.secrets = context.secrets;
	}

	async getKey (): Promise<string | undefined> {
		return this.secrets.get (SECRET_KEY);
	}

	async setKey (): Promise<void> {
		const key = await vscode.window.showInputBox ({
			prompt: 'OpenAI API Key를 입력하세요',
			placeHolder: 'sk-...',
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value.startsWith ('sk-')) {
					return 'API Key는 sk-로 시작해야 합니다';
				}
				if (value.length < 20) {
					return 'API Key가 너무 짧습니다';
				}
				return null;
			},
		});

		if (key) {
			await this.secrets.store (SECRET_KEY, key);
			vscode.window.showInformationMessage (
				'API Key가 안전하게 저장되었습니다 (OS Keychain)'
			);
		}
	}

	async removeKey (): Promise<void> {
		const confirm = await vscode.window.showWarningMessage (
			'저장된 API Key를 삭제하시겠습니까?',
			'삭제',
			'취소'
		);
		if (confirm === '삭제') {
			await this.secrets.delete (SECRET_KEY);
			vscode.window.showInformationMessage ('API Key가 삭제되었습니다');
		}
	}

	async requireKey (): Promise<string | undefined> {
		const key = await this.getKey ();
		if (!key) {
			const action = await vscode.window.showWarningMessage (
				'AI 기능을 사용하려면 OpenAI API Key가 필요합니다',
				'지금 등록',
				'취소'
			);
			if (action === '지금 등록') {
				await this.setKey ();
				return this.getKey ();
			}
			return undefined;
		}
		return key;
	}
}
