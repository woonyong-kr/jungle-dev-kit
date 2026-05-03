import * as vscode from 'vscode';
import { StyleEnforcer } from './features/styleEnforcer';
// LocalComments removed — @note handled by annotation system
import { EnvironmentValidator } from './features/environmentValidator';
import { SmartCommit } from './features/smartCommit';
import { TagSystem } from './features/tagSystem';
import { ShadowDiff } from './features/shadowDiff';

import { PRPanel } from './features/prPanel';
import { APIKeyManager } from './utils/apiKeyManager';
import { ConfigManager } from './utils/configManager';
import { GitUtils } from './utils/gitUtils';

export async function activate (context: vscode.ExtensionContext) {
	const config = new ConfigManager (context);
	const git = new GitUtils ();
	const apiKeys = new APIKeyManager (context);

	// --- Core features ---
	const style = new StyleEnforcer (config);
	// localComments removed
	const envValidator = new EnvironmentValidator (config);
	const tagSystem = new TagSystem (config, apiKeys);
	const shadowDiff = new ShadowDiff (config, git);
	const smartCommit = new SmartCommit (config, apiKeys, git);
	const prPanel = new PRPanel (git, apiKeys, config, tagSystem);

	// --- Register tree views ---
	context.subscriptions.push (
		vscode.window.createTreeView ('jungleKit.tags', {
			treeDataProvider: tagSystem,
			dragAndDropController: tagSystem,
			canSelectMany: true,
		})
	);

	// --- Register commands ---
	const commands: [string, (...args: any[]) => Promise<void> | void][] = [
		// Project
		['jungleKit.init', () => config.initProject ()],
		['jungleKit.validateEnv', () => envValidator.validate ()],

		// Style
		['jungleKit.styleCheck', () => style.checkCurrentFile ()],

		// Annotations
		['jungleKit.addTodo', () => tagSystem.addTag ('todo')],
		['jungleKit.addBookmark', () => tagSystem.addTag ('bookmark')],
		['jungleKit.addReviewPoint', () => tagSystem.addTag ('review')],
		['jungleKit.addWarning', () => tagSystem.addTag ('warn')],
		['jungleKit.addBreakpoint', () => tagSystem.addTag ('breakpoint')],
		['jungleKit.resolveTagInline', (item: any) => {
			const match = item?.contextValue?.match (/tag-\w+-(.+)/);
			if (match) { tagSystem.deleteAnnotation (match[1]); }
		}],

		// Tag toolbar
		['jungleKit.addTagAtCursor', () => tagSystem.addTagAtCursor ()],
		['jungleKit.searchTags', () => tagSystem.searchTags ()],
		['jungleKit.refreshTags', () => tagSystem.refresh ()],
		['jungleKit.toggleTagView', () => tagSystem.toggleView ()],
		['jungleKit.clearAllTags', () => tagSystem.clearAllAnnotations ()],
		['jungleKit.collapseTags', () => vscode.commands.executeCommand ('workbench.actions.treeView.jungleKit.tags.collapseAll')],
		['jungleKit.nextTag', () => tagSystem.navigateTag ('next')],
		['jungleKit.prevTag', () => tagSystem.navigateTag ('prev')],
		['jungleKit.nextTagGlobal', () => tagSystem.navigateTag ('next', true)],
		['jungleKit.prevTagGlobal', () => tagSystem.navigateTag ('prev', true)],
		['jungleKit.configureShortcuts', () => tagSystem.configureShortcuts ()],
		['jungleKit.clearFileTags', (item: any) => {
			const match = item?.contextValue?.match (/tagFile-(.+)/);
			if (match) { tagSystem.clearFileAnnotations (match[1]); }
		}],
		['jungleKit.editTag', (item: any) => {
			const match = item?.contextValue?.match (/tag-\w+-(.+)/);
			if (match) { tagSystem.editAnnotation (match[1]); }
		}],
		['jungleKit.goToTag', (tag: any) => {
			if (!tag?.file) {return;}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) {return;}
			const uri = vscode.Uri.file (`${root}/${tag.file}`);
			vscode.workspace.openTextDocument (uri).then ((doc) => {
				vscode.window.showTextDocument (doc).then ((editor) => {
					const pos = new vscode.Position (tag.line, 0);
					editor.selection = new vscode.Selection (pos, pos);
					editor.revealRange (new vscode.Range (pos, pos), vscode.TextEditorRevealType.InCenter);
				});
			});
		}],

		// Shadow Diff & Sync
		['jungleKit.pullAndPush', () => shadowDiff.pullAndPush ()],
		['jungleKit.showShadowDiff', (change: any, hunk: any) => shadowDiff.showShadowDiff (change, hunk)],
		// Smart Commit
		['jungleKit.generateCommitMessage', () => smartCommit.generate ()],

		// PR
		['jungleKit.createPR', () => prPanel.openPanel ()],

		// API Key
		['jungleKit.setApiKey', () => apiKeys.setKey ()],
		['jungleKit.removeApiKey', () => apiKeys.removeKey ()],

		// Undo
		['jungleKit.undoLastCommit', () => git.undoLastCommit ()],
	];

	for (const [id, handler] of commands) {
		context.subscriptions.push (
			vscode.commands.registerCommand (id, handler)
		);
	}

	// --- Auto-activate features ---
	const activations: [string, () => Promise<void>][] = [
		['StyleEnforcer', () => style.activate (context)],
		['EnvironmentValidator', () => envValidator.validateOnStartup ()],
		['TagSystem', () => tagSystem.activate (context)],
		['ShadowDiff', () => shadowDiff.activate (context)],
	];

	for (const [name, fn] of activations) {
		try {
			await fn ();
		} catch (err) {
			console.error (`[Annotation] ${name} activation failed:`, err);
		}
	}

	// Register warn guard after tag system is active
	tagSystem.registerWarnGuard (context);

	console.log ('[Annotation] Extension activated');
}

export function deactivate () {}
