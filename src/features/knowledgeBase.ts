import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../utils/configManager';

interface KnowledgeEntry {
	type: 'review' | 'panic' | 'test-failure';
	key: string;
	content: string;
	verified: boolean;
	timestamp: string;
}

export class KnowledgeBase {
	private config: ConfigManager;
	private entries: KnowledgeEntry[] = [];
	private kbPath: string;

	constructor (config: ConfigManager) {
		this.config = config;
		this.kbPath = path.join (config.getConfigDir (), 'knowledge', 'kb.json');
		this.load ();
	}

	private load (): void {
		if (fs.existsSync (this.kbPath)) {
			try {
				this.entries = JSON.parse (fs.readFileSync (this.kbPath, 'utf-8'));
			} catch {
				this.entries = [];
			}
		}
	}

	private save (): void {
		const dir = path.dirname (this.kbPath);
		if (!fs.existsSync (dir)) {
			fs.mkdirSync (dir, { recursive: true });
		}
		fs.writeFileSync (this.kbPath, JSON.stringify (this.entries, null, 2));
	}

	findRelevant (query: string): KnowledgeEntry | null {
		// Simple keyword matching for now
		// TODO: Implement better similarity matching
		for (const entry of this.entries) {
			if (entry.verified && entry.key && query.includes (entry.key)) {
				return entry;
			}
		}
		return null;
	}

	add (type: KnowledgeEntry['type'], key: string, content: string): void {
		this.entries.push ({
			type,
			key,
			content,
			verified: false,
			timestamp: new Date ().toISOString (),
		});
		this.save ();
	}

	verify (index: number): void {
		if (index < this.entries.length) {
			this.entries[index].verified = true;
			this.save ();
		}
	}

	getAll (): KnowledgeEntry[] {
		return [...this.entries];
	}
}
