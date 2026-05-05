const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const vscodeStub = {
	workspace: {
		workspaceFolders: null,
	},
	window: {
		showErrorMessage: () => undefined,
		showInformationMessage: () => undefined,
	},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad(request, parent, isMain);
};

const { ConfigManager } = require('../out/utils/configManager.js');
const { GitHubPrClient } = require('../out/utils/githubPrClient.js');

async function withTempWorkspace(run) {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jungle-dev-kit-'));
	vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
	try {
		return await run(workspaceRoot);
	} finally {
		vscodeStub.workspace.workspaceFolders = null;
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
}

async function testInitProjectIgnoresAnnotationNotes() {
	await withTempWorkspace(async (workspaceRoot) => {
		const manager = new ConfigManager({ extensionPath: workspaceRoot });
		await manager.initProject();

		const gitignorePath = path.join(workspaceRoot, '.gitignore');
		const gitignore = fs.readFileSync(gitignorePath, 'utf8');

		assert(
			gitignore.includes('.annotation/notes/'),
			'initProject should ignore .annotation/notes/ in the repository root .gitignore'
		);
		assert(
			!gitignore.includes('\nnotes/\n'),
			'initProject should not add a bare notes/ rule that targets the wrong directory'
		);
	});
}

async function testLoadEnvConfigMergesChecksDeeply() {
	await withTempWorkspace((workspaceRoot) => {
		const configDir = path.join(workspaceRoot, '.annotation');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'config.json'),
			JSON.stringify({
				env: {
					showOnStartup: false,
					checks: {
						gcc: false,
					},
				},
			})
		);

		const manager = new ConfigManager({ extensionPath: workspaceRoot });
		const env = manager.loadEnvConfig();

		assert.strictEqual(env.showOnStartup, false, 'loadEnvConfig should keep explicit env overrides');
		assert.strictEqual(env.checks.gcc, false, 'loadEnvConfig should keep explicit nested check overrides');
		assert.strictEqual(env.checks.qemu, true, 'loadEnvConfig should preserve default nested checks');
		assert.strictEqual(env.checks.make, true, 'loadEnvConfig should preserve all unspecified nested checks');
	});
}

function testParseGitHubRemoteDoesNotTreatPlainUsernameAsToken() {
	const plainUsernameRemote = GitHubPrClient.parseGitHubRemote('https://alice@github.com/owner/repo.git');
	assert(plainUsernameRemote, 'parseGitHubRemote should parse standard GitHub HTTPS remotes');
	assert.strictEqual(
		plainUsernameRemote.token,
		null,
		'parseGitHubRemote should not treat a plain GitHub username as an API token'
	);

	const embeddedTokenRemote = GitHubPrClient.parseGitHubRemote('https://ghp_exampleToken@github.com/owner/repo.git');
	assert(embeddedTokenRemote, 'parseGitHubRemote should parse tokenized HTTPS remotes');
	assert.strictEqual(
		embeddedTokenRemote.token,
		'ghp_exampleToken',
		'parseGitHubRemote should keep embedded PAT-style credentials'
	);
}

async function main() {
	await testInitProjectIgnoresAnnotationNotes();
	await testLoadEnvConfigMergesChecksDeeply();
	testParseGitHubRemoteDoesNotTreatPlainUsernameAsToken();
	console.log('Unit test passed.');
}

main().catch((error) => {
	console.error('[unit-test] failed:', error.message || error);
	process.exit(1);
});
