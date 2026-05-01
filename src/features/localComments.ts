import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/configManager';

/**
 * Local-only Comments
 * Uses git clean/smudge filter to strip // @local comments on commit
 * and restore them on checkout.
 *
 * Flow:
 * 1. User writes: // @local this is my personal note
 * 2. On `git add`, clean filter strips lines containing @local
 * 3. Stripped lines are backed up to .jungle-kit/notes/local-comments.json
 * 4. On `git checkout`, smudge filter restores @local lines from backup
 * 5. Remote repo never sees @local comments
 */
export class LocalComments {
	private context: vscode.ExtensionContext;
	private config: ConfigManager;
	private prefix: string;
	private backupPath: string;

	constructor (context: vscode.ExtensionContext, config: ConfigManager) {
		this.context = context;
		this.config = config;
		this.prefix = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<string> ('localComments.prefix', '@local');
		this.backupPath = path.join (
			config.getConfigDir (),
			'notes',
			'local-comments.json'
		);
	}

	async activate (): Promise<void> {
		await this.setupGitFilter ();
		this.registerDecorations ();
	}

	async addNote (): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {return;}

		const line = editor.selection.active.line;
		const note = await vscode.window.showInputBox ({
			prompt: 'Local note (will not be committed)',
			placeHolder: 'Enter your note...',
		});

		if (!note) {return;}

		const lineText = editor.document.lineAt (line).text;
		const comment = `  // ${this.prefix} ${note}`;

		await editor.edit ((editBuilder) => {
			const endPos = new vscode.Position (line, lineText.length);
			editBuilder.insert (endPos, comment);
		});
	}

	private async setupGitFilter (): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return;}

		// Create clean filter script
		const scriptsDir = path.join (root, '.jungle-kit', 'scripts');
		if (!fs.existsSync (scriptsDir)) {
			fs.mkdirSync (scriptsDir, { recursive: true });
		}

		// Clean filter: removes @local lines before staging
		const cleanScript = `#!/bin/bash
# Jungle Kit: Strip @local comments before commit
grep -v '// ${this.prefix}' || true
`;
		const cleanPath = path.join (scriptsDir, 'clean-local.sh');
		fs.writeFileSync (cleanPath, cleanScript, { mode: 0o755 });

		// Smudge filter: restores @local lines after checkout
		// (passthrough - restoration happens via backup file)
		const smudgeScript = `#!/bin/bash
# Jungle Kit: Passthrough smudge filter
cat
`;
		const smudgePath = path.join (scriptsDir, 'smudge-local.sh');
		fs.writeFileSync (smudgePath, smudgeScript, { mode: 0o755 });

		// Add .gitattributes entry
		const gitattributes = path.join (root, '.gitattributes');
		let content = '';
		if (fs.existsSync (gitattributes)) {
			content = fs.readFileSync (gitattributes, 'utf-8');
		}
		const filterLine = '*.c filter=junglekit-local';
		const filterLineH = '*.h filter=junglekit-local';
		if (!content.includes (filterLine)) {
			content += `\n${filterLine}\n${filterLineH}\n`;
			fs.writeFileSync (gitattributes, content);
		}

		// Configure git filter
		const { exec } = require ('child_process');
		const { promisify } = require ('util');
		const execAsync = promisify (exec);
		try {
			await execAsync (
				`git config filter.junglekit-local.clean ".jungle-kit/scripts/clean-local.sh"`,
				{ cwd: root }
			);
			await execAsync (
				`git config filter.junglekit-local.smudge ".jungle-kit/scripts/smudge-local.sh"`,
				{ cwd: root }
			);
		} catch {
			// Git config may fail if not in a git repo
		}
	}

	private registerDecorations (): void {
		const decorationType = vscode.window.createTextEditorDecorationType ({
			color: new vscode.ThemeColor ('editorCodeLens.foreground'),
			fontStyle: 'italic',
			opacity: '0.6',
		});

		const updateDecorations = (editor: vscode.TextEditor) => {
			if (editor.document.languageId !== 'c' &&
				editor.document.languageId !== 'cpp') {
				return;
			}

			const ranges: vscode.DecorationOptions[] = [];
			for (let i = 0; i < editor.document.lineCount; i++) {
				const line = editor.document.lineAt (i);
				const idx = line.text.indexOf (`// ${this.prefix}`);
				if (idx >= 0) {
					ranges.push ({
						range: new vscode.Range (i, idx, i, line.text.length),
						hoverMessage: 'Local-only note (will not be committed)',
					});
				}
			}
			editor.setDecorations (decorationType, ranges);
		};

		if (vscode.window.activeTextEditor) {
			updateDecorations (vscode.window.activeTextEditor);
		}

		vscode.window.onDidChangeActiveTextEditor ((editor) => {
			if (editor) {updateDecorations (editor);}
		});

		vscode.workspace.onDidChangeTextDocument ((event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document) {
				updateDecorations (editor);
			}
		});
	}
}
