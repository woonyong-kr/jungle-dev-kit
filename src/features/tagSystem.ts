import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec as execCb, execSync } from 'child_process';
import { promisify } from 'util';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';

const execAsync = promisify (execCb);

/**
 * Annotation System (Phase 1 + Phase 2)
 *
 * 주석 기반 코드 어노테이션.
 * 주석은 파일에 그대로 유지하고, git clean filter로 diff에서 제외.
 * gutter 아이콘 + 배경 하이라이트로 에디터에 시각 표시.
 *
 * 태그 종류 (표시 순서):
 * - @bookmark : 북마크 (파랑 #4FC3F7)
 * - @todo     : 할 일 (녹색 #66BB6A)
 * - @review   : 리뷰 (골드 #FFD54F) — 커밋 단위 그룹핑
 * - @warn     : 경고 (빨강 #EF5350)
 *
 * 동작 흐름:
 * 1. 사용자가 // @todo 내용 또는 블록 주석으로 작성
 * 2. 주석은 파일에 그대로 유지 (편집/삭제 자유)
 * 3. gutter 아이콘 + 배경 하이라이트 표시
 * 4. git clean filter로 커밋 시 자동 제거 → diff에 노출 안 됨
 * 5. @note 주석도 동일하게 파일 유지 + diff 제외 (사이드바엔 미표시)
 */

type AnnotationType = 'todo' | 'bookmark' | 'review' | 'warn' | 'breakpoint' | 'region' | 'endregion';

interface Annotation {
	id: string;
	type: AnnotationType;
	file: string;
	line: number;
	lineEnd?: number;  // 여러 줄 블록 주석의 끝 줄 (단일 줄이면 line과 동일)
	content: string;
	displayLabel: string | null;  // 사이드바 표시용 커스텀 제목
	createdAt: string;
	commitHash: string | null;
	author: string | null;
	sortOrder?: number;  // 사용자 드래그 정렬 순서
	virtual?: boolean;   // true이면 사이드바 전용 (파일에 주석 없음, 진단/diff 자동 생성)
}

interface AnnotationsData {
	version: number;
	annotations: Annotation[];
}

interface ShortcutEntry {
	id: string;
	label: string;
	command: string;
	key: string;
	mac?: string;
}

const TAG_COLORS: Record<AnnotationType, string> = {
	todo: '#66BB6A',
	bookmark: '#4FC3F7',
	review: '#FFD54F',
	warn: '#EF5350',
	breakpoint: '#FF7043',
	region: '#B39DDB',
	endregion: '#B39DDB',
};

const TAG_BG_COLORS: Record<AnnotationType, string> = {
	todo: 'rgba(102, 187, 106, 0.12)',
	bookmark: 'rgba(79, 195, 247, 0.10)',
	review: 'rgba(255, 213, 79, 0.12)',
	warn: 'rgba(239, 83, 80, 0.12)',
	breakpoint: 'rgba(255, 112, 67, 0.14)',
	region: 'rgba(179, 157, 219, 0.10)',
	endregion: 'rgba(179, 157, 219, 0.10)',
};

const TAG_TEXT_COLORS: Record<AnnotationType, string> = {
	todo: '#66BB6A',
	bookmark: '#4FC3F7',
	review: '#FFD54F',
	warn: '#EF5350',
	breakpoint: '#FF7043',
	region: '#B39DDB',
	endregion: '#B39DDB',
};

const TAG_LABELS: Record<AnnotationType, string> = {
	todo: '할 일',
	bookmark: '북마크',
	review: '리뷰',
	warn: '경고',
	breakpoint: '브레이크포인트',
	region: '리전',
	endregion: '리전 끝',
};

const ALL_TAG_TYPES: AnnotationType[] = ['bookmark', 'todo', 'review', 'warn', 'breakpoint', 'region', 'endregion'];

// 주석 패턴 (파일 스캔용)
const SINGLE_LINE_RE = /^(\s*)\/\/\s*@(bookmark|todo|review|warn|breakpoint|region|endregion)(?:\s+(.+))?$/;
const BLOCK_SINGLE_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint|region|endregion)(?:\s+(.+?))?\s*\*\/$/;
const BLOCK_START_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint|region|endregion)\b(.*)$/;

export class TagSystem implements vscode.TreeDataProvider<TagTreeItem>, vscode.TreeDragAndDropController<TagTreeItem> {
	readonly dropMimeTypes = ['application/vnd.code.tree.jungleKit.tags'];
	readonly dragMimeTypes = ['application/vnd.code.tree.jungleKit.tags'];

	private config: ConfigManager;
	private apiKeys: APIKeyManager | null = null;
	private context!: vscode.ExtensionContext;
	private annotations: Annotation[] = [];
	private dataFilePath: string = '';
	private decorationTypes: Map<AnnotationType, vscode.TextEditorDecorationType> = new Map ();
	private _lastKnownHead: string | null = null;
	private _groupByFile = false;
	private _scanTimer: NodeJS.Timeout | null = null;
	private filterType: AnnotationType | null = null;
	private filterText: string | null = null;
	private _onDidChangeTreeData = new vscode.EventEmitter<void> ();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor (config: ConfigManager, apiKeys?: APIKeyManager) {
		this.config = config;
		this.apiKeys = apiKeys || null;
	}

	async activate (context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		this.dataFilePath = path.join (root, '.jungle-kit', 'annotations.json');
		this.ensureGitignore (root);
		this.loadAnnotations ();
		this.createDecorationTypes ();
		this.registerDocumentListeners (context);
		this.registerCompletionProvider (context);
		this.registerAutoReview (context);
		this.registerAutoWarn (context);
		this.registerBreakpointSync (context);

		// git clean filter 등록 (모든 태그 + @note)
		this.setupAnnotationFilter (root);

		// Store initial HEAD
		this.getCurrentCommitHash ().then ((h) => { this._lastKnownHead = h; });

		// 현재 열린 파일 스캔 & 데코레이션
		this.scanVisibleEditors ();
		this._onDidChangeTreeData.fire ();

		// 워크스페이스 전체에서 모든 어노테이션 스캔 (열려있지 않은 파일 포함)
		await this.scanWorkspaceAnnotations ();

		// 스캔 완료 후 브레이크포인트 설정
		this.syncBreakpoints ();

		// @region/@endregion 접기 지원
		this.registerRegionFolding (context);

		// 저장된 단축키 설정 자동 적용 (사용자가 한 번이라도 설정한 경우에만)
		const kbPath = this.getKeybindingsFilePath ();
		if (kbPath && fs.existsSync (kbPath)) {
			this.applyKeybindings ();
		}
	}

	// ──────────────────────────────────────────
	// Storage (메타데이터: displayLabel 등)
	// ──────────────────────────────────────────

	private loadAnnotations (): void {
		try {
			if (fs.existsSync (this.dataFilePath)) {
				const raw: AnnotationsData = JSON.parse (
					fs.readFileSync (this.dataFilePath, 'utf-8')
				);
				this.annotations = raw.annotations || [];
			}
		} catch {
			this.annotations = [];
		}
	}

	private saveAnnotations (): void {
		const dir = path.dirname (this.dataFilePath);
		if (!fs.existsSync (dir)) {
			fs.mkdirSync (dir, { recursive: true });
		}
		const data: AnnotationsData = {
			version: 2,
			// 가상 @warn은 세션 전용 (진단 해결 시 자동 제거), 나머지(auto-review 등)는 영속 저장
			annotations: this.annotations.filter ((a) => !(a.virtual && a.type === 'warn')),
		};
		fs.writeFileSync (this.dataFilePath, JSON.stringify (data, null, 2));
	}

	private ensureGitignore (root: string): void {
		// .jungle-kit 내부 gitignore
		const jkDir = path.join (root, '.jungle-kit');
		const jkGitignore = path.join (jkDir, '.gitignore');
		if (!fs.existsSync (jkDir)) {
			fs.mkdirSync (jkDir, { recursive: true });
		}
		if (fs.existsSync (jkGitignore)) {
			const content = fs.readFileSync (jkGitignore, 'utf-8');
			const entries = ['annotations.json', 'keybindings.json'];
			const missing = entries.filter ((e) => !content.includes (e));
			if (missing.length > 0) {
				fs.appendFileSync (jkGitignore, '\n' + missing.join ('\n') + '\n');
			}
		} else {
			fs.writeFileSync (jkGitignore, 'annotations.json\nkeybindings.json\n');
		}

		// 프로젝트 루트 .gitignore — 익스텐션 생성 파일 자동 제외
		const rootGitignore = path.join (root, '.gitignore');
		const entriesToAdd = ['.jungle-kit/', '.gitattributes'];
		try {
			let content = '';
			if (fs.existsSync (rootGitignore)) {
				content = fs.readFileSync (rootGitignore, 'utf-8');
			}
			const missing = entriesToAdd.filter ((e) => !content.includes (e));
			if (missing.length > 0) {
				const block = '\n# Annotation (auto-generated)\n' + missing.join ('\n') + '\n';
				fs.appendFileSync (rootGitignore, block);
			}
		} catch {
			// 권한 등 문제 시 무시
		}
	}

