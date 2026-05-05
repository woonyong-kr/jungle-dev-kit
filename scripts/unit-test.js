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
	debug: {
		registerDebugAdapterTrackerFactory: () => ({ dispose() {} }),
		onDidTerminateDebugSession: (callback) => {
			vscodeStub.__onTerminateDebugSession = callback;
			return { dispose() {} };
		},
	},
	__onTerminateDebugSession: null,
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
const { GdbWarnTracker } = require('../out/features/gdbWarnTracker.js');

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

async function testInitProjectAddsExactGitignoreRuleEvenWithSimilarEntry() {
	await withTempWorkspace(async (workspaceRoot) => {
		fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), '.annotation/notes-archive/\n');
		const manager = new ConfigManager({ extensionPath: workspaceRoot });
		await manager.initProject();

		const gitignore = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
		const lines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

		assert(
			lines.includes('.annotation/notes/'),
			'initProject should add the exact .annotation/notes/ rule even when a similar rule already exists'
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

	const trailingSlashRemote = GitHubPrClient.parseGitHubRemote('https://github.com/owner/repo.git/');
	assert(trailingSlashRemote, 'parseGitHubRemote should parse remotes with a trailing slash');
	assert.strictEqual(
		trailingSlashRemote.repo,
		'repo',
		'parseGitHubRemote should normalize trailing slashes instead of keeping .git in the repo name'
	);
}

function testGdbWarnTrackerClearsPendingSignalOnSessionEnd() {
	vscodeStub.__onTerminateDebugSession = null;
	const tracker = new GdbWarnTracker();
	const inserted = [];
	tracker.insertWarn = (file, line, content) => {
		inserted.push({ file, line, content });
	};

	tracker.activate({ subscriptions: [] });
	tracker.parseLine('Program received signal SIGSEGV, Segmentation fault.');
	assert(vscodeStub.__onTerminateDebugSession, 'activate should register a debug-session termination handler');

	vscodeStub.__onTerminateDebugSession();
	tracker.parseLine('func_name () at file.c:42');

	assert.deepStrictEqual(
		inserted,
		[],
		'pending signals from a previous debug session should not leak into the next session'
	);
}

function testGdbWarnTrackerIgnoresBreakpointHits() {
	const tracker = new GdbWarnTracker();
	const inserted = [];
	tracker.insertWarn = (file, line, content) => {
		inserted.push({ file, line, content });
	};

	tracker.parseLine('Breakpoint 1, main () at ../../threads/init.c:76');

	assert.deepStrictEqual(
		inserted,
		[],
		'user-created breakpoint stops should not be treated as warn-worthy errors'
	);
}

function testGdbWarnTrackerStillCapturesSignals() {
	const tracker = new GdbWarnTracker();
	const inserted = [];
	tracker.insertWarn = (file, line, content) => {
		inserted.push({ file, line, content });
	};

	tracker.parseLine('Program received signal SIGSEGV, Segmentation fault.');
	tracker.parseLine('0x00000000004011a3 in func_name () at userprog/process.c:42');

	assert.deepStrictEqual(
		inserted,
		[{ file: 'userprog/process.c', line: 42, content: 'func_name() — SIGSEGV' }],
		'actual crash signals should still produce a warn marker'
	);
}

async function main() {
	await testInitProjectIgnoresAnnotationNotes();
	await testInitProjectAddsExactGitignoreRuleEvenWithSimilarEntry();
	await testLoadEnvConfigMergesChecksDeeply();
	testParseGitHubRemoteDoesNotTreatPlainUsernameAsToken();
	testGdbWarnTrackerClearsPendingSignalOnSessionEnd();
	testGdbWarnTrackerIgnoresBreakpointHits();
	testGdbWarnTrackerStillCapturesSignals();
	console.log('Unit test passed.');
}

main().catch((error) => {
	console.error('[unit-test] failed:', error.message || error);
	process.exit(1);
});
