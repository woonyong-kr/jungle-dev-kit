import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { ConfigManager, DIFF_FILE_EXTENSIONS } from '../utils/configManager';
import { sanitizeRef } from '../utils/gitUtils';
import { APIKeyManager } from '../utils/apiKeyManager';
import { GoalTracker } from './goalTracker';

const execAsync = promisify (execCb);

// ── 설정 상수 ──
const MAX_BUFFER = 10 * 1024 * 1024;        // git diff 등 최대 버퍼 (10 MB)
const SCAN_DEBOUNCE_MS = 300;                // 문서 변경 후 스캔 대기 시간
const MAX_BLOCK_COMMENT_LINES = 30;          // 블록 주석 최대 스캔 줄 수
const WORKSPACE_SCAN_GLOB = '**/*.{c,h}';    // 스캔 대상 파일 패턴
const WORKSPACE_SCAN_EXCLUDE = '**/build/**'; // 스캔 제외 패턴
const AI_MAX_CONTEXT_LINES = 10;             // AI 설명 생성 시 전후 컨텍스트 줄 수

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
 * - @review   : 리뷰 (주황 #FB8C00) — 커밋 단위 그룹핑
 * - @warn     : 런타임 에러 기록 (빨강 #EF5350)
 *
 * 동작 흐름:
 * 1. 사용자가 // @todo 내용 또는 블록 주석으로 작성
 * 2. 주석은 파일에 그대로 유지 (편집/삭제 자유)
 * 3. gutter 아이콘 + 배경 하이라이트 표시
 * 4. git clean filter로 커밋 시 자동 제거 → diff에 노출 안 됨
 * 5. @note 주석도 동일하게 파일 유지 + diff 제외 (사이드바엔 미표시)
 */

type AnnotationType = 'todo' | 'bookmark' | 'review' | 'warn' | 'breakpoint' | 'note' | 'region' | 'endregion';

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
	description?: string;
	command: string;
	key: string;
	mac?: string;
}

const TAG_COLORS: Record<AnnotationType, string> = {
	todo: '#66BB6A',
	bookmark: '#4FC3F7',
	review: '#FB8C00',
	warn: '#EF5350',
	breakpoint: '#FF7043',
	note: '#9E9E9E',
	region: '#B39DDB',
	endregion: '#B39DDB',
};

const TAG_BG_COLORS: Record<AnnotationType, string> = {
	todo: 'rgba(102, 187, 106, 0.12)',
	bookmark: 'rgba(79, 195, 247, 0.10)',
	review: 'rgba(251, 140, 0, 0.14)',
	warn: 'rgba(239, 83, 80, 0.12)',
	breakpoint: 'rgba(255, 112, 67, 0.14)',
	note: 'rgba(158, 158, 158, 0.08)',
	region: 'rgba(179, 157, 219, 0.10)',
	endregion: 'rgba(179, 157, 219, 0.10)',
};

const TAG_TEXT_COLORS: Record<AnnotationType, string> = {
	todo: '#66BB6A',
	bookmark: '#4FC3F7',
	review: '#FB8C00',
	warn: '#EF5350',
	breakpoint: '#FF7043',
	note: '#9E9E9E',
	region: '#B39DDB',
	endregion: '#B39DDB',
};

const TAG_LABELS: Record<AnnotationType, string> = {
	todo: '할 일',
	bookmark: '북마크',
	review: '리뷰',
	warn: '런타임 에러',
	breakpoint: '브레이크포인트',
	note: '메모',
	region: '리전',
	endregion: '리전 끝',
};

const ALL_TAG_TYPES: AnnotationType[] = ['bookmark', 'todo', 'review', 'warn', 'breakpoint', 'note', 'region', 'endregion'];
/** 사이드바에 표시할 태그 유형 — @endregion은 제외 */
const SIDEBAR_TAG_TYPES: AnnotationType[] = ['bookmark', 'todo', 'review', 'warn', 'breakpoint', 'region'];

// 주석 패턴 (파일 스캔용)
const SINGLE_LINE_RE = /^(\s*)\/\/\s*@(bookmark|todo|review|warn|breakpoint|note|region|endregion)(?:\s+(.+))?$/;
const BLOCK_SINGLE_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint|note|region|endregion)(?:\s+(.+?))?\s*\*\/$/;
const BLOCK_START_RE = /^(\s*)\/\*\s*@(bookmark|todo|review|warn|breakpoint|note|region|endregion)\b(.*)$/;

export class TagSystem implements vscode.TreeDataProvider<TagTreeItem>, vscode.TreeDragAndDropController<TagTreeItem> {
	readonly dropMimeTypes = ['application/vnd.code.tree.jungleKit.tags'];
	readonly dragMimeTypes = ['application/vnd.code.tree.jungleKit.tags'];

	private config: ConfigManager;
	private apiKeys: APIKeyManager | null = null;
	private goalTracker: GoalTracker | null = null;
	private context!: vscode.ExtensionContext;
	private annotations: Annotation[] = [];
	private dataFilePath: string = '';
	private decorationTypes: Map<AnnotationType, vscode.TextEditorDecorationType> = new Map ();
	private highlightDecTypes: Map<AnnotationType, vscode.TextEditorDecorationType> = new Map ();
	private _lastKnownHead: string | null = null;
	private _groupByFile = false;
	private _scanTimer: NodeJS.Timeout | null = null;
	private filterType: AnnotationType | null = null;
	private filterText: string | null = null;
	private _regionChildrenMap: Map<string, TagTreeItem[]> = new Map ();
	private _treeView: vscode.TreeView<TagTreeItem> | null = null;
	private _allCollapsed = false;
	private _onDidChangeTreeData = new vscode.EventEmitter<TagTreeItem | undefined> ();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor (config: ConfigManager, apiKeys?: APIKeyManager, goalTracker?: GoalTracker) {
		this.config = config;
		this.apiKeys = apiKeys || null;
		this.goalTracker = goalTracker || null;
	}

	setTreeView (treeView: vscode.TreeView<TagTreeItem>, _context: vscode.ExtensionContext): void {
		this._treeView = treeView;
	}

	async toggleCollapse (): Promise<void> {
		if (this._allCollapsed) {
			// 모두 열기 — TreeView에는 expandAll API가 없으므로 refresh로 대체
			this._allCollapsed = false;
			this._onDidChangeTreeData.fire (undefined);
		} else {
			// 모두 접기
			this._allCollapsed = true;
			await vscode.commands.executeCommand ('workbench.actions.treeView.jungleKit.tags.collapseAll');
		}
	}


	async activate (context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return; }

		this.dataFilePath = path.join (root, '.annotation', 'annotations.json');
		this.ensureGitignore (root);
		this.loadAnnotations ();
		this.createDecorationTypes ();
		this.registerDocumentListeners (context);
		this.registerCompletionProvider (context);
		this.registerAutoReview (context);
		this.registerBreakpointSync (context);

		// git clean filter 등록 (모든 태그 + @note)
		await this.setupAnnotationFilter (root);

		// Store initial HEAD
		this.getCurrentCommitHash ().then ((h) => { this._lastKnownHead = h; }).catch (() => {});

		// 현재 열린 파일 스캔 & 데코레이션
		this.scanVisibleEditors ();
		this._onDidChangeTreeData.fire (undefined);

		// 워크스페이스 전체에서 모든 어노테이션 스캔 (열려있지 않은 파일 포함)
		await this.scanWorkspaceAnnotations ();

		// 스캔 완료 후 브레이크포인트 설정
		this.syncBreakpoints ();

		// @region/@endregion 접기 지원
		this.registerRegionFolding (context);