	// ──────────────────────────────────────────
	// File scanning — 파일에서 주석 태그를 실시간 감지
	// ──────────────────────────────────────────

	private registerDocumentListeners (context: vscode.ExtensionContext): void {
		// 문서 변경 시 debounce 스캔
		context.subscriptions.push (
			vscode.workspace.onDidChangeTextDocument ((event) => {
				if (event.document.uri.scheme !== 'file') { return; }
				if (this._scanTimer) { clearTimeout (this._scanTimer); }
				this._scanTimer = setTimeout (() => {
					this.scanDocument (event.document);
					this.updateEditorDecorations (
						vscode.window.visibleTextEditors.find (
							(e) => e.document.uri.toString () === event.document.uri.toString ()
						)
					);
					this._onDidChangeTreeData.fire ();
				}, 300);
			}),
			// 에디터 전환 시 데코레이션 적용
			vscode.window.onDidChangeActiveTextEditor ((editor) => {
				if (editor) {
					this.scanDocument (editor.document);
					this.updateEditorDecorations (editor);
					this._onDidChangeTreeData.fire ();
				}
			}),
			// 파일 저장 시 스캔
			vscode.workspace.onDidSaveTextDocument ((doc) => {
				this.scanDocument (doc);
				this.updateAllDecorations ();
				this.syncBreakpoints ();
				this._onDidChangeTreeData.fire ();
			})
		);
	}

	/**
	 * 파일 내용을 스캔해서 annotation 목록을 갱신한다.
	 * 주석은 파일에 그대로 유지 — 삭제하지 않음.
	 * annotations.json에는 displayLabel 등 메타데이터만 보존.
	 */
	private scanDocument (doc: vscode.TextDocument): void {
		if (doc.uri.scheme !== 'file') { return; }
		const relativePath = vscode.workspace.asRelativePath (doc.uri);

		// 기존 해당 파일의 annotation에서 displayLabel, sortOrder 맵 보존
		const labelMap = new Map<string, string> ();
		const orderMap = new Map<string, number> ();
		for (const ann of this.annotations.filter ((a) => a.file === relativePath)) {
			const key = `${ann.type}:${ann.line}`;
			if (ann.displayLabel) {
				// key: type+line (줄번호 기반이라 주석 내용이 바뀌어도 displayLabel 유지)
				labelMap.set (key, ann.displayLabel);
			}
			if (ann.sortOrder !== undefined) {
				orderMap.set (key, ann.sortOrder);
			}
		}

		// 기존 해당 파일의 가상 annotation 보존 (scanDocument에서 덮어쓰지 않음)
		const autoReviews = this.annotations.filter (
			(a) => a.file === relativePath && a.virtual
		);

		// 해당 파일의 annotation 제거 (가상 항목은 보존)
		this.annotations = this.annotations.filter (
			(a) => a.file !== relativePath || a.virtual
		);

		// 파일 스캔
		const found = this.parseAnnotationsFromDoc (doc, relativePath);

		for (const ann of found) {
			// displayLabel, sortOrder 복원
			const key = `${ann.type}:${ann.line}`;
			if (labelMap.has (key)) {
				ann.displayLabel = labelMap.get (key)!;
			}
			if (orderMap.has (key)) {
				ann.sortOrder = orderMap.get (key)!;
			}
			this.annotations.push (ann);
		}

		// auto-review 중 줄이 아직 유효한 것만 유지
		for (const ar of autoReviews) {
			if (ar.line < doc.lineCount) {
				// 아직 유효하면 유지
				if (!this.annotations.some ((a) => a.id === ar.id)) {
					this.annotations.push (ar);
				}
			}
		}

		this.saveAnnotations ();
	}

	private parseAnnotationsFromDoc (doc: vscode.TextDocument, relativePath: string): Annotation[] {
		const results: Annotation[] = [];

		for (let i = 0; i < doc.lineCount; i++) {
			const lineText = doc.lineAt (i).text;
			let type: AnnotationType | null = null;
			let content = '';

			// // @tag content
			const singleMatch = lineText.match (SINGLE_LINE_RE);
			if (singleMatch) {
				type = singleMatch[2] as AnnotationType;
				content = (singleMatch[3] || '').trim ();
			}

			// /* @tag content */
			if (!type) {
				const blockMatch = lineText.match (BLOCK_SINGLE_RE);
				if (blockMatch) {
					type = blockMatch[2] as AnnotationType;
					content = (blockMatch[3] || '').trim ();
				}
			}

			// /* @tag ...  (여러 줄 블록 — 첫 줄에 내용 있어도 매치)
			let blockEndLine = i;
			if (!type) {
				const blockStartMatch = lineText.match (BLOCK_START_RE);
				if (blockStartMatch) {
					type = blockStartMatch[2] as AnnotationType;
					// 첫 줄의 내용 수집 (태그 뒤의 텍스트)
					const contentLines: string[] = [];
					const firstLineContent = (blockStartMatch[3] || '').replace (/\s*\*\/$/, '').trim ();
					if (firstLineContent) {
						contentLines.push (firstLineContent.replace (/,\s*$/, ','));
					}
					// 다음 줄들에서 내용 수집 (* 으로 시작하는 줄, 최대 30줄)
					const maxBlockEnd = Math.min (i + 30, doc.lineCount);
					for (let j = i + 1; j < maxBlockEnd; j++) {
						const nextLine = doc.lineAt (j).text.trim ();
						if (nextLine.endsWith ('*/')) {
							const last = nextLine.replace (/^\*\s?/, '').replace (/\s*\*\/$/, '').trim ();
							if (last) { contentLines.push (last); }
							blockEndLine = j;
							break;
						}
						if (nextLine.startsWith ('*')) {
							contentLines.push (nextLine.replace (/^\*\s?/, '').trim ());
							blockEndLine = j;
						} else {
							break;
						}
					}
					content = contentLines.join (' ').trim () || type;
				}
			}

			if (!type) { continue; }
			if (!content) { content = type; }

			results.push ({
				id: this.generateId (),
				type,
				file: relativePath,
				line: i,
				lineEnd: blockEndLine,
				content,
				displayLabel: null,
				createdAt: new Date ().toISOString (),
				commitHash: null,
				author: null,
			});
		}

		return results;
	}

