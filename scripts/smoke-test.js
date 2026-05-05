const fs = require('fs');
const path = require('path');

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function readText(relativePath) {
	return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function listCommandIdsFromPackage(pkg) {
	return new Set((pkg.contributes?.commands || []).map((item) => item.command));
}

function listRegisteredCommandIds(extensionSource) {
	const matches = [...extensionSource.matchAll(/\['(jungleKit\.[^']+)'/g)];
	return new Set(matches.map((match) => match[1]));
}

function main() {
	const pkgPath = path.join(process.cwd(), 'package.json');
	const outMainPath = path.join(process.cwd(), 'out', 'extension.js');
	assert(fs.existsSync(pkgPath), 'package.json이 없습니다.');
	assert(fs.existsSync(outMainPath), '빌드 산출물 out/extension.js가 없습니다. 먼저 compile이 필요합니다.');

	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const extensionSource = readText('src/extension.ts');
	const readme = readText('README.md');

	const contributedCommands = listCommandIdsFromPackage(pkg);
	const registeredCommands = listRegisteredCommandIds(extensionSource);

	for (const commandId of contributedCommands) {
		assert(
			registeredCommands.has(commandId),
			`package.json에 선언된 명령이 extension.ts에 등록되지 않았습니다: ${commandId}`
		);
	}

	assert(
		pkg.activationEvents.includes('workspaceContains:.annotation/config.json'),
		'activationEvents에 .annotation/config.json 항목이 없습니다.'
	);
	assert(
		pkg.activationEvents.includes('workspaceContains:**/*.h'),
		'activationEvents에 헤더 파일(.h) 항목이 없습니다.'
	);
	assert(
		!pkg.activationEvents.includes('workspaceContains:.jungle-kit/config.json'),
		'레거시 .jungle-kit activationEvent가 남아 있습니다.'
	);
	assert(
		!readme.includes('.jungle-kit/'),
		'README에 레거시 .jungle-kit 경로가 남아 있습니다.'
	);
	assert(
		!readme.includes('`jungleKit.project`'),
		'README에 제거된 jungleKit.project 설정이 남아 있습니다.'
	);

	console.log('Smoke test passed.');
	console.log(`Verified ${contributedCommands.size} contributed commands.`);
}

try {
	main();
} catch (error) {
	console.error('[smoke-test] failed:', error.message || error);
	process.exit(1);
}
