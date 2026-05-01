import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/configManager';

interface TokenizedBlock {
	file: string;
	startLine: number;
	endLine: number;
	functionName: string;
	normalizedTokens: string;
	originalCode: string;
}

/**
 * Duplicate Logic Detector
 * Tokenizes C source, normalizes variable/function names,
 * then compares blocks to find copy-paste duplicates.
 */
export class DuplicateDetector {
	private config: ConfigManager;
	private diagnostics: vscode.DiagnosticCollection;
	private minTokens: number;

	constructor (config: ConfigManager) {
		this.config = config;
		this.diagnostics = vscode.languages.createDiagnosticCollection (
			'jungleKit-duplicates'
		);
		this.minTokens = vscode.workspace
			.getConfiguration ('jungleKit')
			.get<number> ('duplicateDetector.minTokens', 50);
	}

	async checkWorkspace (): Promise<void> {
		const root = this.config.getWorkspaceRoot ();
		if (!root) {return;}

		const cFiles = await vscode.workspace.findFiles (
			'**/*.{c,h}',
			'**/build/**'
		);

		const allBlocks: TokenizedBlock[] = [];

		for (const file of cFiles) {
			const content = fs.readFileSync (file.fsPath, 'utf-8');
			const blocks = this.extractFunctions (content, file.fsPath);
			allBlocks.push (...blocks);
		}

		const duplicates = this.findDuplicates (allBlocks);
		this.reportDuplicates (duplicates);
	}

	private extractFunctions (
		content: string,
		filePath: string
	): TokenizedBlock[] {
		const blocks: TokenizedBlock[] = [];
		const lines = content.split ('\n');

		let inFunction = false;
		let braceDepth = 0;
		let funcStart = 0;
		let funcName = '';
		let funcLines: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Detect function start: line with opening brace after declaration
			if (!inFunction) {
				// Simple heuristic: line ends with { and previous line has a function-like pattern
				if (line.includes ('{') && !line.includes ('struct') &&
					!line.includes ('enum') && !line.includes ('=')) {
					// Look back for function name
					const prevLine = i > 0 ? lines[i - 1].trim () : '';
					const nameMatch = prevLine.match (/(\w+)\s*\(/);
					if (nameMatch || line.match (/(\w+)\s*\(.*\)\s*\{/)) {
						inFunction = true;
						funcStart = i;
						funcName = nameMatch?.[1] ||
							line.match (/(\w+)\s*\(/)?.[1] || 'unknown';
						braceDepth = 0;
						funcLines = [];
					}
				}
			}

			if (inFunction) {
				funcLines.push (line);
				for (const ch of line) {
					if (ch === '{') {braceDepth++;}
					if (ch === '}') {braceDepth--;}
				}

				if (braceDepth === 0 && funcLines.length > 1) {
					const code = funcLines.join ('\n');
					const tokens = this.tokenize (code);

					if (tokens.length >= this.minTokens) {
						blocks.push ({
							file: filePath,
							startLine: funcStart,
							endLine: i,
							functionName: funcName,
							normalizedTokens: this.normalize (tokens),
							originalCode: code,
						});
					}
					inFunction = false;
				}
			}
		}

		return blocks;
	}

	private tokenize (code: string): string[] {
		// Remove comments
		const noComments = code
			.replace (/\/\/.*$/gm, '')
			.replace (/\/\*[\s\S]*?\*\//g, '');

		// Tokenize: split by non-alphanumeric, keep meaningful tokens
		return noComments
			.split (/([{}();\[\],\s+\-*\/%&|^~!=<>.?:])+/)
			.map ((t) => t.trim ())
			.filter ((t) => t.length > 0);
	}

	private normalize (tokens: string[]): string {
		// Replace identifiers with placeholders
		// Keep: keywords, types, operators
		const cKeywords = new Set ([
			'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
			'break', 'continue', 'return', 'goto', 'sizeof', 'typedef',
			'struct', 'enum', 'union', 'void', 'int', 'char', 'short', 'long',
			'unsigned', 'signed', 'float', 'double', 'const', 'static',
			'extern', 'volatile', 'register', 'auto', 'inline',
			'NULL', 'true', 'false', 'bool',
			'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
			'int8_t', 'int16_t', 'int32_t', 'int64_t',
			'size_t', 'ssize_t', 'off_t', 'pid_t',
		]);

		const varMap = new Map<string, string> ();
		let varCounter = 0;

		return tokens
			.map ((token) => {
				if (cKeywords.has (token)) {return token;}
				if (/^\d+$/.test (token)) {return 'NUM';}
				if (/^[{}();\[\],+\-*\/%&|^~!=<>.?:]$/.test (token)) {
					return token;
				}

				// Map identifier to placeholder
				if (!varMap.has (token)) {
					varMap.set (token, `V${varCounter++}`);
				}
				return varMap.get (token)!;
			})
			.join (' ');
	}

	private findDuplicates (
		blocks: TokenizedBlock[]
	): [TokenizedBlock, TokenizedBlock][] {
		const duplicates: [TokenizedBlock, TokenizedBlock][] = [];

		for (let i = 0; i < blocks.length; i++) {
			for (let j = i + 1; j < blocks.length; j++) {
				if (blocks[i].normalizedTokens === blocks[j].normalizedTokens) {
					// Exact match after normalization
					duplicates.push ([blocks[i], blocks[j]]);
				}
			}
		}

		return duplicates;
	}

	private reportDuplicates (
		duplicates: [TokenizedBlock, TokenizedBlock][]
	): void {
		// Clear previous
		this.diagnostics.clear ();

		if (duplicates.length === 0) {
			vscode.window.showInformationMessage (
				'[Jungle Kit] No duplicate code detected'
			);
			return;
		}

		const diagMap = new Map<string, vscode.Diagnostic[]> ();

		for (const [a, b] of duplicates) {
			const relA = vscode.workspace.asRelativePath (a.file);
			const relB = vscode.workspace.asRelativePath (b.file);

			const diagA = new vscode.Diagnostic (
				new vscode.Range (a.startLine, 0, a.endLine, 0),
				`[Duplicate] ${a.functionName}() is logically identical to ${b.functionName}() in ${relB}:${b.startLine + 1}`,
				vscode.DiagnosticSeverity.Warning
			);

			const diagB = new vscode.Diagnostic (
				new vscode.Range (b.startLine, 0, b.endLine, 0),
				`[Duplicate] ${b.functionName}() is logically identical to ${a.functionName}() in ${relA}:${a.startLine + 1}`,
				vscode.DiagnosticSeverity.Warning
			);

			if (!diagMap.has (a.file)) {diagMap.set (a.file, []);}
			if (!diagMap.has (b.file)) {diagMap.set (b.file, []);}
			diagMap.get (a.file)!.push (diagA);
			diagMap.get (b.file)!.push (diagB);
		}

		for (const [file, diags] of diagMap) {
			this.diagnostics.set (vscode.Uri.file (file), diags);
		}

		vscode.window.showWarningMessage (
			`[Jungle Kit] ${duplicates.length}개 중복 코드 발견`
		);
	}
}
