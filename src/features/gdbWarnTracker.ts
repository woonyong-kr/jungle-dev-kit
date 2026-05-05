import * as vscode from 'vscode';
import * as path from 'path';

/**
 * GDB Debug Console Warn Tracker
 *
 * 디버그 콘솔 출력을 감시하여 breakpoint hit, signal, kernel panic 발생 시
 * 해당 위치에 @warn 어노테이션을 자동 삽입한다.
 */
export class GdbWarnTracker {

	private _insertedLocations = new Set<string> ();

	activate (context: vscode.ExtensionContext): void {
		const factory = vscode.debug.registerDebugAdapterTrackerFactory ('*', {
			createDebugAdapterTracker: () => this.createTracker (),
		});
		context.subscriptions.push (factory);

		// 세션 종료 시 중복 방지 셋 초기화
		context.subscriptions.push (
			vscode.debug.onDidTerminateDebugSession (() => {
				this._insertedLocations.clear ();
				this._pendingSignal = null;
			})
		);
	}

	private createTracker (): vscode.DebugAdapterTracker {
		return {
			onDidSendMessage: (message: any) => {
				if (message.type !== 'event' || message.event !== 'output') { return; }
				const output: string = message.body?.output || '';
				if (!output) { return; }

				// 각 줄을 개별 파싱
				for (const line of output.split ('\n')) {
					this.parseLine (line.trim ());
				}
			},
		};
	}

	private parseLine (line: string): void {
		let match: RegExpMatchArray | null;

		// Pattern 1: Breakpoint hit
		// "Breakpoint 1, main () at ../../threads/init.c:76"
		match = line.match (/^Breakpoint\s+(\d+),\s*(.+?)\s+at\s+(.+):(\d+)/);
		if (match) {
			const bpNum = match[1];
			const func = match[2].replace (/\s*\(.*\)/, ''); // 함수명만
			const file = match[3];
			const lineNum = parseInt (match[4], 10);
			this.insertWarn (file, lineNum, `${func}() — Breakpoint ${bpNum} hit`);
			return;
		}

		// Pattern 2: Signal received
		// "Program received signal SIGSEGV, Segmentation fault."
		// 뒤에 위치 정보가 같은 출력 블록에 올 수 있으므로 별도 처리
		match = line.match (/^Program received signal (\w+)/);
		if (match) {
			this._pendingSignal = match[1];
			return;
		}

		// Pattern 2b: Signal 후 위치 정보
		// "0x00000000004011a3 in func_name () at file.c:42"
		// 또는 "func_name () at file.c:42"
		if (this._pendingSignal) {
			match = line.match (/(?:in\s+)?(.+?)\s+(?:\(.*?\)\s+)?at\s+(.+):(\d+)/);
			if (match) {
				const func = match[1].replace (/^0x[0-9a-f]+\s+in\s+/, '').replace (/\s*\(.*\)/, '');
				const file = match[2];
				const lineNum = parseInt (match[3], 10);
				this.insertWarn (file, lineNum, `${func}() — ${this._pendingSignal}`);
				this._pendingSignal = null;
				return;
			}
		}

		// Pattern 3: Kernel PANIC
		// "Kernel PANIC at ../../userprog/process.c:156"
		// 또는 "PANIC at ..."
		match = line.match (/(?:Kernel\s+)?PANIC\s+at\s+(.+):(\d+)/i);
		if (match) {
			const file = match[1];
			const lineNum = parseInt (match[2], 10);
			const reason = line.replace (/.*PANIC\s+at\s+.+:\d+\s*/, '').trim ();
			this.insertWarn (file, lineNum, `PANIC${reason ? ' — ' + reason : ''}`);
			return;
		}

		// Pattern 4: assertion failure
		// "ASSERT FAILED at ../../threads/thread.c:300"
		match = line.match (/ASSERT\s+FAILED?\s+at\s+(.+):(\d+)/i);
		if (match) {
			const file = match[1];
			const lineNum = parseInt (match[2], 10);
			this.insertWarn (file, lineNum, 'ASSERT FAILED');
			return;
		}

		// 매칭 안 되면 pending signal 리셋 (다음 줄에 위치 정보 없음)
		if (this._pendingSignal && !line.match (/^\s*$/)) {
			// 빈 줄이 아닌데 위치 매칭 안 되면 signal만 기록 (위치 불명)
			this._pendingSignal = null;
		}
	}

	private _pendingSignal: string | null = null;

	private async insertWarn (rawFile: string, lineNum: number, content: string): Promise<void> {
		// 중복 방지
		const key = `${rawFile}:${lineNum}`;
		if (this._insertedLocations.has (key)) { return; }
		this._insertedLocations.add (key);

		// 파일 경로 해석: 상대 경로를 워크스페이스 기준으로 변환
		const uri = await this.resolveFileUri (rawFile);
		if (!uri) {
			console.log (`[Annotation] GDB warn: 파일을 찾을 수 없음 — ${rawFile}`);
			return;
		}

		try {
			const doc = await vscode.workspace.openTextDocument (uri);
			// 0-based line index (GDB는 1-based)
			const targetLine = Math.max (0, lineNum - 1);
			if (targetLine >= doc.lineCount) { return; }

			// 이미 해당 줄에 @warn 이 있으면 스킵
			const existingText = doc.lineAt (targetLine).text;
			if (existingText.match (/\/\*\s*@warn\b/)) { return; }

			// indent 결정
			const indent = existingText.match (/^(\s*)/)?.[1] || '';
			const safeContent = content.replace (/\*\//g, '* /');
			const commentText = `${indent}/* @warn ${safeContent} */\n`;

			const edit = new vscode.WorkspaceEdit ();
			edit.insert (uri, new vscode.Position (targetLine, 0), commentText);
			await vscode.workspace.applyEdit (edit);

			console.log (`[Annotation] GDB @warn 자동 삽입: ${rawFile}:${lineNum} — ${content}`);
		} catch (err) {
			console.error ('[Annotation] GDB warn insert failed:', err);
		}
	}

	/** 상대 경로 (../../threads/init.c) → 워크스페이스 절대 URI */
	private async resolveFileUri (rawFile: string): Promise<vscode.Uri | null> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) { return null; }

		const root = folders[0].uri.fsPath;

		// 1) 절대 경로인 경우 그대로
		if (path.isAbsolute (rawFile)) {
			const uri = vscode.Uri.file (rawFile);
			try {
				await vscode.workspace.fs.stat (uri);
				return uri;
			} catch { return null; }
		}

		// 2) 상대 경로: ../../ 접두어 제거 후 워크스페이스에서 검색
		const normalized = rawFile.replace (/^(\.\.\/)+/, '');

		// glob 검색으로 파일 찾기
		const pattern = `**/${normalized}`;
		const files = await vscode.workspace.findFiles (pattern, '**/build/**', 1);
		if (files.length > 0) { return files[0]; }

		// 3) 직접 결합 시도
		const direct = path.resolve (root, rawFile);
		const directUri = vscode.Uri.file (direct);
		try {
			await vscode.workspace.fs.stat (directUri);
			return directUri;
		} catch { return null; }
	}
}