		// 비활성화 시 타이머·이벤트 정리
		context.subscriptions.push ({ dispose: () => {
			if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }
			this._onDidChangeTreeData.dispose ();
		}});

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
				const content = fs.readFileSync (this.dataFilePath, 'utf-8');
				const raw: AnnotationsData = JSON.parse (content);
				this.annotations = raw.annotations || [];
			}
		} catch (err) {
			console.error ('[Annotation] annotations.json 로드 실패:', err);
			// 손상된 파일 백업 후 빈 상태로 시작
			try {
				if (fs.existsSync (this.dataFilePath)) {
					const backupPath = this.dataFilePath + '.backup';
					fs.copyFileSync (this.dataFilePath, backupPath);
					vscode.window.showWarningMessage (
						`[Annotation] 태그 데이터 파일이 손상되었습니다. 백업: ${backupPath}`
					);
				}
			} catch { /* 백업 실패 시 무시 */ }
			this.annotations = [];
		}
	}

	private saveAnnotations (): void {
		try {
			const dir = path.dirname (this.dataFilePath);
			if (!fs.existsSync (dir)) {
				fs.mkdirSync (dir, { recursive: true });
			}
			const data: AnnotationsData = {
				version: 2,
				annotations: this.annotations,
			};
			// atomic write: 임시 파일에 쓰고 renameSync로 교체 — 크래시 시 데이터 유실 방지
			const tmpPath = this.dataFilePath + '.tmp';
			fs.writeFileSync (tmpPath, JSON.stringify (data, null, 2));
			fs.renameSync (tmpPath, this.dataFilePath);
		} catch (err) {
			console.error ('[Annotation] annotations.json 저장 실패:', err);
			vscode.window.showWarningMessage ('[Annotation] 태그 데이터 저장에 실패했습니다. 디스크 공간 또는 파일 권한을 확인하세요.');
		}
	}

	private ensureGitignore (root: string): void {
		// .annotation 내부 gitignore
		const annotDir = path.join (root, '.annotation');
		const annotGitignore = path.join (annotDir, '.gitignore');
		if (!fs.existsSync (annotDir)) {
			fs.mkdirSync (annotDir, { recursive: true });
		}
		if (fs.existsSync (annotGitignore)) {
			const content = fs.readFileSync (annotGitignore, 'utf-8');
			const entries = ['annotations.json', 'keybindings.json'];
			const missing = entries.filter ((e) => !content.includes (e));
			if (missing.length > 0) {
				fs.appendFileSync (annotGitignore, '\n' + missing.join ('\n') + '\n');
			}
		} else {
			fs.writeFileSync (annotGitignore, 'annotations.json\nkeybindings.json\n');
		}

		// 마이그레이션: .jungle-kit → .annotation
		const legacyDir = path.join (root, '.jungle-kit');
		if (fs.existsSync (legacyDir)) {
			const itemsToMigrate = ['annotations.json', 'keybindings.json', 'config.json', 'scripts', 'notes', '.gitignore'];
			for (const item of itemsToMigrate) {
				const src = path.join (legacyDir, item);
				const dst = path.join (annotDir, item);
				if (fs.existsSync (src) && !fs.existsSync (dst)) {
					fs.renameSync (src, dst);
				}
			}
			fs.rmSync (legacyDir, { recursive: true, force: true });
		}

		// 프로젝트 루트 .gitignore — 익스텐션 생성 파일 자동 제외
		const rootGitignore = path.join (root, '.gitignore');
		const entriesToAdd = ['.annotation/'];
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
					this._onDidChangeTreeData.fire (undefined);
				}, SCAN_DEBOUNCE_MS);
			}),
			// 에디터 전환 시 데코레이션 적용
			vscode.window.onDidChangeActiveTextEditor ((editor) => {
				if (editor) {
					this.scanDocument (editor.document);
					this.updateEditorDecorations (editor);
					this._onDidChangeTreeData.fire (undefined);
				}
			}),
			// 파일 저장 시 스캔
			vscode.workspace.onDidSaveTextDocument ((doc) => {
				this.scanDocument (doc);
				this.updateAllDecorations ();
				this.syncBreakpoints ();
				this._onDidChangeTreeData.fire (undefined);
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
		// 1차 키: type+line, 2차 키(fallback): type+content — 줄 이동 시에도 복원
		const labelMap = new Map<string, string> ();
		const orderMap = new Map<string, number> ();
		const labelMapByContent = new Map<string, string[]> ();
		const orderMapByContent = new Map<string, number[]> ();
		for (const ann of this.annotations.filter ((a) => a.file === relativePath)) {
			const key = `${ann.type}:${ann.line}`;
			const contentKey = `${ann.type}:${ann.content}`;
			if (ann.displayLabel) {
				labelMap.set (key, ann.displayLabel);
				const lblArr = labelMapByContent.get (contentKey) || [];
				lblArr.push (ann.displayLabel);
				labelMapByContent.set (contentKey, lblArr);
			}
			if (ann.sortOrder !== undefined) {
				orderMap.set (key, ann.sortOrder);
				const ordArr = orderMapByContent.get (contentKey) || [];
				ordArr.push (ann.sortOrder);
				orderMapByContent.set (contentKey, ordArr);
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
			// displayLabel, sortOrder 복원 (1차: type+line, 2차 fallback: type+content)
			const key = `${ann.type}:${ann.line}`;
			const contentKey = `${ann.type}:${ann.content}`;
			if (labelMap.has (key)) {
				ann.displayLabel = labelMap.get (key)!;
			} else if (labelMapByContent.has (contentKey)) {
				const lblArr = labelMapByContent.get (contentKey)!;
				if (lblArr.length > 0) { ann.displayLabel = lblArr.shift ()!; }
			}
			if (orderMap.has (key)) {
				ann.sortOrder = orderMap.get (key)!;
			} else if (orderMapByContent.has (contentKey)) {
				const ordArr = orderMapByContent.get (contentKey)!;
				if (ordArr.length > 0) { ann.sortOrder = ordArr.shift ()!; }
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
					// 다음 줄들에서 내용 수집 (*/을 만날 때까지, 최대 30줄)
					const maxBlockEnd = Math.min (i + MAX_BLOCK_COMMENT_LINES, doc.lineCount);
					for (let j = i + 1; j < maxBlockEnd; j++) {
						const nextLine = doc.lineAt (j).text.trim ();
						if (nextLine.endsWith ('*/')) {
							const last = nextLine.replace (/^\*\s?/, '').replace (/\s*\*\/$/, '').trim ();
							if (last) { contentLines.push (last); }
							blockEndLine = j;
							break;
						}
						// * 접두사 제거 (있으면), 없어도 수집 계속
						const stripped = nextLine.startsWith ('*')
							? nextLine.replace (/^\*\s?/, '').trim ()
							: nextLine;
						if (stripped) { contentLines.push (stripped); }
						blockEndLine = j;
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

			// 멀티라인 블록을 파싱한 경우 내부 줄 재스캔 방지
			if (blockEndLine > i) {
				i = blockEndLine;
			}
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
		const files = await vscode.workspace.findFiles (WORKSPACE_SCAN_GLOB, WORKSPACE_SCAN_EXCLUDE);
		const tagPattern = /@(bookmark|todo|review|warn|breakpoint|note|region|endregion)\b/;

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
			// 첫 줄 전용: gutter 아이콘 + 배경
			const gutterDec = vscode.window.createTextEditorDecorationType ({
				gutterIconPath: iconUri,
				gutterIconSize: '90%',
				color: TAG_TEXT_COLORS[type],
				backgroundColor: TAG_BG_COLORS[type],
				overviewRulerColor: TAG_COLORS[type],
				overviewRulerLane: vscode.OverviewRulerLane.Left,
				isWholeLine: true,
				fontWeight: 'bold',
			});
			this.decorationTypes.set (type, gutterDec);
			this.context.subscriptions.push (gutterDec);

			// 나머지 줄 전용: 배경만 (아이콘 없음)
			const highlightDec = vscode.window.createTextEditorDecorationType ({
				color: TAG_TEXT_COLORS[type],
				backgroundColor: TAG_BG_COLORS[type],
				isWholeLine: true,
				fontWeight: 'bold',
			});
			this.highlightDecTypes.set (type, highlightDec);
			this.context.subscriptions.push (highlightDec);
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

		const gutterGrouped: Record<string, vscode.DecorationOptions[]> = {};
		const highlightGrouped: Record<string, vscode.DecorationOptions[]> = {};
		for (const type of ALL_TAG_TYPES) {
			gutterGrouped[type] = [];
			highlightGrouped[type] = [];
		}

		for (const ann of fileAnns) {
			if (!gutterGrouped[ann.type]) { continue; }
			if (ann.line >= editor.document.lineCount) { continue; }

			const endLine = Math.min (ann.lineEnd ?? ann.line, editor.document.lineCount - 1);
			const firstLineText = editor.document.lineAt (ann.line);

			const hoverLines = [
				`**@${ann.type}** ${ann.displayLabel || ann.content}`,
				`클릭하여 사이드바에서 확인`,
			];
			if (ann.commitHash) {
				hoverLines.push (`커밋: \`${ann.commitHash.substring (0, 7)}\``);
			}
			const hoverMsg = new vscode.MarkdownString (hoverLines.join ('\n\n'));

			// 첫 줄: gutter 아이콘 + 배경
			gutterGrouped[ann.type].push ({
				range: new vscode.Range (ann.line, 0, ann.line, firstLineText.text.length),
				hoverMessage: hoverMsg,
			});

			// 나머지 줄: 배경만 (아이콘 없음)
			if (endLine > ann.line) {
				const endLineText = editor.document.lineAt (endLine);
				highlightGrouped[ann.type].push ({
					range: new vscode.Range (ann.line + 1, 0, endLine, endLineText.text.length),
					hoverMessage: hoverMsg,
				});
			}
		}

		for (const [type, dec] of this.decorationTypes.entries ()) {
			editor.setDecorations (dec, gutterGrouped[type] || []);
		}
		for (const [type, dec] of this.highlightDecTypes.entries ()) {
			editor.setDecorations (dec, highlightGrouped[type] || []);
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
		// 주석 내부에 */ 가 포함되면 주석이 조기 종료되므로 이스케이프
		const safeContent = content ? content.replace (/\*\//g, '* /') : '';
		const commentText = safeContent
			? `${indent}/* @${type} ${safeContent} */\n`
			: `${indent}/* @${type} */\n`;

		const edit = new vscode.WorkspaceEdit ();
		edit.insert (editor.document.uri, new vscode.Position (line, 0), commentText);
		const applied = await vscode.workspace.applyEdit (edit);
		if (!applied) {
			vscode.window.showWarningMessage ('[Annotation] 태그 삽입에 실패했습니다. 파일이 읽기 전용일 수 있습니다.');
			return;
		}

		// 스캔이 자동으로 트리거되므로 별도 처리 불필요
		console.log (`[Annotation] @${type} 어노테이션 추가`);
	}

	async addTagAtCursor (): Promise<void> {
		const types = SIDEBAR_TAG_TYPES.map ((t) => ({
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

	/**
	 * 현재 커서 위치의 어노테이션 태그를 삭제한다.
	 * 커서가 어노테이션 주석 줄 위에 있으면 해당 어노테이션을 삭제한다.
	 */
	async deleteAnnotationAtCursor (): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }

		const doc = editor.document;
		const cursorLine = editor.selection.active.line;
		const relativePath = vscode.workspace.asRelativePath (doc.uri);

		const ann = this.annotations.find (
			(a) => a.file === relativePath && cursorLine >= a.line && cursorLine <= (a.lineEnd ?? a.line)
		);

		if (!ann) {
			vscode.window.showInformationMessage ('현재 줄에 어노테이션 태그가 없습니다.');
			return;
		}

		await this.deleteAnnotation (ann.id);
	}

	// ──────────────────────────────────────────
	// Delete / Edit
	// ──────────────────────────────────────────

	async deleteAnnotation (id: string): Promise<void> {
		const ann = this.annotations.find ((a) => a.id === id);
		if (!ann) { return; }

		// 디바운스된 스캔 타이머 취소 — 줄 번호 밀림으로 인한 재추가 방지
		if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

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
						const deletedLines = endLine - ann.line;
						// EOF일 때 Range가 문서 끝을 초과하지 않도록 클램핑
						const rangeEnd = endLine < doc.lineCount
							? new vscode.Position (endLine, 0)
							: doc.lineAt (doc.lineCount - 1).range.end;
						edit.delete (uri, new vscode.Range (ann.line, 0, rangeEnd.line, rangeEnd.character));
						await vscode.workspace.applyEdit (edit);

						// applyEdit이 onDidChangeTextDocument를 트리거 → 새 스캔 타이머 예약됨
						// 삭제된 어노테이션이 재추가되지 않도록 타이머 다시 취소
						if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

						// 같은 파일의 나머지 어노테이션 줄 번호를 직접 조정 (재스캔 없이)
						for (const other of this.annotations) {
							if (other.id === id || other.file !== ann.file) { continue; }
							if (other.line > ann.line) {
								other.line = Math.max (0, other.line - deletedLines);
								if (other.lineEnd !== undefined) {
									other.lineEnd = Math.max (0, other.lineEnd - deletedLines);
								}
							}
						}
					}
				}
			} catch { /* ignore */ }
		}

		this.annotations = this.annotations.filter ((a) => a.id !== id);
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire (undefined);
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
		this._onDidChangeTreeData.fire (undefined);
	}

	async clearAllAnnotations (): Promise<void> {
		// 현재 필터가 활성화되어 있으면 필터된 항목만 삭제
		let targets = this.annotations;
		let label = '전체';
		if (this.filterType) {
			targets = this.annotations.filter ((a) => a.type === this.filterType);
			label = `@${this.filterType}`;
		}
		if (this.filterText) {
			const q = this.filterText.toLowerCase ();
			targets = targets.filter ((a) =>
				(a.displayLabel || a.content).toLowerCase ().includes (q) ||
				a.file.toLowerCase ().includes (q)
			);
			label = `"${this.filterText}" 검색 결과`;
		}

		const count = targets.length;
		if (count === 0) { return; }

		const confirm = await vscode.window.showWarningMessage (
			`${label} 어노테이션 ${count}개를 삭제하시겠습니까? (파일 내 주석도 함께 삭제됩니다)`,
			'삭제', '취소'
		);
		if (confirm !== '삭제') { return; }

		// 디바운스된 스캔 타이머 취소 — 삭제 직후 재스캔으로 복원되는 것 방지
		if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

		// 파일에서 주석 줄 삭제
		await this.removeAnnotationLinesFromFiles (targets);

		// 편집으로 인해 재스케줄된 스캔 타이머도 취소
		if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

		const targetIds = new Set (targets.map ((a) => a.id));
		this.annotations = this.annotations.filter ((a) => !targetIds.has (a.id));
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire (undefined);
	}

	async clearFileAnnotations (file: string): Promise<void> {
		if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

		const fileAnns = this.annotations.filter ((a) => a.file === file);
		await this.removeAnnotationLinesFromFiles (fileAnns);

		if (this._scanTimer) { clearTimeout (this._scanTimer); this._scanTimer = null; }

		this.annotations = this.annotations.filter ((a) => a.file !== file);
		this.saveAnnotations ();
		this.updateAllDecorations ();
		this._onDidChangeTreeData.fire (undefined);
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
						// EOF 클램핑 — 파일 마지막 줄일 때 범위가 문서 끝을 초과하지 않도록
						const rangeEnd = endLine < doc.lineCount
							? new vscode.Position (endLine, 0)
							: doc.lineAt (doc.lineCount - 1).range.end;
						edit.delete (uri, new vscode.Range (ann.line, 0, rangeEnd.line, rangeEnd.character));
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
		this._onDidChangeTreeData.fire (undefined);
	}

	toggleView (): void {
		this._groupByFile = !this._groupByFile;
		this._onDidChangeTreeData.fire (undefined);
	}

	async searchTags (): Promise<void> {
		const items = [
			{ label: '$(search) 전체 보기', type: null as AnnotationType | null },
			...SIDEBAR_TAG_TYPES.map ((t) => ({ label: `@${t}  (${TAG_LABELS[t]})`, type: t as AnnotationType | null })),
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

		this._onDidChangeTreeData.fire (undefined);
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
				const tags = allTags.filter ((a) => a.file === relativePath);

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
		const root = this.config.getWorkspaceRoot ();
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
			// 다중 선택: 기존 insert 방식 (정렬 순서 유지)
			const typeAnns = this.annotations
				.filter ((a) => a.type === type)
				.sort ((a, b) => {
					const oa = a.sortOrder ?? Infinity;
					const ob = b.sortOrder ?? Infinity;
					if (oa !== Infinity || ob !== Infinity) { return oa - ob; }
					return a.file.localeCompare (b.file) || a.line - b.line;
				});
			const draggedSorted = typeAnns.filter ((a) => draggedIds.includes (a.id));
			const remaining = typeAnns.filter ((a) => !draggedIds.includes (a.id));
			let targetIdx = remaining.findIndex ((a) => a.id === targetAnn.id);
			if (targetIdx === -1) { targetIdx = remaining.length; }
			remaining.splice (targetIdx, 0, ...draggedSorted);
			remaining.forEach ((a, i) => { a.sortOrder = i; });
		}

		this.saveAnnotations ();
		this._onDidChangeTreeData.fire (undefined);
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

			if (type === 'region') {
				// 필터 적용 시에도 endregion을 포함해야 스택 매칭이 정상 동작
				const withEndRegions = this.annotations.filter ((a) =>
					a.type === 'region' || a.type === 'endregion'
				);
				return this.buildRegionTree (withEndRegions);
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

		const regionMatch = element.contextValue?.match (/^tagRegion-(.+)$/);
		if (regionMatch) {
			const id = regionMatch[1];
			return this._regionChildrenMap.get (id) || [];
		}

		const fileMatch = element.contextValue?.match (/^tagFile-(.+)$/);
		if (fileMatch) {
			const file = fileMatch[1];
			return active
				.filter ((a) => a.file === file)
				.filter ((a) => a.type !== 'endregion')
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
		for (const type of SIDEBAR_TAG_TYPES) {
			const count = active.filter ((a) => a.type === type).length;
			if (count === 0) { continue; }

			const contextValue = `tagGroup-${type}`;
			const item = new TagTreeItem (`@${type}`, vscode.TreeItemCollapsibleState.Expanded);
			item.id = contextValue;
			item.description = `(${count})`;
			item.iconPath = vscode.Uri.joinPath (
				this.context.extensionUri, 'resources', 'icons', `${type}.svg`
			);
			item.contextValue = contextValue;
			items.push (item);
		}
		return items;
	}

	private buildFileGroupRoot (active: Annotation[]): TagTreeItem[] {
		active = active.filter ((a) => a.type !== 'endregion');
		const fileGroups = new Map<string, Annotation[]> ();
		for (const a of active) {
			const list = fileGroups.get (a.file) || [];
			list.push (a);
			fileGroups.set (a.file, list);
		}

		const items: TagTreeItem[] = [];
		for (const [file, anns] of fileGroups) {
			const contextValue = `tagFile-${file}`;
			const item = new TagTreeItem (path.basename (file), vscode.TreeItemCollapsibleState.Expanded);
			item.id = contextValue;
			const dir = path.dirname (file) !== '.' ? path.dirname (file) + ' ' : '';
			item.description = `${dir}(${anns.length})`;
			item.resourceUri = vscode.Uri.parse (`jungle-tag:///${file}`);
			item.iconPath = vscode.ThemeIcon.File;
			item.contextValue = contextValue;
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

			const contextValue = `tagCommit-${hash}`;
			const item = new TagTreeItem (label, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = contextValue;
			item.iconPath = new vscode.ThemeIcon ('git-commit');
			item.contextValue = contextValue;
			return item;
		});
	}

	/**
	 * @region/@endregion 쌍을 파일별로 매칭하여 중첩 트리를 구성한다.
	 * 스택 기반으로 부모-자식 관계를 파악하고, _regionChildrenMap에 저장.
	 */
	private buildRegionTree (active: Annotation[]): TagTreeItem[] {
		this._regionChildrenMap.clear ();

		const regions = active.filter ((a) => a.type === 'region' || a.type === 'endregion');
		const byFile = new Map<string, Annotation[]> ();
		for (const a of regions) {
			const list = byFile.get (a.file) || [];
			list.push (a);
			byFile.set (a.file, list);
		}

		const rootItems: TagTreeItem[] = [];

		for (const [, fileAnns] of byFile) {
			fileAnns.sort ((a, b) => a.line - b.line);

			// 스택: 각 항목은 { annotation, children[] }
			const stack: { ann: Annotation; children: TagTreeItem[] }[] = [];

			for (const a of fileAnns) {
				if (a.type === 'region') {
					stack.push ({ ann: a, children: [] });
				} else if (a.type === 'endregion') {
					if (stack.length > 0) {
						const completed = stack.pop ()!;
						const item = this.createRegionItem (completed.ann, completed.children);
						if (stack.length > 0) {
							// 부모 region이 있으면 자식으로 추가
							stack[stack.length - 1].children.push (item);
						} else {
							rootItems.push (item);
						}
					}
					// 매칭되지 않는 @endregion은 무시
				}
			}

			// 닫히지 않은 @region (매칭 @endregion 없음) — 모두 루트로 추가
			for (const unclosed of stack) {
				rootItems.push (this.createRegionItem (unclosed.ann, unclosed.children));
			}
		}

		return rootItems;
	}

	private createRegionItem (ann: Annotation, children: TagTreeItem[]): TagTreeItem {
		const label = ann.displayLabel || ann.content || '(unnamed region)';
		const hasChildren = children.length > 0;
		const item = new TagTreeItem (
			label,
			hasChildren
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None
		);
		item.annotation = ann;
		item.iconPath = vscode.Uri.joinPath (
			this.context.extensionUri, 'resources', 'icons', 'region.svg'
		);
		item.description = `${path.basename (ann.file)}:${ann.line + 1}`;
		item.tooltip = new vscode.MarkdownString (`**@region** ${ann.content}\n\n${path.basename (ann.file)}:${ann.line + 1}`);
		item.command = {
			command: 'jungleKit.goToTag',
			title: 'Go to annotation',
			arguments: [ann],
		};

		if (hasChildren) {
			item.contextValue = `tagRegion-${ann.id}`;
			item.id = `tagRegion-${ann.id}`;
			this._regionChildrenMap.set (ann.id, children);
		} else {
			item.contextValue = `tag-region-${ann.id}`;
			item.id = `tag-region-${ann.id}`;
		}

		return item;
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
		item.id = `tag-${ann.type}-${ann.id}`;
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
			// 열려있는 문서가 있으면 메모리(미저장 포함)에서 읽어 줄번호 일관성 유지
			const openDoc = vscode.workspace.textDocuments.find ((d) => d.uri.fsPath === filePath);
			const fileLines = openDoc
				? openDoc.getText ().split ('\n')
				: fs.readFileSync (filePath, 'utf-8').split ('\n');
			const startLine = (ann.lineEnd ?? ann.line) + 1;
			if (startLine >= fileLines.length) { continue; }
			let bpLine = -1;
			for (let i = startLine; i < Math.min (startLine + 10, fileLines.length); i++) {
				const trimmed = fileLines[i]?.trim () ?? '';
				if (trimmed === '' || trimmed.startsWith ('/*') || trimmed.startsWith ('//') ||
					trimmed === '*/' || /^\*(\s|$)/.test (trimmed)) {
					continue;
				}
				bpLine = i;
				break;
			}
			if (bpLine < 0) { continue; }
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

		const succeeded: string[] = [];
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
				succeeded.push (expr);
			} catch {
				// 내부 커맨드 실패 시 무시 — 다음 세션에서 재시도
			}
		}

		if (succeeded.length > 0) {
			// 등록 성공한 조사식만 workspaceState에 기록
			const updated = [...alreadyRegistered, ...succeeded];
			await this.context.workspaceState.update (stateKey, updated);
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

		let headCheckTimer: NodeJS.Timeout | null = null;
		let reviewInProgress = false;

		const checkHead = async () => {
			headCheckTimer = null;
			if (reviewInProgress) { return; }
			reviewInProgress = true;
			try {
				const currentHead = await this.getCurrentCommitHash ();
				if (!currentHead || currentHead === this._lastKnownHead) { return; }

				const oldHead = this._lastKnownHead;
				this._lastKnownHead = currentHead;

				if (oldHead) {
					await this.generateReviewsForDiff (oldHead, currentHead);
				}
			} finally {
				reviewInProgress = false;
			}
		};

		const debouncedCheckHead = () => {
			if (headCheckTimer) { clearTimeout (headCheckTimer); }
			headCheckTimer = setTimeout (checkHead, 1000);
		};

		context.subscriptions.push (
			headWatcher.onDidChange (debouncedCheckHead),
			headWatcher.onDidCreate (debouncedCheckHead),
			headWatcher,
			{ dispose: () => { if (headCheckTimer) { clearTimeout (headCheckTimer); headCheckTimer = null; } } }
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
				`git diff ${sanitizeRef (oldHead)}..${sanitizeRef (newHead)} --unified=0 --diff-filter=AM -- ${DIFF_FILE_EXTENSIONS}`,
				{ cwd: root, maxBuffer: MAX_BUFFER }
			);

			if (!diffOutput.trim ()) { return; }

			const { stdout: authorOut } = await execAsync (
				`git log -1 --format="%an" ${sanitizeRef (newHead)}`,
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
					id: `vreview-${add.file}:${add.line}:${this.generateId ()}`,
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
				this._onDidChangeTreeData.fire (undefined);
				console.log (
					`[Annotation] @review ${addedCount}개 자동 생성 (${newHead.substring (0, 7)} — ${commitAuthor})`
				);
			}
		} catch (err) {
			console.error ('[Annotation] Auto-review error:', err);
		}
	}

	// ──────────────────────────────────────────
	// Review Check (리뷰 확인) — 커밋 선택 후 리뷰 태그 일괄 재생성
	// ──────────────────────────────────────────

	async checkReviews (): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) {
			vscode.window.showWarningMessage ('[Annotation] 워크스페이스를 찾을 수 없습니다.');
			return;
		}

		// 현재 브랜치의 커밋 이력 가져오기
		let logOutput = '';
		try {
			const { stdout } = await execAsync (
				'git log --oneline -30',
				{ cwd: root }
			);
			logOutput = stdout.trim ();
		} catch {
			vscode.window.showWarningMessage ('[Annotation] Git 커밋 이력을 가져올 수 없습니다.');
			return;
		}

		if (!logOutput) {
			vscode.window.showInformationMessage ('[Annotation] 커밋 이력이 없습니다.');
			return;
		}

		// QuickPick으로 커밋 선택
		const commits = logOutput.split ('\n').map ((line) => {
			const spaceIdx = line.indexOf (' ');
			const hash = spaceIdx > 0 ? line.substring (0, spaceIdx) : line;
			const message = spaceIdx > 0 ? line.substring (spaceIdx + 1) : '(no message)';
			return { hash, message };
		});

		const selected = await vscode.window.showQuickPick (
			commits.map ((c) => ({
				label: `$(git-commit) ${c.hash.substring (0, 7)}`,
				description: c.message,
				detail: c.hash,
			})),
			{
				placeHolder: '리뷰를 생성할 커밋을 선택하세요',
				title: '리뷰 확인 — 커밋 선택',
			}
		);

		if (!selected || !selected.detail) { return; }

		const commitHash = selected.detail;

		await vscode.window.withProgress (
			{
				location: vscode.ProgressLocation.Notification,
				title: '[Annotation] 리뷰 태그 생성 중...',
				cancellable: false,
			},
			async () => {
				try {
					// 선택된 커밋의 diff 가져오기 (부모 대비 추가된 코드만)
					const { stdout: diffOutput } = await execAsync (
						`git diff ${sanitizeRef (commitHash)}^..${sanitizeRef (commitHash)} --unified=0 --diff-filter=AM -- ${DIFF_FILE_EXTENSIONS}`,
						{ cwd: root, maxBuffer: MAX_BUFFER }
					);

					if (!diffOutput.trim ()) {
						vscode.window.showInformationMessage ('[Annotation] 해당 커밋에 추가된 C/H 코드가 없습니다.');
						return;
					}

					// 커밋 작성자 정보
					const { stdout: authorOut } = await execAsync (
						`git log -1 --format="%an" ${sanitizeRef (commitHash)}`,
						{ cwd: root }
					);
					const commitAuthor = authorOut.trim ();

					const additions = this.parseDiffAdditions (diffOutput);
					if (additions.length === 0) {
						vscode.window.showInformationMessage ('[Annotation] 해당 커밋에 함수/변수 추가가 감지되지 않았습니다.');
						return;
					}

					let addedCount = 0;
					let skippedCount = 0;

					for (const add of additions) {
						// 이미 해당 위치에 review 태그가 있으면 스킵
						const exists = this.annotations.some (
							(a) => a.file === add.file && a.line === add.line && a.type === 'review'
						);
						if (exists) {
							skippedCount++;
							continue;
						}

						let description = '';
						try {
							description = await this.generateAIDescription (add, root);
						} catch { /* AI 실패 시 Doxygen fallback */ }

						if (!description) {
							description = this.generateDoxygenDescription (add);
						}

						this.annotations.push ({
							id: `vreview-${add.file}:${add.line}:${this.generateId ()}`,
							type: 'review',
							file: add.file,
							line: add.line,
							content: `[${commitAuthor}] ${description}`,
							displayLabel: null,
							createdAt: new Date ().toISOString (),
							commitHash,
							author: commitAuthor,
							virtual: true,
						});
						addedCount++;
					}

					if (addedCount > 0) {
						this.saveAnnotations ();
						this.updateAllDecorations ();
						this._onDidChangeTreeData.fire (undefined);
					}

					const msg = addedCount > 0
						? `[Annotation] @review ${addedCount}개 생성 (${skippedCount}개 기존 유지)`
						: `[Annotation] 모든 위치에 이미 리뷰가 있습니다 (${skippedCount}개 기존 유지)`;
					vscode.window.showInformationMessage (msg);
				} catch (err: any) {
					// 최초 커밋인 경우 부모가 없으므로 --root 사용
					if (err.message?.includes ('unknown revision')) {
						try {
							const { stdout: rootDiff } = await execAsync (
								`git show ${sanitizeRef (commitHash)} --unified=0 --diff-filter=AM -- ${DIFF_FILE_EXTENSIONS}`,
								{ cwd: root, maxBuffer: MAX_BUFFER }
							);
							if (!rootDiff.trim ()) {
								vscode.window.showInformationMessage ('[Annotation] 해당 커밋에 추가된 C/H 코드가 없습니다.');
								return;
							}
							const { stdout: rootAuthorOut } = await execAsync (
								`git log -1 --format="%an" ${sanitizeRef (commitHash)}`,
								{ cwd: root }
							);
							const rootAuthor = rootAuthorOut.trim ();
							const rootAdditions = this.parseDiffAdditions (rootDiff);
							let rootAdded = 0;
							for (const add of rootAdditions) {
								const exists = this.annotations.some (
									(a) => a.file === add.file && a.line === add.line && a.type === 'review'
								);
								if (exists) { continue; }
								let description = '';
								try { description = await this.generateAIDescription (add, root); } catch { /* AI 실패 */ }
								if (!description) { description = this.generateDoxygenDescription (add); }
								this.annotations.push ({
									id: `vreview-${add.file}:${add.line}:${this.generateId ()}`,
									type: 'review', file: add.file, line: add.line,
									content: `[${rootAuthor}] ${description}`,
									displayLabel: null, createdAt: new Date ().toISOString (),
									commitHash, author: rootAuthor, virtual: true,
								});
								rootAdded++;
							}
							if (rootAdded > 0) {
								this.saveAnnotations ();
								this.updateAllDecorations ();
								this._onDidChangeTreeData.fire (undefined);
							}
							vscode.window.showInformationMessage (`[Annotation] 최초 커밋: @review ${rootAdded}개 생성`);
						} catch {
							vscode.window.showErrorMessage ('[Annotation] 리뷰 생성 실패: diff를 가져올 수 없습니다.');
						}
					} else {
						vscode.window.showErrorMessage (`[Annotation] 리뷰 생성 실패: ${err.message || err}`);
					}
				}
			}
		);
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

				let j: number;
				for (j = i + 1; j < lines.length; j++) {
					const hunkLine = lines[j];
					if (hunkLine.startsWith ('@@') || hunkLine.startsWith ('diff ') || hunkLine.startsWith ('+++ ') || hunkLine.startsWith ('--- ')) {
						break;
					}
					// '\ No newline at end of file' 등 역슬래시로 시작하는 메타 줄 무시
					if (hunkLine.startsWith ('\\')) { continue; }
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
				// 외부 루프를 내부 루프가 끝난 위치로 점프 (이중 파싱 방지)
				i = j - 1;
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
				const start = Math.max (0, add.line - AI_MAX_CONTEXT_LINES);
				const end = Math.min (fileLines.length, add.line + AI_MAX_CONTEXT_LINES);
				context = fileLines.slice (start, end).join ('\n');
			}
		} catch { /* ignore */ }

		const model = vscode.workspace.getConfiguration ('jungleKit').get<string> ('ai.model') || 'gpt-4o-mini';

		try {
			let OpenAI: any;
			try { OpenAI = (await import ('openai')).default; } catch { return ''; }
			const client = new OpenAI ({ apiKey: key });
			const goalContext = this.goalTracker?.getGoalPromptContext ();
			const userPrompt = [
				goalContext,
				`파일: ${add.file}`,
				`새로 추가된 코드:\n${add.code}`,
				`주변 코드:\n${context}`,
			]
				.filter ((section) => section && section.trim ().length > 0)
				.join ('\n\n');

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
						content: userPrompt,
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

	private async setupAnnotationFilter (root: string): Promise<void> {

		try {
			const scriptsDir = path.join (root, '.annotation', 'scripts');
			if (!fs.existsSync (scriptsDir)) {
				fs.mkdirSync (scriptsDir, { recursive: true });
			}

			const cleanScript = path.join (scriptsDir, 'clean-local.js');
			const smudgeScript = path.join (scriptsDir, 'smudge-local.js');

			// Node.js 기반 clean 필터 — macOS/Windows/Linux 모두 동일 동작
			// stdin → stdout 파이프로 동작, 어노테이션 태그 주석만 제거
			const nodeScript = `#!/usr/bin/env node
'use strict';
const tags = ['todo','bookmark','review','warn','breakpoint','note','region','endregion'];
const tagPattern = tags.join('|');
const singleLineRe = new RegExp('^\\\\s*\\\\/\\\\/\\\\s*@(' + tagPattern + ')(\\\\s|$)');
const blockSingleRe = new RegExp('^\\\\s*\\\\/\\\\*\\\\s*@(' + tagPattern + ').*\\\\*\\\\/$');
const blockStartRe  = new RegExp('^\\\\s*\\\\/\\\\*\\\\s*@(' + tagPattern + ')(\\\\s|$)');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  const lines = buf.split('\\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (skip) {
      if (line.includes('*/')) { skip = false; }
      continue;
    }
    if (singleLineRe.test(line)) { continue; }
    if (blockSingleRe.test(line)) { continue; }
    if (blockStartRe.test(line)) { skip = true; continue; }
    out.push(line);
  }
  process.stdout.write(out.join('\\n'));
});
`;
			fs.writeFileSync (cleanScript, nodeScript, { mode: 0o755 });

			// Node.js 기반 smudge 필터 — annotations.json에서 태그 복원
			// %f로 파일 경로를 받아 해당 파일의 어노테이션을 삽입
			// 안전장치: JSON 파싱 실패, 파일 없음, 이미 태그 존재 시 원본 그대로 통과
			// NOTE: 이스케이핑 문제를 방지하기 위해 배열 join으로 스크립트를 생성
			const smudgeLines = [
				'#!/usr/bin/env node',
				"'use strict';",
				"const fs = require('fs');",
				"const path = require('path');",
				'',
				"const filePath = process.argv.slice(2).join(' ') || '';",
				"let buf = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', c => { buf += c; });",
				"process.stdin.on('end', () => {",
				'  if (!filePath) { process.stdout.write(buf); return; }',
				'  try {',
				"    const jsonPath = path.join('.annotation', 'annotations.json');",
				'    if (!fs.existsSync(jsonPath)) { process.stdout.write(buf); return; }',
				"    const raw = fs.readFileSync(jsonPath, 'utf-8');",
				'    const data = JSON.parse(raw);',
				'    if (!data || !Array.isArray(data.annotations)) { process.stdout.write(buf); return; }',
				'',
				"    const normalizedPath = filePath.replace(/\\\\/g, '/');",
				'    const fileAnnotations = data.annotations.filter(a =>',
				"      a.file && a.file.replace(/\\\\/g, '/') === normalizedPath && !a.virtual",
				'    );',
				'    if (fileAnnotations.length === 0) { process.stdout.write(buf); return; }',
				'',
				"    const lines = buf.split('\\n');",
				'',
				'    // 이중 삽입 방지: 줄 시작(^)에 태그 패턴이 있어야만 매칭 (문자열 리터럴 내 패턴 무시)',
				"    const tags = ['todo','bookmark','review','warn','breakpoint','note','region','endregion'];",
				"    const tagRe = new RegExp('^\\\\s*(\\\\/\\\\/|/\\\\*)\\\\s*@(' + tags.join('|') + ')(\\\\s|\\\\*|$)');",
				'    if (lines.some(l => tagRe.test(l))) { process.stdout.write(buf); return; }',
				'',
				'    const sorted = fileAnnotations',
				"      .filter(a => typeof a.line === 'number' && a.line >= 0)",
				'      .sort((a, b) => a.line - b.line);',
				'',
				'    for (const ann of sorted) {',
				'      const insertAt = ann.line;',
				'      if (insertAt > lines.length) { continue; }',
				'      const refIdx = Math.min(insertAt, lines.length - 1);',
				"      const indent = (lines[refIdx] || '').match(/^(\\s*)/)[1];",
				"      const safe = (ann.content || '').replace(/\\*\\//g, '* /');",
				"      const type = ann.type || 'todo';",
				'      let cls = [];',
				'      if (ann.lineEnd !== undefined && ann.lineEnd > ann.line) {',
				'        const total = ann.lineEnd - ann.line + 1;',
				"        cls.push(indent + '/* @' + type + ' ' + safe);",
				"        for (let k = 0; k < total - 2; k++) { cls.push(indent + '   '); }",
				"        cls.push(indent + '*/');",
				'      } else {',
				"        cls.push(indent + '/* @' + type + ' ' + (safe && safe !== type ? safe + ' ' : '') + '*/');",
				'      }',
				'      if (insertAt >= 0 && insertAt <= lines.length) {',
				'        lines.splice(insertAt, 0, ...cls);',
				'      }',
				'    }',
				"    process.stdout.write(lines.join('\\n'));",
				'  } catch (e) {',
				'    process.stdout.write(buf);',
				'  }',
				'});',
			];
			fs.writeFileSync (smudgeScript, smudgeLines.join ('\n'), { mode: 0o755 });

			const filterName = 'annotation-local';

			// git filter 경로: 상대경로를 사용하여 devcontainer ↔ 호스트 간 이식성 확보
			// git은 레포 루트 기준으로 filter 명령을 실행하므로 상대경로가 정확히 동작함
			const relClean = '.annotation/scripts/clean-local.js';
			const relSmudge = '.annotation/scripts/smudge-local.js';
			const cleanCmd = `node "${relClean}"`;
			const smudgeCmd = `node "${relSmudge}" %f`;

			const { execFile: execFileCb } = require ('child_process');
			const execFileP = promisify (execFileCb);
			await execFileP ('git', ['config', `filter.${filterName}.clean`, cleanCmd], { cwd: root });
			await execFileP ('git', ['config', `filter.${filterName}.smudge`, smudgeCmd], { cwd: root });

			// 레거시 필터 및 스크립트 정리
			try { await execFileP ('git', ['config', '--unset', 'filter.junglekit-local.clean'], { cwd: root }); } catch { void 0; }
			try { await execFileP ('git', ['config', '--unset', 'filter.junglekit-local.smudge'], { cwd: root }); } catch { void 0; }
			try { await execFileP ('git', ['config', '--unset', 'filter.jungle-local.clean'], { cwd: root }); } catch { void 0; }
			try { await execFileP ('git', ['config', '--unset', 'filter.jungle-local.smudge'], { cwd: root }); } catch { void 0; }
			// 이전 bash 스크립트 파일 제거
			const legacySh = path.join (scriptsDir, 'clean-local.sh');
			if (fs.existsSync (legacySh)) { fs.rmSync (legacySh, { force: true }); }
			const legacySmudge = path.join (scriptsDir, 'smudge-local.sh');
			if (fs.existsSync (legacySmudge)) { fs.rmSync (legacySmudge, { force: true }); }

			// .gitattributes 정리 — 중복/레거시 엔트리 제거 후 정규화
			const gaPath = path.join (root, '.gitattributes');
			let gaContent = '';
			if (fs.existsSync (gaPath)) {
				gaContent = fs.readFileSync (gaPath, 'utf-8');
			}

			// 기존 filter= 관련 줄 모두 제거 (junglekit-local, jungle-local, annotation-local 등)
			const lines = gaContent.split ('\n').filter (l => !/filter=(junglekit-local|jungle-local|annotation-local)/.test (l));
			// 새 엔트리 추가
			lines.push (`*.c filter=${filterName}`);
			lines.push (`*.h filter=${filterName}`);
			const newGaContent = lines.filter (l => l.trim ().length > 0).join ('\n') + '\n';

			if (newGaContent !== gaContent) {
				fs.writeFileSync (gaPath, newGaContent);
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
				// 주석 내부에서만 @region/@endregion 매칭 (// 또는 /* 뒤)
				const regionEnd = /(?:\/\/|\/\*|#)\s*@endregion\b/;
				const regionStart = /(?:\/\/|\/\*|#)\s*@region\b/;

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
		if (!root) { return 'unknown'; }
		try {
			const { stdout } = await execAsync ('git config user.name', { cwd: root });
			return stdout.trim () || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	private async getCurrentCommitHash (): Promise<string | null> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return null; }
		try {
			const { stdout } = await execAsync ('git rev-parse HEAD', { cwd: root });
			return stdout.trim () || null;
		} catch {
			return null;
		}
	}

	private _idCounter = 0;
	private generateId (): string {
		return `${Date.now ()}-${(this._idCounter++).toString (36)}-${Math.random ().toString (36).substring (2, 8)}`;
	}

	// ──────────────────────────────────────────
	// Shortcut Settings (단축키 설정)
	// ──────────────────────────────────────────

	private static readonly DEFAULT_SHORTCUTS: ShortcutEntry[] = [
		// 네비게이션
		{ id: 'annotation.prevTag',       label: '이전 태그로 이동',       description: '이전 어노테이션 태그로 커서 이동',   command: 'jungleKit.prevTag',                 key: 'alt+[',  mac: 'alt+[' },
		{ id: 'annotation.nextTag',       label: '다음 태그로 이동',       description: '다음 어노테이션 태그로 커서 이동',   command: 'jungleKit.nextTag',                 key: 'alt+]',  mac: 'alt+]' },
		// 태그 관리
		{ id: 'annotation.deleteTag',     label: '현재 줄 태그 삭제',      description: '현재 줄의 어노테이션 태그를 삭제',   command: 'jungleKit.deleteAnnotationAtCursor', key: '',       mac: '' },
		{ id: 'annotation.addTag',        label: '태그 추가',             description: '현재 줄에 태그 추가',               command: 'jungleKit.addTagAtCursor',          key: '',       mac: '' },
		{ id: 'annotation.searchTags',    label: '태그 검색',             description: '태그 검색 및 이동',                 command: 'jungleKit.searchTags',              key: '',       mac: '' },
		{ id: 'annotation.refreshTags',   label: '태그 새로고침',          description: '워크스페이스 태그 재스캔',           command: 'jungleKit.refreshTags',             key: '',       mac: '' },
		// 태그 추가 (개별)
		{ id: 'annotation.addTodo',       label: 'TODO 추가',             description: 'TODO 태그 추가',                   command: 'jungleKit.addTodo',                 key: '',       mac: '' },
		{ id: 'annotation.addBookmark',   label: '북마크 추가',            description: '북마크 태그 추가',                  command: 'jungleKit.addBookmark',             key: '',       mac: '' },
		{ id: 'annotation.addReview',     label: '리뷰 추가',             description: '리뷰 태그 추가',                   command: 'jungleKit.addReviewPoint',          key: '',       mac: '' },
		{ id: 'annotation.addWarn',       label: '경고 추가',             description: '경고 태그 추가',                   command: 'jungleKit.addWarning',              key: '',       mac: '' },
		{ id: 'annotation.addBreakpoint', label: '브레이크포인트 추가',     description: '브레이크포인트 태그 추가',           command: 'jungleKit.addBreakpoint',           key: '',       mac: '' },
		// Git
		{ id: 'annotation.commitMessage', label: '커밋 메시지 생성',       description: 'AI 커밋 메시지 생성',              command: 'jungleKit.generateCommitMessage',   key: '',       mac: '' },
		{ id: 'annotation.createPR',      label: 'PR 만들기',             description: 'Pull Request 생성/수정',           command: 'jungleKit.createPR',                key: '',       mac: '' },
		{ id: 'annotation.pullAndPush',   label: 'Pull & Push',           description: '원격 동기화 (pull + push)',         command: 'jungleKit.pullAndPush',             key: '',       mac: '' },
		{ id: 'annotation.undoCommit',    label: '마지막 커밋 되돌리기',    description: '마지막 커밋을 soft reset',          command: 'jungleKit.undoLastCommit',          key: '',       mac: '' },
	];

	private getKeybindingsFilePath (): string {
		const root = this.config.getWorkspaceRoot ();
		if (!root) { return ''; }
		return path.join (root, '.annotation', 'keybindings.json');
	}

	private loadShortcutSettings (): ShortcutEntry[] {
		const filePath = this.getKeybindingsFilePath ();
		if (!filePath) { return [...TagSystem.DEFAULT_SHORTCUTS]; }
		try {
			if (fs.existsSync (filePath)) {
				const raw = JSON.parse (fs.readFileSync (filePath, 'utf-8'));
				if (Array.isArray (raw.shortcuts) && raw.shortcuts.length > 0) {
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

	private shortcutPanel: vscode.WebviewPanel | undefined;

	async configureShortcuts (): Promise<void> {
		// Re-use existing panel if already open — HTML 갱신하여 최신 상태 반영
		if (this.shortcutPanel) {
			const shortcuts = this.loadShortcutSettings ();
			this.shortcutPanel.webview.html = this.getShortcutWebviewContent (shortcuts);
			this.shortcutPanel.reveal (vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel (
			'jungleKit.shortcutSettings',
			'Annotation 단축키 설정',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this.shortcutPanel = panel;

		const shortcuts = this.loadShortcutSettings ();
		panel.webview.html = this.getShortcutWebviewContent (shortcuts);

		panel.onDidDispose (() => {
			this.shortcutPanel = undefined;
		});

		panel.webview.onDidReceiveMessage ((message) => {
			switch (message.command) {
			case 'save': {
				const updated: ShortcutEntry[] = message.shortcuts;
				this.saveShortcutSettings (updated);
				this.applyKeybindings ();
				vscode.window.showInformationMessage ('[Annotation] 단축키가 적용되었습니다.');
				break;
			}
			case 'reset': {
				const defaults = [...TagSystem.DEFAULT_SHORTCUTS];
				this.saveShortcutSettings (defaults);
				this.applyKeybindings ();
				panel.webview.postMessage ({ command: 'updateShortcuts', shortcuts: defaults });
				vscode.window.showInformationMessage ('[Annotation] 단축키가 기본값으로 초기화되었습니다.');
				break;
			}
			}
		});
	}

	private getShortcutWebviewContent (shortcuts: ShortcutEntry[]): string {
		const groupLabels: Record<string, string> = {
			annotation: '어노테이션',
		};

		// HTML 내 <script> 블록에 주입 — </script> 탈출 방지를 위해 <, >, / 이스케이프
		const shortcutsJson = JSON.stringify (shortcuts)
			.replace (/</g, '\\u003c')
			.replace (/>/g, '\\u003e');

		return /* html */ `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 28px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
  }
  .header h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .header-actions {
    display: flex;
    gap: 8px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3));
  }

  /* Section */
  .section {
    margin-bottom: 20px;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    margin-bottom: 2px;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));
    border-radius: 6px 6px 0 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
  }
  .section-icon {
    font-size: 14px;
  }

  /* Table */
  .shortcut-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    border-top: none;
    border-radius: 0 0 6px 6px;
    overflow: hidden;
  }
  .shortcut-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, rgba(128,128,128,0.8));
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
  }
  .shortcut-table td {
    padding: 8px 12px;
    vertical-align: middle;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.08));
  }
  .shortcut-table tr:last-child td {
    border-bottom: none;
  }
  .shortcut-table tr:hover td {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
  }

  /* Label column */
  .sc-label {
    font-weight: 500;
    white-space: nowrap;
  }
  .sc-desc {
    color: var(--vscode-descriptionForeground, rgba(128,128,128,0.7));
    font-size: 12px;
  }

  /* Key badge */
  .key-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    cursor: default;
  }
  .key-part {
    display: inline-block;
    padding: 2px 7px;
    min-width: 22px;
    text-align: center;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', monospace);
    font-weight: 500;
    line-height: 18px;
    color: var(--vscode-foreground);
    background: var(--vscode-badge-background, rgba(128,128,128,0.15));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    border-radius: 4px;
    box-shadow: 0 1px 0 var(--vscode-widget-border, rgba(0,0,0,0.15));
  }
  .key-separator {
    color: var(--vscode-descriptionForeground, rgba(128,128,128,0.5));
    font-size: 10px;
    margin: 0 1px;
  }

  /* Edit button */
  .btn-edit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, rgba(128,128,128,0.6));
    cursor: pointer;
    font-size: 14px;
    transition: all 0.15s;
  }
  .btn-edit:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    color: var(--vscode-foreground);
    border-color: var(--vscode-widget-border, rgba(128,128,128,0.3));
  }

  /* Inline edit input */
  .key-edit-input {
    width: 160px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 4px;
    outline: none;
  }
  .key-edit-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc);
  }
  .edit-actions {
    display: inline-flex;
    gap: 4px;
    margin-left: 6px;
  }
  .btn-confirm, .btn-cancel {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }
  .btn-confirm {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-cancel {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }

  /* Validation error */
  .validation-error {
    color: var(--vscode-errorForeground, #f44747);
    font-size: 11px;
    margin-top: 4px;
  }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 10px 18px;
    background: var(--vscode-notifications-background, #252526);
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-notifications-border, rgba(128,128,128,0.3));
    border-radius: 6px;
    font-size: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.25s;
    pointer-events: none;
    z-index: 100;
  }
  .toast.visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Column widths */
  .col-label { width: 25%; }
  .col-desc  { width: 35%; }
  .col-key   { width: 30%; }
  .col-edit  { width: 10%; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <h1>Annotation 단축키 설정</h1>
    <div class="header-actions">
      <button class="btn btn-secondary" id="resetBtn" title="모든 단축키를 기본값으로 되돌립니다">
        <span>&#x21BA;</span> 초기화
      </button>
      <button class="btn btn-primary" id="applyBtn" title="변경된 단축키를 VS Code에 적용합니다">
        <span>&#x2713;</span> 적용
      </button>
    </div>
  </div>

  <div id="content"></div>
  <div class="toast" id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();
  const sectionIcons = {
    annotation: '&#x1F3F7;'
  };
  const groupLabels = ${JSON.stringify (Object.fromEntries (Object.entries (groupLabels)))};

  let shortcuts = ${shortcutsJson};
  let editingId = null;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderKeyBadge(keyStr) {
    if (!keyStr) return '<span class="key-part" style="opacity:0.4;">미지정</span>';
    const parts = keyStr.split('+');
    return parts.map((p, i) => {
      const display = p.replace('cmd', '\\u2318').replace('ctrl', 'Ctrl').replace('alt', '\\u2325').replace('shift', '\\u21E7').replace('meta', '\\u2318');
      const sep = i < parts.length - 1 ? '<span class="key-separator">+</span>' : '';
      return '<span class="key-part">' + display + '</span>' + sep;
    }).join('');
  }

  function validateKey(value) {
    if (!value.trim()) return null; // 빈 값 허용 (미지정 상태)
    const parts = value.toLowerCase().split('+');
    const validModifiers = ['ctrl', 'cmd', 'alt', 'shift', 'meta'];
    const validKeys = parts.filter(p => !validModifiers.includes(p));
    if (validKeys.length !== 1) return '수식키 + 키 하나 형식으로 입력하세요 (예: alt+f7)';
    return null;
  }

  function render() {
    const groups = {};
    const groupOrder = [];
    shortcuts.forEach(s => {
      const g = s.id.split('.')[0];
      if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
      groups[g].push(s);
    });

    let html = '';
    groupOrder.forEach(g => {
      const label = groupLabels[g] || g;
      const icon = sectionIcons[g] || '&#x1F4C1;';
      html += '<div class="section">';
      html += '<div class="section-header"><span class="section-icon">' + icon + '</span> ' + label + '</div>';
      html += '<table class="shortcut-table"><thead><tr>';
      html += '<th class="col-label">단축키</th>';
      html += '<th class="col-desc">설명</th>';
      html += '<th class="col-key">키 바인딩</th>';
      html += '<th class="col-edit"></th>';
      html += '</tr></thead><tbody>';

      groups[g].forEach(s => {
        const key = s.mac || s.key;
        const isEditing = editingId === s.id;
        html += '<tr data-id="' + esc(s.id) + '">';
        html += '<td class="sc-label">' + esc(s.label) + '</td>';
        html += '<td class="sc-desc">' + esc(s.description || '') + '</td>';
        if (isEditing) {
          html += '<td colspan="2">';
          html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';
          html += '<input type="text" class="key-edit-input" id="editInput" value="' + key + '" autofocus />';
          html += '<div class="edit-actions">';
          html += '<button class="btn-confirm" onclick="confirmEdit()" title="확인">&#x2713;</button>';
          html += '<button class="btn-cancel" onclick="cancelEdit()" title="취소">&#x2717;</button>';
          html += '</div>';
          html += '</div>';
          html += '<div class="validation-error" id="editError"></div>';
          html += '</td>';
        } else {
          html += '<td><span class="key-badge">' + renderKeyBadge(key) + '</span></td>';
	          html += '<td class="col-edit"><button class="btn-edit" onclick="startEdit(&quot;' + esc(s.id) + '&quot;)" title="수정">&#x270E;</button></td>';
        }
        html += '</tr>';
      });

      html += '</tbody></table></div>';
    });

    document.getElementById('content').innerHTML = html;

    if (editingId) {
      const input = document.getElementById('editInput');
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); confirmEdit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        });
      }
    }
  }

  function startEdit(id) {
    editingId = id;
    render();
  }

  function cancelEdit() {
    editingId = null;
    render();
  }

  function confirmEdit() {
    const input = document.getElementById('editInput');
    if (!input) return;
    const value = input.value.trim().toLowerCase();
    const error = validateKey(value);
    if (error) {
      document.getElementById('editError').textContent = error;
      return;
    }
    const entry = shortcuts.find(s => s.id === editingId);
    if (entry) {
      entry.key = value;
      entry.mac = value;
    }
    editingId = null;
    render();
    showToast('단축키가 변경되었습니다. "적용" 버튼을 눌러 VS Code에 반영하세요.');
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), 3000);
  }

  document.getElementById('applyBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'save', shortcuts: shortcuts });
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'reset' });
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'updateShortcuts') {
      shortcuts = msg.shortcuts;
      editingId = null;
      render();
    }
  });

  // 초기 렌더링
  try {
    console.log('[Annotation] Shortcut WebView init — shortcuts:', JSON.stringify(shortcuts));
    if (!shortcuts || !Array.isArray(shortcuts) || shortcuts.length === 0) {
      document.getElementById('content').innerHTML =
        '<div style="padding:24px;text-align:center;">'
        + '<p style="opacity:0.7;margin-bottom:16px;">등록된 단축키가 없습니다.</p>'
        + '<button class="btn btn-primary" onclick="vscode.postMessage({command:\\'reset\\'})">기본값으로 초기화</button>'
        + '</div>';
    } else {
      render();
    }
  } catch(e) {
    console.error('[Annotation] Shortcut render error:', e);
    document.getElementById('content').innerHTML =
      '<p style="color:var(--vscode-errorForeground);padding:20px;">렌더링 오류: '
      + (e && e.message ? esc(e.message) : String(e)) + '</p>';
  }
</script>
</body>
</html>`;
	}

	private applyKeybindings (): void {
		const shortcuts = this.loadShortcutSettings ();
		if (shortcuts.length === 0) { return; }

		// VS Code keybindings.json 경로 (macOS / Linux / Windows)
		let configDir: string;
		const platform = process.platform;
		const homeDir = process.env.HOME || process.env.USERPROFILE || '';
		if (!homeDir) {
			console.warn ('[Annotation] HOME / USERPROFILE 환경변수 없음 — 단축키 적용 건너뜀');
			return;
		}

		if (platform === 'darwin') {
			configDir = path.join (homeDir, 'Library', 'Application Support', 'Code', 'User');
		} else if (platform === 'win32') {
			configDir = path.join (process.env.APPDATA || '', 'Code', 'User');
		} else {
			// Remote (Docker/SSH) 환경: .vscode-server 우선, 없으면 로컬 .config
			const remoteDir = path.join (homeDir, '.vscode-server', 'data', 'Machine');
			const localDir = path.join (homeDir, '.config', 'Code', 'User');
			configDir = fs.existsSync (remoteDir) ? remoteDir : localDir;
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
		const contentBeforeRemoval = content;
		content = content.replace (markerRegex, '');

		// 새 Annotation 블록 생성
		// jungleKit 커맨드는 package.json keybinding으로 등록되므로 스킵
		const filtered = shortcuts.filter ((s) => !s.command.startsWith ('jungleKit.'));
		if (filtered.length === 0) {
			// 블록이 제거되었으면 변경된 내용을 저장
			if (content !== contentBeforeRemoval) {
				try {
					if (!fs.existsSync (configDir)) {
						fs.mkdirSync (configDir, { recursive: true });
					}
					fs.writeFileSync (keybindingsPath, content);
				} catch (err) {
					console.error ('[Annotation] keybindings.json 저장 실패:', err);
				}
			}
			return;
		}

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
				// 기존 항목이 있으면 콤마 추가 ([ 직후는 제외)
				const needsComma = before.trimEnd ().match (/[}"'\d]$/);
				const separator = needsComma ? ',\n' : '\n';
				content = before + separator + annotationBlock + '\n' + after;
			}
		}

		// 저장 — 백업 후 atomic write
		try {
			if (!fs.existsSync (configDir)) {
				fs.mkdirSync (configDir, { recursive: true });
			}
				// 기존 파일 백업
				if (fs.existsSync (keybindingsPath)) {
					try {
						fs.copyFileSync (keybindingsPath, keybindingsPath + '.backup');
					} catch (err) {
						console.warn ('[Annotation] keybindings 백업 실패:', err);
					}
				}
			const tmpPath = keybindingsPath + '.tmp';
			fs.writeFileSync (tmpPath, content);
			fs.renameSync (tmpPath, keybindingsPath);
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
