import * as vscode from 'vscode';
import { StyleEnforcer } from './features/styleEnforcer';
import { DuplicateDetector } from './features/duplicateDetector';
import { GitConventionGuard } from './features/gitConventionGuard';
import { BranchManager } from './features/branchManager';
import { PullReminder } from './features/pullReminder';
import { LocalComments } from './features/localComments';
import { PRTemplateGenerator } from './features/prTemplateGenerator';
import { EnvironmentValidator } from './features/environmentValidator';
import { GitGuidePanel } from './features/gitGuidePanel';
import { TeamProgress } from './features/teamProgress';
import { AIReview } from './features/aiReview';
import { PanicAnalyzer } from './features/panicAnalyzer';
import { TestFailureExplainer } from './features/testFailureExplainer';
import { SmartCommit } from './features/smartCommit';
import { KnowledgeBase } from './features/knowledgeBase';
import { APIKeyManager } from './utils/apiKeyManager';
import { ConfigManager } from './utils/configManager';
import { GitUtils } from './utils/gitUtils';

export async function activate (context: vscode.ExtensionContext) {
	const config = new ConfigManager (context);
	const git = new GitUtils ();
	const apiKeys = new APIKeyManager (context);
	const kb = new KnowledgeBase (config);

	// --- Core features (no AI) ---
	const style = new StyleEnforcer (config);
	const duplicates = new DuplicateDetector (config);
	const convention = new GitConventionGuard (config, git);
	const branch = new BranchManager (config, git);
	const pull = new PullReminder (config, git);
	const localComments = new LocalComments (context, config);
	const prTemplate = new PRTemplateGenerator (git);
	const envValidator = new EnvironmentValidator (config);
	const gitGuide = new GitGuidePanel (git);
	const teamProgress = new TeamProgress (config, git);

	// --- AI features (require API key) ---
	const aiReview = new AIReview (config, apiKeys, git, kb);
	const panic = new PanicAnalyzer (config, apiKeys, kb);
	const testExplain = new TestFailureExplainer (config, apiKeys, kb);
	const smartCommit = new SmartCommit (config, apiKeys, git);

	// Register commands
	const commands: [string, () => Promise<void> | void][] = [
		['jungleKit.init', () => config.initProject ()],
		['jungleKit.styleCheck', () => style.checkCurrentFile ()],
		['jungleKit.duplicateCheck', () => duplicates.checkWorkspace ()],
		['jungleKit.mergePreview', () => branch.mergePreview ()],
		['jungleKit.pullAndPush', () => pull.pullAndPush ()],
		['jungleKit.undoLastCommit', () => git.undoLastCommit ()],
		['jungleKit.addLocalNote', () => localComments.addNote ()],
		['jungleKit.generatePRTemplate', () => prTemplate.generate ()],
		['jungleKit.updateProgress', () => teamProgress.updateMyProgress ()],
		['jungleKit.validateEnv', () => envValidator.validate ()],
		['jungleKit.aiReview', () => aiReview.reviewCurrentChanges ()],
		['jungleKit.analyzePanic', () => panic.analyzeFromTerminal ()],
		['jungleKit.explainTestFailure', () => testExplain.explain ()],
		['jungleKit.generateCommitMessage', () => smartCommit.generate ()],
		['jungleKit.setApiKey', () => apiKeys.setKey ()],
		['jungleKit.removeApiKey', () => apiKeys.removeKey ()],
	];

	for (const [id, handler] of commands) {
		context.subscriptions.push (
			vscode.commands.registerCommand (id, handler)
		);
	}

	// Auto-activate features
	await style.activate (context);
	await convention.activate (context);
	await branch.activate (context);
	await pull.activate (context);
	await localComments.activate ();
	await envValidator.validateOnStartup ();

	// Register tree views
	vscode.window.registerTreeDataProvider ('jungleKit.gitGuide', gitGuide);
	vscode.window.registerTreeDataProvider ('jungleKit.teamProgress', teamProgress);
	vscode.window.registerTreeDataProvider ('jungleKit.reviewHistory', aiReview);

	vscode.window.showInformationMessage ('Jungle Dev Kit activated');
}

export function deactivate () {}
