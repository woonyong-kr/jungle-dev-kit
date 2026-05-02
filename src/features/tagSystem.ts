import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/configManager';
import { APIKeyManager } from '../utils/apiKeyManager';

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
 * 5. @local 주석도 동일하게 파일 유지 + diff 제외 (사이드바엔 미표시)
 */

type AnnotationType = 'todo' | 'bookmark' | 'review' | 'warn' | 'breakpoint';

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

const TAG_COLORS: Record<AnnotationType, string> = {
	todo: '#66BB6A',
	bookmark: '#4FC3F7',
	review: '#FFD54F',
	warn: '#EF5350',
	breakpoint: '#FF7043',
};

const TAG_BG_COLORS: Record<AnnotationType, string> = {
	todo: 'rgba(102, 187, 106, 0.08)',
	bookmark: 'rgba(79, 195, 247, 0.08)',
	review: 'rgba(255, 213, 79, 0.08)',
	warn: 'rgba(239, 83, 80, 0.08)',
	breakpoint: 'rgba(255, 112, 67, 0.12)',
};

const TAG_LABELS: Record<AnnotationType, string> = {
	todo: '할 일',
	bookmark: '북마크',
	review: '리뷰',
	warn: '경고',
	breakpoint: '브레이크포인트',
};

const ALL_TAG_TYPES: AnnotationType[] = ['bookmark', 'todo', 'review', 'warn', 'breakpoint'];