	private scanVisibleEditors (): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.scanDocument (editor.document);
			this.updateEditorDecorations (editor);
		}
	}

	/**
	 * 워크스페이스 전체에서 모든 어노테이션 태그가 있는 파일을 검색하고 스캔한다.
	 * 에디터에 열려있지 않은 파일도 포함하여 사이드바에 누락 없이 표시한다.
	 */
	private async scanWorkspaceAnnotations (forceRescan = false): Promise<void> {
		const files = await vscode.workspace.findFiles ('**/*.{c,h}', '**/build/**', 500);
		const tagPattern = /@(bookmark|todo|review|warn|breakpoint|region|endregion)\b/;

		for (const fileUri of files) {
			const relativePath = vscode.workspace.asRelativePath (fileUri);
			// forceRescan이 아니면, 이미 스캔 완료된 파일 건너뛰기
			if (!forceRescan && this.annotations.some ((a) => a.file === relativePath && !a.virtual)) {
				continue;
			}
			try {
				const doc = await vscode.workspace.openTextDocument (fileUri);
				const text = doc.getText ();
				if (tagPattern.test (text)) {
					this.scanDocument (doc);
				}
			} catch {
				// 파일 열기 실패 무시
			}
		}
	}

	// ──────────────────────────────────────────
	// Decorations — gutter 아이콘 + 배경 하이라이트
	// ──────────────────────────────────────────

	private createDecorationTypes (): void {
		for (const type of ALL_TAG_TYPES) {
			const iconUri = vscode.Uri.joinPath (
				this.context.extensionUri, 'resources', 'icons', `${type}.svg`
			);
			const dec = vscode.window.createTextEditorDecorationType ({
				gutterIconPath: iconUri,
				gutterIconSize: '90%',
				color: TAG_TEXT_COLORS[type],
				backgroundColor: TAG_BG_COLORS[type],
				overviewRulerColor: TAG_COLORS[type],
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				isWholeLine: true,
				fontWeight: 'bold',
			});
			this.decorationTypes.set (type, dec);
			this.context.subscriptions.push (dec);
		}
	}

	private updateAllDecorations (): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.updateEditorDecorations (editor);
		}
	}

	private updateEditorDecorations (editor?: vscode.TextEditor): void {
		if (!editor) { return; }
		const relativePath = vscode.workspace.asRelativePath (editor.document.uri);
		const fileAnns = this.annotations.filter ((a) => a.file === relativePath);

		const grouped: Record<string, vscode.DecorationOptions[]> = {};
		for (const type of ALL_TAG_TYPES) {
			grouped[type] = [];
		}

		for (const ann of fileAnns) {
			const options = grouped[ann.type];
			if (!options) { continue; }
			if (ann.line >= editor.document.lineCount) { continue; }

			const line = editor.document.lineAt (ann.line);

			const hoverLines = [
				`**@${ann.type}** ${ann.displayLabel || ann.content}`,
				`클릭하여 사이드바에서 확인`,
			];
			if (ann.commitHash) {
				hoverLines.push (`커밋: \`${ann.commitHash.substring (0, 7)}\``);
			}

			options.push ({
				range: new vscode.Range (ann.line, 0, ann.line, line.text.length),
				hoverMessage: new vscode.MarkdownString (hoverLines.join ('\n\n')),
			});
		}

		for (const [type, dec] of this.decorationTypes.entries ()) {
			editor.setDecorations (dec, grouped[type] || []);
		}
	}

	// ──────────────────────────────────────────
	// Manual tag creation (toolbar / context menu)
	// ──────────────────────────────────────────

	async addTag (type: AnnotationType): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }

		const line = editor.selection.active.line;
		const content = await vscode.window.showInputBox ({
			prompt: `${TAG_LABELS[type]} 내용을 입력하세요 (빈칸 가능)`,
		});
		if (content === undefined) { return; } // ESC 취소만 중단, 빈 문자열은 허용

		// 파일에 실제 주석 삽입
		const indent = editor.document.lineAt (line).text.match (/^(\s*)/)?.[1] || '';
		const commentText = content
			? `${indent}/* @${type} ${content} */\n`
			: `${indent}/* @${type} */\n`;

		const edit = new vscode.WorkspaceEdit ();
		edit.insert (editor.document.uri, new vscode.Position (line, 0), commentText);
		await vscode.workspace.applyEdit (edit);

		// 스캔이 자동으로 트리거되므로 별도 처리 불필요
		console.log (`[Annotation] @${type} 어노테이션 추가`);
	}

	async addTagAtCursor (): Promise<void> {
		const types = ALL_TAG_TYPES.map ((t) => ({
			label: `@${t}`,
			description: TAG_LABELS[t],
			type: t,
		}));

		const selected = await vscode.window.showQuickPick (types, {
			placeHolder: '어노테이션 유형을 선택하세요',
		});
		if (!selected) { return; }

		await this.addTag (selected.type);
	}

	// ──────────────────────────────────────────
	// Delete / Edit
	// ──────────────────────────────────────────

	async deleteAnnotation (id: string): Promise<void> {
		const ann = this.annotations.find ((a) => a.id === id);
		if (!ann) { return; }

		// 파일에서 해당 주석 줄 삭제
		const root = this.config.getWorkspaceRoot ();
		if (root) {
			const absPath = path.join (root, ann.file);
			const uri = vscode.Uri.file (absPath);
			try {
				const doc = await vscode.workspace.openTextDocument (uri);
				if (ann.line < doc.lineCount) {
					const lineText = doc.lineAt (ann.line).text;
					// 해당 줄이 실제로 annotation 주석인지 확인
					if (lineText.match (SINGLE_LINE_RE) || lineText.match (BLOCK_SINGLE_RE) || lineText.match (BLOCK_START_RE)) {
						const edit = new vscode.WorkspaceEdit ();
						const endLine = Math.min ((ann.lineEnd ?? ann.line) + 1, doc.lineCount);
						edit.delete (uri, new vscode.Range (ann.line, 0, endLine, 0));
						await vscode.workspace.applyEdit (edit);
					}
				}
			} catch { /* ignore */ }
		}

		this.annotations = this.annotations.filter ((a) => a.id !== id);
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire ();
	}

	async editAnnotation (id: string): Promise<void> {
		const ann = this.annotations.find ((a) => a.id === id);
		if (!ann) { return; }

		const current = ann.displayLabel || ann.content;
		const newLabel = await vscode.window.showInputBox ({
			prompt: '사이드바 표시 제목 수정 (파일 내 주석은 변경되지 않음)',
			value: current,
		});
		if (newLabel === undefined || newLabel === current) { return; }

		ann.displayLabel = newLabel || null;
		this.saveAnnotations ();
		this._onDidChangeTreeData.fire ();
	}

	async clearAllAnnotations (): Promise<void> {
		const count = this.annotations.length;
		if (count === 0) { return; }

		const confirm = await vscode.window.showWarningMessage (
			`어노테이션 ${count}개를 모두 삭제하시겠습니까? (파일 내 주석도 함께 삭제됩니다)`,
			'삭제', '취소'
		);
		if (confirm !== '삭제') { return; }

		// 파일에서 주석 줄 삭제
		await this.removeAnnotationLinesFromFiles (this.annotations);

		this.annotations = [];
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire ();
	}

	async clearFileAnnotations (file: string): Promise<void> {
		const fileAnns = this.annotations.filter ((a) => a.file === file);
		await this.removeAnnotationLinesFromFiles (fileAnns);

		this.annotations = this.annotations.filter ((a) => a.file !== file);
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire ();
	}

	private async removeAnnotationLinesFromFiles (anns: Annotation[]): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		// 파일별 그룹핑 (annotation 객체 전체 보존 — lineEnd 필요)
		const byFile = new Map<string, Annotation[]> ();
		for (const ann of anns) {
			const list = byFile.get (ann.file) || [];
			list.push (ann);
			byFile.set (ann.file, list);
		}

		for (const [file, fileAnns] of byFile) {
			const uri = vscode.Uri.file (path.join (root, file));
			try {
				const doc = await vscode.workspace.openTextDocument (uri);
				const edit = new vscode.WorkspaceEdit ();
				// 역순 삭제 (뒤에서부터 지워야 줄번호 밀림 방지)
				const sorted = [...fileAnns].sort ((a, b) => b.line - a.line);
				const deleted = new Set<number> ();
				for (const ann of sorted) {
					if (deleted.has (ann.line) || ann.line >= doc.lineCount) { continue; }
					const lineText = doc.lineAt (ann.line).text;
					if (lineText.match (SINGLE_LINE_RE) || lineText.match (BLOCK_SINGLE_RE) || lineText.match (BLOCK_START_RE)) {
						const endLine = Math.min ((ann.lineEnd ?? ann.line) + 1, doc.lineCount);
						edit.delete (uri, new vscode.Range (ann.line, 0, endLine, 0));
						for (let l = ann.line; l < endLine; l++) { deleted.add (l); }
					}
				}
				await vscode.workspace.applyEdit (edit);
			} catch { /* ignore */ }
		}
	}

	// ──────────────────────────────────────────
	// Toolbar
	// ──────────────────────────────────────────

	async refresh (): Promise<void> {
		this.scanVisibleEditors ();
		await this.scanWorkspaceAnnotations (true);
		this._onDidChangeTreeData.fire ();
	}

	toggleView (): void {
		this._groupByFile = !this._groupByFile;
		this._onDidChangeTreeData.fire ();
	}

	async searchTags (): Promise<void> {
		const items = [
			{ label: '$(search) 전체 보기', type: null as AnnotationType | null },
			...ALL_TAG_TYPES.map ((t) => ({ label: `@${t}  (${TAG_LABELS[t]})`, type: t as AnnotationType | null })),
			{ label: '$(edit) 텍스트 검색...', type: '__text__' as any },
		];

		const selected = await vscode.window.showQuickPick (items, {
			placeHolder: '필터링할 어노테이션 유형을 선택하세요',
		});
		if (!selected) { return; }

		if (selected.type === '__text__') {
			const text = await vscode.window.showInputBox ({
				prompt: '검색할 텍스트를 입력하세요',
				placeHolder: '내용 또는 파일명',
			});
			this.filterType = null;
			this.filterText = text || null;
		} else {
			this.filterType = selected.type;
			this.filterText = null;
		}

		this._onDidChangeTreeData.fire ();
	}

	// ──────────────────────────────────────────
	// Tag Navigation (Alt+[ / Alt+])
	// sidebarMode=true: 전체 태그 순회, false: 현재 파일 내 태그 순회
	// ──────────────────────────────────────────

	private _navIndex = -1;

	navigateTag (direction: 'next' | 'prev', sidebarMode = false): void {
		// 필터 적용된 태그 목록
		let allTags = [...this.annotations];
		if (this.filterType) {
			allTags = allTags.filter ((a) => a.type === this.filterType);
		}
		if (this.filterText) {
			const q = this.filterText.toLowerCase ();
			allTags = allTags.filter ((a) =>
				(a.displayLabel || a.content).toLowerCase ().includes (q) ||
				a.file.toLowerCase ().includes (q)
			);
		}

		if (allTags.length === 0) {
			vscode.window.showInformationMessage ('태그가 없습니다.');
			return;
		}

		if (sidebarMode) {
			// 전체 태그를 파일/줄 기준으로 순회
			allTags.sort ((a, b) => a.file.localeCompare (b.file) || a.line - b.line);

			// _navIndex 범위 보정 (태그 삭제 시 범위 초과 방지)
			if (this._navIndex >= allTags.length) {
				this._navIndex = allTags.length - 1;
			}

			if (direction === 'next') {
				this._navIndex = (this._navIndex + 1) % allTags.length;
			} else {
				this._navIndex = this._navIndex <= 0 ? allTags.length - 1 : this._navIndex - 1;
			}

			const target = allTags[this._navIndex];
			if (target) {
				this.openAnnotationInEditor (target);
			}
		} else {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				// 에디터가 없으면 전체 모드로 fallback
				this.navigateTag (direction, true);
				return;
			}

			const relativePath = vscode.workspace.asRelativePath (editor.document.uri);
			let tags = allTags.filter ((a) => a.file === relativePath);

			if (tags.length === 0) {
				vscode.window.showInformationMessage ('현재 파일에 태그가 없습니다.');
				return;
			}

			tags.sort ((a, b) => a.line - b.line);

			const cursorLine = editor.selection.active.line;
			let target: Annotation | undefined;

			if (direction === 'next') {
				target = tags.find ((a) => a.line > cursorLine);
				if (!target) { target = tags[0]; }
			} else {
				const above = tags.filter ((a) => a.line < cursorLine);
				target = above.length > 0 ? above[above.length - 1] : tags[tags.length - 1];
			}

			if (target) {
				const pos = new vscode.Position (target.line, 0);
				editor.selection = new vscode.Selection (pos, pos);
				editor.revealRange (
					new vscode.Range (pos, pos),
					vscode.TextEditorRevealType.InCenter
				);
			}
		}
	}

	private async openAnnotationInEditor (ann: Annotation): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return; }
		const uri = vscode.Uri.file (path.join (root, ann.file));
		try {
			const doc = await vscode.workspace.openTextDocument (uri);
			const editor = await vscode.window.showTextDocument (doc, { preserveFocus: false });
			const pos = new vscode.Position (ann.line, 0);
			editor.selection = new vscode.Selection (pos, pos);
			editor.revealRange (
				new vscode.Range (pos, pos),
				vscode.TextEditorRevealType.InCenter
			);
		} catch {
			vscode.window.showWarningMessage (`[Annotation] 파일을 열 수 없습니다: ${ann.file}`);
		}
	}

	// ──────────────────────────────────────────
	// @ Autocomplete
	// ──────────────────────────────────────────

	private registerCompletionProvider (context: vscode.ExtensionContext): void {
		const provider = vscode.languages.registerCompletionItemProvider (
			[{ language: 'c' }, { language: 'cpp' }],
			{
				provideCompletionItems (document, position) {
					const lineText = document.lineAt (position).text;
					const prefix = lineText.substring (0, position.character);

					if (!prefix.match (/\/\/\s*@\w*$/) && !prefix.match (/\/\*\s*@\w*$/)) {
						return undefined;
					}

					return ALL_TAG_TYPES.map ((t) => {
						const item = new vscode.CompletionItem (`@${t}`, vscode.CompletionItemKind.Keyword);
						item.detail = TAG_LABELS[t];
						const atPos = prefix.lastIndexOf ('@');
						item.range = new vscode.Range (position.line, atPos, position.line, position.character);
						item.insertText = `@${t} `;
						return item;
					});
				},
			},
			'@'
		);
		context.subscriptions.push (provider);
	}

	// ──────────────────────────────────────────
	// Warn guard
	// ──────────────────────────────────────────

	registerWarnGuard (context: vscode.ExtensionContext): void {
		context.subscriptions.push (
			vscode.workspace.onDidChangeTextDocument ((event) => {
				const doc = event.document;
				const relativePath = vscode.workspace.asRelativePath (doc.uri);
				const warns = this.annotations.filter (
					(a) => a.file === relativePath && a.type === 'warn'
				);

				for (const change of event.contentChanges) {
					const changedLine = change.range.start.line;
					for (const w of warns) {
						if (Math.abs (w.line - changedLine) <= 2) {
							console.log (
								`[Annotation] ⚡ @warn 근처 편집: ${w.displayLabel || w.content}`
							);
						}
					}
				}
			})
		);
	}

	// ──────────────────────────────────────────
	// Review tags accessor (PR 패널 호환)
	// ──────────────────────────────────────────

	getReviewTags (): Annotation[] {
		return this.annotations.filter ((a) => a.type === 'review');
	}

	// ──────────────────────────────────────────
	// TreeDataProvider
	// ──────────────────────────────────────────

	// ──────────────────────────────────────────
	// Drag & Drop — 사이드바 항목 순서 변경
	// ──────────────────────────────────────────

	handleDrag (source: readonly TagTreeItem[], dataTransfer: vscode.DataTransfer): void {
		const ids = source
			.filter ((s) => s.annotation)
			.map ((s) => s.annotation!.id);
		if (ids.length > 0) {
			dataTransfer.set (
				'application/vnd.code.tree.jungleKit.tags',
				new vscode.DataTransferItem (ids)
			);
		}
	}

	handleDrop (target: TagTreeItem | undefined, dataTransfer: vscode.DataTransfer): void {
		const raw = dataTransfer.get ('application/vnd.code.tree.jungleKit.tags');
		if (!raw) { return; }
		const draggedIds: string[] = raw.value;
		if (!draggedIds || draggedIds.length === 0) { return; }

		// 드롭 대상의 annotation 가져오기
		const targetAnn = target?.annotation;
		if (!targetAnn) { return; }

		// 같은 타입 그룹 내에서만 정렬 허용
		const draggedAnns = this.annotations.filter ((a) => draggedIds.includes (a.id));
		if (draggedAnns.length === 0) { return; }
		if (draggedAnns[0].type !== targetAnn.type) { return; }

		const type = targetAnn.type;

		// 단일 항목 드래그: 위치 교환 (swap)
		if (draggedAnns.length === 1) {
			const dragAnn = draggedAnns[0];
			// 둘 다 sortOrder가 없으면 먼저 전체 그룹에 순서 부여
			const typeAnns = this.annotations
				.filter ((a) => a.type === type)
				.sort ((a, b) => {
					const oa = a.sortOrder ?? Infinity;
					const ob = b.sortOrder ?? Infinity;
					if (oa !== Infinity || ob !== Infinity) { return oa - ob; }
					return a.file.localeCompare (b.file) || a.line - b.line;
				});
			if (dragAnn.sortOrder === undefined || targetAnn.sortOrder === undefined) {
				typeAnns.forEach ((a, i) => { a.sortOrder = i; });
			}
			const tmpOrder = dragAnn.sortOrder!;
			dragAnn.sortOrder = targetAnn.sortOrder!;
			targetAnn.sortOrder = tmpOrder;
		} else {
			// 다중 선택: 기존 insert 방식
			const typeAnns = this.annotations
				.filter ((a) => a.type === type)
				.sort ((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
			const remaining = typeAnns.filter ((a) => !draggedIds.includes (a.id));
			const targetIdx = remaining.findIndex ((a) => a.id === targetAnn.id);
			remaining.splice (targetIdx, 0, ...draggedAnns);
			remaining.forEach ((a, i) => { a.sortOrder = i; });
		}

		this.saveAnnotations ();
		this._onDidChangeTreeData.fire ();
	}

	getTreeItem (element: TagTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren (element?: TagTreeItem): TagTreeItem[] {
		let active = [...this.annotations];

		if (this.filterType) {
			active = active.filter ((a) => a.type === this.filterType);
		}
		if (this.filterText) {
			const q = this.filterText.toLowerCase ();
			active = active.filter ((a) =>
				(a.displayLabel || a.content).toLowerCase ().includes (q) ||
				a.file.toLowerCase ().includes (q)
			);
		}

		if (!element) {
			if (this._groupByFile) {
				return this.buildFileGroupRoot (active);
			}
			return this.buildTypeGroupRoot (active);
		}

		const groupMatch = element.contextValue?.match (/^tagGroup-(\w+)$/);
		if (groupMatch) {
			const type = groupMatch[1] as AnnotationType;
			const typeAnns = active.filter ((a) => a.type === type);

			if (type === 'review') {
				return this.buildReviewTree (typeAnns);
			}

			return typeAnns
				.sort ((a, b) => {
					const oa = a.sortOrder ?? Infinity;
					const ob = b.sortOrder ?? Infinity;
					if (oa !== Infinity || ob !== Infinity) { return oa - ob; }
					return a.file.localeCompare (b.file) || a.line - b.line;
				})
				.map ((a) => this.createAnnotationItem (a));
		}

		const fileMatch = element.contextValue?.match (/^tagFile-(.+)$/);
		if (fileMatch) {
			const file = fileMatch[1];
			return active
				.filter ((a) => a.file === file)
				.sort ((a, b) => a.line - b.line)
				.map ((a) => this.createAnnotationItem (a));
		}

		const commitMatch = element.contextValue?.match (/^tagCommit-(.+)$/);
		if (commitMatch) {
			const hash = commitMatch[1];
			const commitAnns = active.filter ((a) => {
				if (hash === 'uncommitted') { return a.type === 'review' && !a.commitHash; }
				return a.type === 'review' && a.commitHash === hash;
			});
			return commitAnns
				.sort ((a, b) => a.file.localeCompare (b.file) || a.line - b.line)
				.map ((a) => this.createAnnotationItem (a));
		}

		return [];
	}

	private buildTypeGroupRoot (active: Annotation[]): TagTreeItem[] {
		const items: TagTreeItem[] = [];
		for (const type of ALL_TAG_TYPES) {
			const count = active.filter ((a) => a.type === type).length;
			if (count === 0) { continue; }

			const item = new TagTreeItem (
				`@${type}`,
				vscode.TreeItemCollapsibleState.Expanded
			);
			item.description = `(${count})`;
			item.iconPath = vscode.Uri.joinPath (
				this.context.extensionUri, 'resources', 'icons', `${type}.svg`
			);
			item.contextValue = `tagGroup-${type}`;
			items.push (item);
		}
		return items;
	}

	private buildFileGroupRoot (active: Annotation[]): TagTreeItem[] {
		const fileGroups = new Map<string, Annotation[]> ();
		for (const a of active) {
			const list = fileGroups.get (a.file) || [];
			list.push (a);
			fileGroups.set (a.file, list);
		}

		const items: TagTreeItem[] = [];
		for (const [file, anns] of fileGroups) {
			const item = new TagTreeItem (
				path.basename (file),
				vscode.TreeItemCollapsibleState.Expanded
			);
			const dir = path.dirname (file) !== '.' ? path.dirname (file) + ' ' : '';
			item.description = `${dir}(${anns.length})`;
			item.resourceUri = vscode.Uri.parse (`jungle-tag:///${file}`);
			item.iconPath = vscode.ThemeIcon.File;
			item.contextValue = `tagFile-${file}`;
			items.push (item);
		}
		return items;
	}

	private buildReviewTree (anns: Annotation[]): TagTreeItem[] {
		const groups = new Map<string, Annotation[]> ();
		for (const a of anns) {
			const key = a.commitHash || 'uncommitted';
			const list = groups.get (key) || [];
			list.push (a);
			groups.set (key, list);
		}

		const sorted = [...groups.entries ()].sort ((a, b) => {
			if (a[0] === 'uncommitted') { return -1; }
			if (b[0] === 'uncommitted') { return 1; }
			const aTime = a[1][0]?.createdAt || '';
			const bTime = b[1][0]?.createdAt || '';
			return bTime.localeCompare (aTime);
		});

		return sorted.map (([hash, items]) => {
			const label = hash === 'uncommitted'
				? `uncommitted (${items.length})`
				: `${hash.substring (0, 7)} — ${items[0]?.author || 'unknown'} (${items.length})`;

			const item = new TagTreeItem (label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon ('git-commit');
			item.contextValue = `tagCommit-${hash}`;
			return item;
		});
	}

	private createAnnotationItem (ann: Annotation): TagTreeItem {
		const label = ann.displayLabel || ann.content;
		const item = new TagTreeItem (
			label,
			vscode.TreeItemCollapsibleState.None
		);
		item.annotation = ann;

		item.iconPath = vscode.Uri.joinPath (
			this.context.extensionUri, 'resources', 'icons', `${ann.type}.svg`
		);
		item.description = `${path.basename (ann.file)}:${ann.line + 1}`;

		const tooltipLines = [
			`**@${ann.type}** ${ann.content}`,
		];
		if (ann.virtual) {
			tooltipLines.push (`_자동 감지 (파일에 없음)_`);
		}
		if (ann.displayLabel && ann.displayLabel !== ann.content) {
			tooltipLines.push (`표시: _${ann.displayLabel}_`);
		}
		if (ann.author) {
			tooltipLines.push (`_${ann.author}_ | ${new Date (ann.createdAt).toLocaleString ()}`);
		}
		if (ann.commitHash) {
			tooltipLines.push (`커밋: \`${ann.commitHash.substring (0, 7)}\``);
		}
		item.tooltip = new vscode.MarkdownString (tooltipLines.join ('\n\n'));

		item.command = {
			command: 'jungleKit.goToTag',
			title: 'Go to annotation',
			arguments: [ann],
		};

		item.contextValue = `tag-${ann.type}-${ann.id}`;
		return item;
	}

	// ──────────────────────────────────────────
	// @breakpoint: 디버그 세션 시작 시 브레이크포인트 + 조사식 등록
	// ──────────────────────────────────────────

	private _debugBreakpoints: vscode.SourceBreakpoint[] = [];

	private registerBreakpointSync (context: vscode.ExtensionContext): void {
		// 디버그 세션 시작 시 브레이크포인트 재등록 + 조사식 등록
		context.subscriptions.push (
			vscode.debug.onDidStartDebugSession (async () => {
				this.syncBreakpoints ();
				// 조사식은 이전 세션 기록을 초기화하고 새로 등록
				await this.context.workspaceState.update ('annotation.registeredWatch', undefined);
				await this.syncWatchExpressions ();
			})
		);

		// 디버그 세션 종료 시 자동 등록한 브레이크포인트 제거
		context.subscriptions.push (
			vscode.debug.onDidTerminateDebugSession (() => {
				if (this._debugBreakpoints.length > 0) {
					vscode.debug.removeBreakpoints (this._debugBreakpoints);
					this._debugBreakpoints = [];
				}
			})
		);

		// 초기 브레이크포인트는 activate()에서 scanVisibleEditors() 이후 호출
	}

	/**
	 * 파일 스캔 시 호출 — @breakpoint 다음 줄에 VS Code 브레이크포인트를 미리 설정.
	 * 디버그 시작 전에 걸려 있어야 GDB가 해당 줄에서 멈춘다.
	 */
	syncBreakpoints (): void {
		const root = this.config.getWorkspaceRoot ();
		if (!root) {
			console.log ('[Annotation] syncBreakpoints: root가 없음');
			return;
		}

		// 기존 자동 브레이크포인트 제거
		if (this._debugBreakpoints.length > 0) {
			vscode.debug.removeBreakpoints (this._debugBreakpoints);
			this._debugBreakpoints = [];
		}

		const bpAnnotations = this.annotations.filter ((a) => a.type === 'breakpoint');
		console.log (`[Annotation] syncBreakpoints: @breakpoint ${bpAnnotations.length}개 발견`);
		if (bpAnnotations.length === 0) { return; }

		const newBreakpoints: vscode.SourceBreakpoint[] = [];

		for (const ann of bpAnnotations) {
			const filePath = path.join (root, ann.file);
			const exists = fs.existsSync (filePath);
			console.log (`[Annotation] BP: ${ann.file}:${ann.line} → ${filePath} (exists=${exists})`);
			if (!exists) { continue; }

			const uri = vscode.Uri.file (filePath);
			// 주석·빈 줄을 건너뛰고 실제 실행 가능한 코드 라인을 찾는다
			const fileLines = fs.readFileSync (filePath, 'utf-8').split ('\n');
			const startLine = (ann.lineEnd ?? ann.line) + 1;
			let bpLine = startLine;
			for (let i = startLine; i < Math.min (startLine + 10, fileLines.length); i++) {
				const trimmed = fileLines[i]?.trim () ?? '';
				if (trimmed === '' || trimmed.startsWith ('/*') || trimmed.startsWith ('//') ||
					trimmed.startsWith ('*') || trimmed === '*/') {
					continue;
				}
				bpLine = i;
				break;
			}
			console.log (`[Annotation] BP line: ${startLine} → ${bpLine} (${fileLines[bpLine]?.trim ()?.substring (0, 40)})`);
			const location = new vscode.Location (uri, new vscode.Position (bpLine, 0));
			const bp = new vscode.SourceBreakpoint (location, true);
			newBreakpoints.push (bp);
		}

		console.log (`[Annotation] syncBreakpoints: ${newBreakpoints.length}개 등록 시도`);
		if (newBreakpoints.length > 0) {
			vscode.debug.addBreakpoints (newBreakpoints);
			this._debugBreakpoints = newBreakpoints;
			console.log (`[Annotation] syncBreakpoints: ${newBreakpoints.length}개 등록 완료`);
		}
	}

	/**
	 * 디버그 세션 시작 시 호출 — 조사식(Watch) 패널에 직접 등록.
	 * debug.addToWatchExpressions 내부 커맨드를 사용하여
	 * 에디터 깜빡임·클립보드 오염 없이 등록한다.
	 */
	private async syncWatchExpressions (): Promise<void> {
		console.log ('[Annotation] syncWatchExpressions 호출됨');
		const bpAnnotations = this.annotations.filter ((a) => a.type === 'breakpoint');
		console.log (`[Annotation] syncWatch: @breakpoint ${bpAnnotations.length}개`);
		if (bpAnnotations.length === 0) { return; }

		const watchExpressions: string[] = [];

		for (const ann of bpAnnotations) {
			const expressions = ann.content
				.split (',')
				.map ((e) => e.trim ())
				.filter ((e) => e.length > 0);

			for (const expr of expressions) {
				if (!watchExpressions.includes (expr)) {
					watchExpressions.push (expr);
				}
			}
		}

		if (watchExpressions.length === 0) { return; }

		// 중복 방지: 이전에 등록한 조사식 목록을 workspaceState에서 읽음
		const stateKey = 'annotation.registeredWatch';
		const alreadyRegistered: string[] =
			this.context.workspaceState.get<string[]> (stateKey) || [];

		const toRegister = watchExpressions.filter (
			(expr) => !alreadyRegistered.includes (expr)
		);

		if (toRegister.length === 0) { return; }

		let registered = 0;
		for (const expr of toRegister) {
			try {
				await vscode.commands.executeCommand (
					'debug.addToWatchExpressions',
					{
						variable: { evaluateName: expr },
						container: {},
						sessionId: undefined,
					}
				);
				registered++;
			} catch {
				// 내부 커맨드 실패 시 무시
			}
		}

		if (registered > 0) {
			// 등록 성공한 조사식을 workspaceState에 기록
			const updated = [...alreadyRegistered, ...toRegister];
			await this.context.workspaceState.update (stateKey, updated);
		}
	}

	// ──────────────────────────────────────────
	// Auto-warn: 진단(컴파일 에러/경고) 감지 시 @warn 자동 삽입
	// ──────────────────────────────────────────

	private _warnDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _warnPendingUris = new Set<string> ();

	/**
	 * 가상 auto-warn: 진단(에러)을 사이드바에만 표시하고 파일에는 쓰지 않는다.
	 * 진단이 해결되면 자동으로 사이드바에서 제거된다.
	 */
	private registerAutoWarn (context: vscode.ExtensionContext): void {
		context.subscriptions.push (
			vscode.languages.onDidChangeDiagnostics ((event) => {
				for (const uri of event.uris) {
					if (uri.scheme !== 'file') { continue; }
					const filePath = uri.fsPath;
					if (!filePath.endsWith ('.c') && !filePath.endsWith ('.h')) { continue; }
					this._warnPendingUris.add (uri.toString ());
				}

				if (this._warnDebounceTimer) { clearTimeout (this._warnDebounceTimer); }
				this._warnDebounceTimer = setTimeout (() => {
					const uris = [...this._warnPendingUris];
					this._warnPendingUris.clear ();
					this.syncVirtualWarns (uris);
				}, 2000);
			})
		);
	}

	/**
	 * 가상 @warn 동기화: 현재 진단 상태와 사이드바를 일치시킨다.
	 * 새 에러 → 가상 항목 추가, 해결된 에러 → 가상 항목 제거.
	 */
	private syncVirtualWarns (uriStrings: string[]): void {
		let changed = false;

		for (const uriStr of uriStrings) {
			const uri = vscode.Uri.parse (uriStr);
			const relativePath = vscode.workspace.asRelativePath (uri);
			const diagnostics = vscode.languages.getDiagnostics (uri);

			const errors = diagnostics.filter ((d) =>
				d.severity === vscode.DiagnosticSeverity.Error
			);

			// 이 파일의 기존 가상 @warn 제거
			this.annotations = this.annotations.filter (
				(a) => !(a.file === relativePath && a.type === 'warn' && a.virtual)
			);

			// 현재 에러들을 가상 @warn으로 추가 (파일당 최대 20개)
			const limited = errors.slice (0, 20);
			for (const diag of limited) {
				const msg = diag.message.replace (/\n/g, ' ').substring (0, 100);
				const source = diag.source ? `[${diag.source}] ` : '';
				this.annotations.push ({
					id: `vwarn-${relativePath}:${diag.range.start.line}:${Date.now ()}`,
					type: 'warn',
					file: relativePath,
					line: diag.range.start.line,
					content: `${source}${msg}`,
					displayLabel: null,
					createdAt: new Date ().toISOString (),
					commitHash: null,
					author: null,
					virtual: true,
				});
			}

			changed = true;
		}

		if (changed) {
			this.updateAllDecorations ();
			this._onDidChangeTreeData.fire ();
		}
	}

	// ──────────────────────────────────────────
	// Phase 2: Auto-review on new commits
	// ──────────────────────────────────────────

	private registerAutoReview (context: vscode.ExtensionContext): void {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		const gitHeadPath = path.join (root, '.git', 'HEAD');
		if (!fs.existsSync (gitHeadPath)) { return; }

		const headWatcher = vscode.workspace.createFileSystemWatcher (
			new vscode.RelativePattern (path.join (root, '.git'), '{HEAD,MERGE_HEAD,FETCH_HEAD,refs/heads/**}')
		);

		const checkHead = async () => {
			const currentHead = await this.getCurrentCommitHash ();
			if (!currentHead || currentHead === this._lastKnownHead) { return; }

			const oldHead = this._lastKnownHead;
			this._lastKnownHead = currentHead;

			if (oldHead) {
				await this.generateReviewsForDiff (oldHead, currentHead);
			}
		};

		context.subscriptions.push (
			headWatcher.onDidChange (() => setTimeout (checkHead, 1000)),
			headWatcher.onDidCreate (() => setTimeout (checkHead, 1000)),
			headWatcher
		);
	}

	/**
	 * 가상 auto-review: diff에서 새 코드를 감지하면
	 * 사이드바에만 @review 항목을 표시한다. 파일에는 쓰지 않는다.
	 */
	private async generateReviewsForDiff (oldHead: string, newHead: string): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		try {
			const { stdout: diffOutput } = await execAsync (
				`git diff ${oldHead}..${newHead} --unified=0 --diff-filter=AM -- '*.c' '*.h'`,
				{ cwd: root, maxBuffer: 1024 * 1024 * 10 }
			);

			if (!diffOutput.trim ()) { return; }

			const { stdout: authorOut } = await execAsync (
				`git log -1 --format="%an" ${newHead}`,
				{ cwd: root }
			);
			const commitAuthor = authorOut.trim ();
			const myName = await this.getAuthorName ();
			if (commitAuthor === myName) { return; }

			const additions = this.parseDiffAdditions (diffOutput);
			if (additions.length === 0) { return; }

			let addedCount = 0;

			for (const add of additions) {
				const exists = this.annotations.some (
					(a) => a.file === add.file && a.line === add.line && a.type === 'review'
				);
				if (exists) { continue; }

				let description = '';
				try {
					description = await this.generateAIDescription (add, root);
				} catch { /* AI 실패 */ }

				if (!description) {
					description = this.generateDoxygenDescription (add);
				}

				// 가상 @review 추가 (파일에 쓰지 않음)
				this.annotations.push ({
					id: `vreview-${add.file}:${add.line}:${Date.now ()}`,
					type: 'review',
					file: add.file,
					line: add.line,
					content: `[${commitAuthor}] ${description}`,
					displayLabel: null,
					createdAt: new Date ().toISOString (),
					commitHash: newHead,
					author: commitAuthor,
					virtual: true,
				});
				addedCount++;
			}

			if (addedCount > 0) {
				this.saveAnnotations ();
				this.updateAllDecorations ();
				this._onDidChangeTreeData.fire ();
				console.log (
					`[Annotation] @review ${addedCount}개 자동 생성 (${newHead.substring (0, 7)} — ${commitAuthor})`
				);
			}
		} catch (err) {
			console.error ('[Annotation] Auto-review error:', err);
		}
	}

	// ──────────────────────────────────────────
	// Diff parser
	// ──────────────────────────────────────────

	private parseDiffAdditions (diffOutput: string): { file: string; line: number; code: string; kind: 'function' | 'variable' }[] {
		const results: { file: string; line: number; code: string; kind: 'function' | 'variable' }[] = [];
		let currentFile = '';

		const lines = diffOutput.split ('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (line.startsWith ('+++ b/')) {
				currentFile = line.substring (6);
				continue;
			}

			const hunkMatch = line.match (/^@@ .+ \+(\d+)/);
			if (hunkMatch) {
				const startLine = parseInt (hunkMatch[1], 10);
				let addedLineNum = startLine;

				for (let j = i + 1; j < lines.length; j++) {
					const hunkLine = lines[j];
					if (hunkLine.startsWith ('@@') || hunkLine.startsWith ('diff ') || hunkLine.startsWith ('+++ ') || hunkLine.startsWith ('--- ')) {
						break;
					}
					// 삭제 줄(-): 새 파일에 없으므로 줄번호 증가 안 함
					if (hunkLine.startsWith ('-')) { continue; }
					// context 줄(공백 시작): 새 파일에 존재하므로 줄번호만 증가
					if (!hunkLine.startsWith ('+')) { addedLineNum++; continue; }

					const code = hunkLine.substring (1);

					const funcMatch = code.match (
						/^\s*((?:static\s+|inline\s+|extern\s+|const\s+)*\w[\w\s*]+)\s+(\w+)\s*\(([^)]*)\)\s*\{?\s*$/
					);
					if (funcMatch && !code.match (/^\s*(if|else|for|while|switch|return|struct|enum|typedef|#)/)) {
						results.push ({
							file: currentFile,
							line: addedLineNum - 1,
							code: code.trim (),
							kind: 'function',
						});
					}

					const varMatch = code.match (
						/^\s*((?:static\s+|extern\s+|const\s+)*(?:struct\s+|enum\s+|unsigned\s+|signed\s+)?\w+[\s*]+)(\w+)\s*[=;[\]]/
					);
					if (varMatch && !funcMatch && !code.match (/^\s*(#|\/\/|\/\*|if|else|for|while|return|typedef)/)) {
						if (!code.match (/^\s{2,}/) || code.match (/^\s*static\s+/)) {
							results.push ({
								file: currentFile,
								line: addedLineNum - 1,
								code: code.trim (),
								kind: 'variable',
							});
						}
					}

					addedLineNum++;
				}
			}
		}

		return results;
	}

	// ──────────────────────────────────────────
	// Doxygen-style description
	// ──────────────────────────────────────────

	private generateDoxygenDescription (add: { code: string; kind: string }): string {
		if (add.kind === 'function') {
			const match = add.code.match (
				/^\s*((?:static\s+|inline\s+|extern\s+|const\s+)*)([\w\s*]+?)\s+(\w+)\s*\(([^)]*)\)/
			);
			if (match) {
				const qualifiers = match[1].trim ();
				const returnType = match[2].trim ();
				const funcName = match[3];
				const paramsStr = match[4].trim ();

				const parts: string[] = [];
				parts.push (`${funcName}(`);

				if (paramsStr && paramsStr !== 'void') {
					const params = paramsStr.split (',').map ((p) => p.trim ());
					const paramDescs = params.map ((p) => {
						const tokens = p.split (/\s+/);
						const name = tokens[tokens.length - 1].replace (/[*&]/g, '');
						const type = tokens.slice (0, -1).join (' ') || p;
						return `${type} ${name}`;
					});
					parts.push (paramDescs.join (', '));
				} else {
					parts.push ('void');
				}

				parts.push (`) → ${returnType}`);
				const prefix = qualifiers ? `[${qualifiers}] ` : '';
				return `${prefix}새로 추가된 함수: ${parts.join ('')}`;
			}
		}

		if (add.kind === 'variable') {
			const match = add.code.match (
				/^\s*((?:static\s+|extern\s+|const\s+)*(?:struct\s+|enum\s+|unsigned\s+|signed\s+)?\w+[\s*]+)(\w+)/
			);
			if (match) {
				return `새로 추가된 변수: ${match[1].trim ()} ${match[2]}`;
			}
		}

		return `새로 추가된 코드: ${add.code.substring (0, 60)}`;
	}

	// ──────────────────────────────────────────
	// AI description
	// ──────────────────────────────────────────

	private async generateAIDescription (
		add: { file: string; line: number; code: string; kind: string },
		root: string
	): Promise<string> {
		if (!this.apiKeys) { return ''; }
		const key = await this.apiKeys.getKey ();
		if (!key) { return ''; }

		let context = '';
		try {
			const filePath = path.join (root, add.file);
			if (fs.existsSync (filePath)) {
				const fileLines = fs.readFileSync (filePath, 'utf-8').split ('\n');
				const start = Math.max (0, add.line - 10);
				const end = Math.min (fileLines.length, add.line + 10);
				context = fileLines.slice (start, end).join ('\n');
			}
		} catch { /* ignore */ }

		const model = vscode.workspace.getConfiguration ('jungleKit').get<string> ('ai.model') || 'gpt-4o-mini';

		try {
			const OpenAI = (await import ('openai')).default;
			const client = new OpenAI ({ apiKey: key });

			const response = await client.chat.completions.create ({
				model,
				messages: [
					{
						role: 'system',
						content: '당신은 C 코드 리뷰어입니다. 새로 추가된 코드를 분석해서 한국어로 간결하게 설명해주세요. '
							+ '무엇을 하는 함수/변수인지, 기존 코드와 중복되는 부분이 있는지 확인해주세요. '
							+ '80자 이내로 답변하세요.',
					},
					{
						role: 'user',
						content: `파일: ${add.file}\n새로 추가된 코드:\n${add.code}\n\n주변 코드:\n${context}`,
					},
				],
				max_tokens: 100,
				temperature: 0.3,
			});

			return response.choices?.[0]?.message?.content?.trim () || '';
		} catch {
			return '';
		}
	}

	// ──────────────────────────────────────────
	// Git clean filter — 모든 태그 + @note diff 제외
	// ──────────────────────────────────────────

	private setupAnnotationFilter (root: string): void {
		const opts = { cwd: root, stdio: 'ignore' as const };

		try {
			const cleanScript = path.join (root, '.jungle-kit', 'scripts', 'clean-local.sh');
			const smudgeScript = path.join (root, '.jungle-kit', 'scripts', 'smudge-local.sh');

			if (fs.existsSync (cleanScript) && fs.existsSync (smudgeScript)) {
				execSync (`git config filter.jungle-local.clean "bash ${cleanScript}"`, opts);
				execSync (`git config filter.jungle-local.smudge "bash ${smudgeScript}"`, opts);
			} else {
				execSync (`git config filter.jungle-local.clean "sed -E '/(\\/\\/|\\* |^\\/\\*|\\*\\/).*@(todo|bookmark|review|warn|breakpoint|note|region|endregion)([[:space:]]|$)/d' || true"`, opts);
				execSync (`git config filter.jungle-local.smudge cat`, opts);
			}

			const gaPath = path.join (root, '.gitattributes');
			const filterLine = '*.c filter=jungle-local';
			const filterLineH = '*.h filter=jungle-local';

			let gaContent = '';
			if (fs.existsSync (gaPath)) {
				gaContent = fs.readFileSync (gaPath, 'utf-8');
			}
			let changed = false;
			if (!gaContent.includes (filterLine)) {
				gaContent += `\n${filterLine}\n`;
				changed = true;
			}
			if (!gaContent.includes (filterLineH)) {
				gaContent += `${filterLineH}\n`;
				changed = true;
			}
			if (changed) {
				fs.writeFileSync (gaPath, gaContent.trimStart ());
			}
		} catch (err) {
			console.error ('[Annotation] Filter setup failed:', err);
		}
	}

	// ──────────────────────────────────────────
	// @region/@endregion 코드 접기
	// ──────────────────────────────────────────

	private registerRegionFolding (context: vscode.ExtensionContext): void {
		const provider: vscode.FoldingRangeProvider = {
			provideFoldingRanges (doc: vscode.TextDocument): vscode.FoldingRange[] {
				const ranges: vscode.FoldingRange[] = [];
				const stack: { line: number; name: string }[] = [];
				const regionEnd = /@endregion\b/;
				const regionStart = /@region\b/;

				for (let i = 0; i < doc.lineCount; i++) {
					const text = doc.lineAt (i).text;
					if (regionEnd.test (text)) {
						const top = stack.pop ();
						if (top) {
							ranges.push (new vscode.FoldingRange (top.line, i, vscode.FoldingRangeKind.Region));
						}
					} else if (regionStart.test (text)) {
						const name = text.replace (/.*@region\s*/, '').replace (/\*\/\s*$/, '').trim ();
						stack.push ({ line: i, name });
					}
				}
				return ranges;
			},
		};

		const selector = [
			{ language: 'c' },
			{ language: 'cpp' },
			{ language: 'typescript' },
			{ language: 'javascript' },
			{ language: 'python' },
			{ language: 'java' },
		];
		context.subscriptions.push (
			vscode.languages.registerFoldingRangeProvider (selector, provider)
		);
	}

	// ──────────────────────────────────────────
	// Utilities
	// ──────────────────────────────────────────

	private async getAuthorName (): Promise<string> {
		const root = this.config.getWorkspaceRoot ();
		try {
			const { stdout } = await execAsync ('git config user.name', { cwd: root });
			return stdout.trim () || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	private async getCurrentCommitHash (): Promise<string | null> {
		const root = this.config.getWorkspaceRoot ();
		try {
			const { stdout } = await execAsync ('git rev-parse HEAD', { cwd: root });
			return stdout.trim () || null;
		} catch {
			return null;
		}
	}

	private generateId (): string {
		return `${Date.now ()}-${Math.random ().toString (36).substring (2, 8)}`;
	}

	// ──────────────────────────────────────────
	// Shortcut Settings (단축키 설정)
	// ──────────────────────────────────────────

	private static readonly DEFAULT_SHORTCUTS: ShortcutEntry[] = [
		// 디버그 단축키
		{ id: 'debug.start',       label: '디버그 시작',              command: 'workbench.action.debug.start',      key: 'f5',          mac: 'f5' },
		{ id: 'debug.stepOver',    label: '디버그 Step Over',         command: 'workbench.action.debug.stepOver',   key: 'f6',          mac: 'f6' },
		{ id: 'debug.stepInto',    label: '디버그 Step Into',         command: 'workbench.action.debug.stepInto',   key: 'f7',          mac: 'f7' },
		{ id: 'debug.continue',    label: '디버그 Continue',          command: 'workbench.action.debug.continue',   key: 'f8',          mac: 'f8' },
		{ id: 'debug.toggleBP',    label: '브레이크포인트 토글',      command: 'editor.debug.action.toggleBreakpoint', key: 'f11',      mac: 'f11' },
		// 에디터 네비게이션
		{ id: 'nav.prevEditor',    label: '이전 에디터 탭',           command: 'workbench.action.previousEditor',   key: 'cmd+[',       mac: 'cmd+[' },
		{ id: 'nav.nextEditor',    label: '다음 에디터 탭',           command: 'workbench.action.nextEditor',       key: 'cmd+]',       mac: 'cmd+]' },
		// 코드 접기/펼치기
		{ id: 'fold.fold',         label: '코드 접기',                command: 'editor.fold',                       key: 'cmd+shift+[', mac: 'cmd+shift+[' },
		{ id: 'fold.unfold',       label: '코드 펼치기',              command: 'editor.unfold',                     key: 'cmd+shift+]', mac: 'cmd+shift+]' },
		// 유틸리티
		{ id: 'util.selectAll',    label: '전체 선택',                command: 'editor.action.selectAll',           key: 'alt+a',       mac: 'alt+a' },
		{ id: 'util.findRefs',     label: '참조 찾기',                command: 'editor.action.referenceSearch.trigger', key: 'alt+f7',  mac: 'alt+f7' },
		// 태그 네비게이션 (참조용 — package.json keybinding으로 등록, applyKeybindings에서 스킵)
		{ id: 'annotation.prevTag',    label: '이전 태그로 이동',     command: 'jungleKit.prevTag',                 key: 'alt+[',       mac: 'alt+[' },
		{ id: 'annotation.nextTag',    label: '다음 태그로 이동',     command: 'jungleKit.nextTag',                 key: 'alt+]',       mac: 'alt+]' },
	];

	private getKeybindingsFilePath (): string {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return ''; }
		return path.join (root, '.jungle-kit', 'keybindings.json');
	}

	private loadShortcutSettings (): ShortcutEntry[] {
		const filePath = this.getKeybindingsFilePath ();
		if (!filePath) { return [...TagSystem.DEFAULT_SHORTCUTS]; }
		try {
			if (fs.existsSync (filePath)) {
				const raw = JSON.parse (fs.readFileSync (filePath, 'utf-8'));
				if (Array.isArray (raw.shortcuts)) {
					return raw.shortcuts;
				}
			}
		} catch { /* 파싱 실패 시 기본값 사용 */ }
		return [...TagSystem.DEFAULT_SHORTCUTS];
	}

	private saveShortcutSettings (shortcuts: ShortcutEntry[]): void {
		const filePath = this.getKeybindingsFilePath ();
		if (!filePath) { return; }
		const dir = path.dirname (filePath);
		if (!fs.existsSync (dir)) {
			fs.mkdirSync (dir, { recursive: true });
		}
		fs.writeFileSync (filePath, JSON.stringify ({ version: 1, shortcuts }, null, 2));
	}

	async configureShortcuts (): Promise<void> {
		const shortcuts = this.loadShortcutSettings ();

		// 그룹별 구분자 삽입
		const items: vscode.QuickPickItem[] = [];
		let lastGroup = '';
		for (const s of shortcuts) {
			const group = s.id.split ('.')[0];
			if (group !== lastGroup) {
				const groupLabels: Record<string, string> = {
					debug: '디버그', nav: '에디터 네비게이션',
					fold: '코드 접기/펼치기', util: '유틸리티',
				};
				items.push ({
					label: `$(symbol-folder) ${groupLabels[group] || group}`,
					kind: vscode.QuickPickItemKind.Separator,
				});
				lastGroup = group;
			}
			items.push ({
				label: s.label,
				description: `현재: ${s.mac || s.key}`,
				detail: s.command,
			});
		}

		items.push ({
			label: '$(check) 현재 설정 적용',
			description: 'VS Code 단축키에 반영합니다',
			detail: '_apply_',
		});

		items.push ({
			label: '$(discard) 기본값으로 초기화',
			description: '모든 단축키를 기본값으로 되돌립니다',
			detail: '_reset_',
		});

		const selected = await vscode.window.showQuickPick (items, {
			placeHolder: '변경할 단축키를 선택하세요',
			title: 'Annotation 단축키 설정',
		});

		if (!selected) { return; }

		if (selected.detail === '_apply_') {
			this.applyKeybindings ();
			vscode.window.showInformationMessage ('[Annotation] 단축키가 적용되었습니다.');
			return;
		}

		if (selected.detail === '_reset_') {
			this.saveShortcutSettings ([...TagSystem.DEFAULT_SHORTCUTS]);
			this.applyKeybindings ();
			vscode.window.showInformationMessage ('[Annotation] 단축키가 기본값으로 초기화되었습니다.');
			return;
		}

		// 단축키 변경
		const entry = shortcuts.find ((s) => s.command === selected.detail);
		if (!entry) { return; }

		const newKey = await vscode.window.showInputBox ({
			prompt: `"${entry.label}"의 새 단축키를 입력하세요 (예: ctrl+shift+f5, cmd+k)`,
			value: entry.mac || entry.key,
			placeHolder: 'ctrl+shift+f5',
			validateInput: (value) => {
				if (!value.trim ()) { return '단축키를 입력하세요.'; }
				// 기본적인 단축키 형식 검증
				const parts = value.toLowerCase ().split ('+');
				const validModifiers = ['ctrl', 'cmd', 'alt', 'shift', 'meta'];
				const validKeys = parts.filter ((p) => !validModifiers.includes (p));
				if (validKeys.length !== 1) { return '수식키 + 키 하나 형식으로 입력하세요 (예: alt+f7)'; }
				return undefined;
			},
		});

		if (newKey === undefined) { return; } // ESC

		entry.key = newKey.trim ().toLowerCase ();
		entry.mac = newKey.trim ().toLowerCase ();
		this.saveShortcutSettings (shortcuts);

		const apply = await vscode.window.showQuickPick (
			['예, 지금 적용', '아니요, 나중에'],
			{ placeHolder: '변경된 단축키를 지금 VS Code에 적용할까요?' }
		);

		if (apply === '예, 지금 적용') {
			this.applyKeybindings ();
			vscode.window.showInformationMessage ('[Annotation] 단축키가 적용되었습니다.');
		} else {
			vscode.window.showInformationMessage ('[Annotation] 단축키가 저장되었습니다. 다음 VS Code 시작 시 자동 적용됩니다.');
		}
	}

	private applyKeybindings (): void {
		const shortcuts = this.loadShortcutSettings ();
		if (shortcuts.length === 0) { return; }

		// VS Code keybindings.json 경로 (macOS / Linux / Windows)
		let configDir: string;
		const platform = process.platform;
		const homeDir = process.env.HOME || process.env.USERPROFILE || '';

		if (platform === 'darwin') {
			configDir = path.join (homeDir, 'Library', 'Application Support', 'Code', 'User');
		} else if (platform === 'win32') {
			configDir = path.join (process.env.APPDATA || '', 'Code', 'User');
		} else {
			configDir = path.join (homeDir, '.config', 'Code', 'User');
		}

		const keybindingsPath = path.join (configDir, 'keybindings.json');

		// 텍스트 기반 안전한 처리 — JSONC를 JSON.parse하지 않음
		const BEGIN_MARKER = '// >>> Annotation Extension BEGIN';
		const END_MARKER = '// >>> Annotation Extension END';

		let content = '';
		try {
			if (fs.existsSync (keybindingsPath)) {
				content = fs.readFileSync (keybindingsPath, 'utf-8');
			}
		} catch {
			content = '';
		}

		// Annotation 블록 제거 (마커 기반)
		const markerRegex = new RegExp (
			`\\s*${BEGIN_MARKER.replace (/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARKER.replace (/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,?`,
			'g'
		);
		content = content.replace (markerRegex, '');

		// 새 Annotation 블록 생성
		// jungleKit 커맨드는 package.json keybinding으로 등록되므로 스킵
		const filtered = shortcuts.filter ((s) => !s.command.startsWith ('jungleKit.'));
		if (filtered.length === 0) { return; }

		const newEntries = filtered.map ((s) => {
			const key = platform === 'darwin' ? (s.mac || s.key) : s.key;
			return `    { "key": ${JSON.stringify (key)}, "command": ${JSON.stringify (s.command)} }`;
		});

		const annotationBlock = [
			`    ${BEGIN_MARKER}`,
			newEntries.join (',\n'),
			`    ${END_MARKER}`,
		].join ('\n');

		// keybindings.json이 비어있거나 없는 경우
		if (!content.trim () || !content.includes ('[')) {
			content = `[\n${annotationBlock}\n]\n`;
		} else {
			// 마지막 ] 앞에 블록 삽입
			const lastBracket = content.lastIndexOf (']');
			if (lastBracket === -1) {
				content = `[\n${annotationBlock}\n]\n`;
			} else {
				const before = content.substring (0, lastBracket).trimEnd ();
				const after = content.substring (lastBracket);
				// 기존 항목이 있으면 콤마 추가
				const needsComma = before.trimEnd ().match (/[}\]"'\d]$/);
				const separator = needsComma ? ',\n' : '\n';
				content = before + separator + annotationBlock + '\n' + after;
			}
		}

		// 저장
		try {
			if (!fs.existsSync (configDir)) {
				fs.mkdirSync (configDir, { recursive: true });
			}
			fs.writeFileSync (keybindingsPath, content);
		} catch (err) {
			console.error ('[Annotation] keybindings.json 저장 실패:', err);
			vscode.window.showErrorMessage ('[Annotation] 단축키 적용 실패: keybindings.json에 쓸 수 없습니다.');
		}
	}
}

export class TagTreeItem extends vscode.TreeItem {
	annotation?: Annotation;
	constructor (
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super (label, collapsibleState);
	}
}