// 주석 패턴 (파일 스캔용)
const SINGLE_LINE_RE = /^(\s*)\/\/\s*@(bookmark|todo|review|warn|breakpoint)\s+(.+)$/;
const BLOCK_SINGLE_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint)\s+(.+?)\s*\*\/$/;
const BLOCK_START_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint)\b(.*)$/;

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

		// git clean filter 등록 (모든 태그 + @local)
		this.setupAnnotationFilter (root);

		// Store initial HEAD
		this.getCurrentCommitHash ().then ((h) => { this._lastKnownHead = h; });

		// 현재 열린 파일 스캔 & 데코레이션
		this.scanVisibleEditors ();
		this._onDidChangeTreeData.fire ();

		// 스캔 완료 후 브레이크포인트 설정
		this.syncBreakpoints ();
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
			// 가상 항목은 영속 저장하지 않음 (세션 전용)
			annotations: this.annotations.filter ((a) => !a.virtual),
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
			if (!content.includes ('annotations.json')) {
				fs.appendFileSync (jkGitignore, '\nannotations.json\n');
			}
		} else {
			fs.writeFileSync (jkGitignore, 'annotations.json\n');
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

		// 기존 해당 파일의 annotation에서 displayLabel 맵 보존
		const labelMap = new Map<string, string> ();
		for (const ann of this.annotations.filter ((a) => a.file === relativePath)) {
			if (ann.displayLabel) {
				// key: type+line (줄번호 기반이라 주석 내용이 바뀌어도 displayLabel 유지)
				labelMap.set (`${ann.type}:${ann.line}`, ann.displayLabel);
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
			// displayLabel 복원
			const key = `${ann.type}:${ann.line}`;
			if (labelMap.has (key)) {
				ann.displayLabel = labelMap.get (key)!;
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
				content = singleMatch[3].trim ();
			}

			// /* @tag content */
			if (!type) {
				const blockMatch = lineText.match (BLOCK_SINGLE_RE);
				if (blockMatch) {
					type = blockMatch[2] as AnnotationType;
					content = blockMatch[3].trim ();
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
					// 다음 줄들에서 내용 수집 (* 으로 시작하는 줄)
					for (let j = i + 1; j < doc.lineCount; j++) {
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

			if (!type || !content) { continue; }

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
				backgroundColor: TAG_BG_COLORS[type],
				overviewRulerColor: TAG_COLORS[type],
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				isWholeLine: true,
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
			prompt: `${TAG_LABELS[type]} 내용을 입력하세요`,
		});
		if (!content) { return; }

		// 파일에 실제 주석 삽입
		const indent = editor.document.lineAt (line).text.match (/^(\s*)/)?.[1] || '';
		const commentText = `${indent}/* @${type} ${content} */\n`;

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
					if (lineText.match (SINGLE_LINE_RE) || lineText.match (BLOCK_SINGLE_RE)) {
						const edit = new vscode.WorkspaceEdit ();
						edit.delete (uri, new vscode.Range (ann.line, 0, ann.line + 1, 0));
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

		// 파일별 그룹핑, 역순 삭제
		const byFile = new Map<string, number[]> ();
		for (const ann of anns) {
			const lines = byFile.get (ann.file) || [];
			lines.push (ann.line);
			byFile.set (ann.file, lines);
		}

		for (const [file, lines] of byFile) {
			const uri = vscode.Uri.file (path.join (root, file));
			try {
				const doc = await vscode.workspace.openTextDocument (uri);
				const edit = new vscode.WorkspaceEdit ();
				const sorted = [...new Set (lines)].sort ((a, b) => b - a);
				for (const line of sorted) {
					if (line >= doc.lineCount) { continue; }
					const lineText = doc.lineAt (line).text;
					if (lineText.match (SINGLE_LINE_RE) || lineText.match (BLOCK_SINGLE_RE)) {
						edit.delete (uri, new vscode.Range (line, 0, line + 1, 0));
					}
				}
				await vscode.workspace.applyEdit (edit);
			} catch { /* ignore */ }
		}
	}

	// ──────────────────────────────────────────
	// Toolbar
	// ──────────────────────────────────────────

	refresh (): void {
		this.scanVisibleEditors ();
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
		const typeAnns = this.annotations
			.filter ((a) => a.type === type)
			.sort ((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));

		// 드래그 항목 제거 후 대상 위치에 삽입
		const remaining = typeAnns.filter ((a) => !draggedIds.includes (a.id));
		const targetIdx = remaining.findIndex ((a) => a.id === targetAnn.id);
		remaining.splice (targetIdx, 0, ...draggedAnns);

		// sortOrder 재정렬
		remaining.forEach ((a, i) => { a.sortOrder = i; });

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
			item.description = path.dirname (file) !== '.' ? path.dirname (file) : '';
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
		// 디버그 세션 시작 시 조사식만 등록 (브레이크포인트는 이미 설정됨)
		context.subscriptions.push (
			vscode.debug.onDidStartDebugSession (async () => {
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
		if (!root) { return; }

		// 기존 자동 브레이크포인트 제거
		if (this._debugBreakpoints.length > 0) {
			vscode.debug.removeBreakpoints (this._debugBreakpoints);
			this._debugBreakpoints = [];
		}

		const bpAnnotations = this.annotations.filter ((a) => a.type === 'breakpoint');
		if (bpAnnotations.length === 0) { return; }

		const newBreakpoints: vscode.SourceBreakpoint[] = [];

		for (const ann of bpAnnotations) {
			const filePath = path.join (root, ann.file);
			if (!fs.existsSync (filePath)) { continue; }

			const uri = vscode.Uri.file (filePath);
			// 여러 줄 블록이면 블록 끝 다음 줄, 단일 줄이면 다음 줄
			const bpLine = (ann.lineEnd ?? ann.line) + 1;
			const location = new vscode.Location (uri, new vscode.Position (bpLine, 0));
			const bp = new vscode.SourceBreakpoint (location, true);
			newBreakpoints.push (bp);
		}

		if (newBreakpoints.length > 0) {
			vscode.debug.addBreakpoints (newBreakpoints);
			this._debugBreakpoints = newBreakpoints;
		}
	}

	/**
	 * 디버그 세션 시작 시 호출 — 조사식(Watch) 패널에 직접 등록.
	 * debug.addToWatchExpressions 내부 커맨드를 사용하여
	 * 에디터 깜빡임·클립보드 오염 없이 등록한다.
	 */
	private async syncWatchExpressions (): Promise<void> {
		const bpAnnotations = this.annotations.filter ((a) => a.type === 'breakpoint');
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

	private _warnedDiagKeys = new Set<string> ();

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

		const { exec: execCb } = require ('child_process');
		const { promisify } = require ('util');
		const execAsync = promisify (execCb);

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
				this.updateAllDecorations ();
				this._onDidChangeTreeData.fire ();
				console.log (
					`[Annotation] @review ${addedCount}개 가상 생성 (${newHead.substring (0, 7)} — ${commitAuthor})`
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
			const OpenAI = require ('openai');
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
	// Git clean filter — 모든 태그 + @local diff 제외
	// ──────────────────────────────────────────

	private setupAnnotationFilter (root: string): void {
		const { execSync } = require ('child_process');
		const opts = { cwd: root, stdio: 'ignore' as const };

		try {
			const cleanScript = path.join (root, '.jungle-kit', 'scripts', 'clean-local.sh');
			const smudgeScript = path.join (root, '.jungle-kit', 'scripts', 'smudge-local.sh');

			if (fs.existsSync (cleanScript) && fs.existsSync (smudgeScript)) {
				execSync (`git config filter.jungle-local.clean "bash ${cleanScript}"`, opts);
				execSync (`git config filter.jungle-local.smudge "bash ${smudgeScript}"`, opts);
			} else {
				execSync (`git config filter.jungle-local.clean "sed -E '/(\\/\\/|\\* |^\\/\\*|\\*\\/).*@(todo|bookmark|review|warn|breakpoint|local)([[:space:]]|$)/d' || true"`, opts);
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
	// Utilities
	// ──────────────────────────────────────────

	private async getAuthorName (): Promise<string> {
		const { exec: execCb } = require ('child_process');
		const { promisify } = require ('util');
		const execAsync = promisify (execCb);
		const root = this.config.getWorkspaceRoot ();
		try {
			const { stdout } = await execAsync ('git config user.name', { cwd: root });
			return stdout.trim () || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	private async getCurrentCommitHash (): Promise<string | null> {
		const { exec: execCb } = require ('child_process');
		const { promisify } = require ('util');
		const execAsync = promisify (execCb);
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
