import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConfigManager, EnvConfig } from '../utils/configManager';

const execAsync = promisify (exec);

interface CheckResult {
	name: string;
	passed: boolean;
	message: string;
	fix?: string;
}

export class EnvironmentValidator {
	private config: ConfigManager;

	constructor (config: ConfigManager) {
		this.config = config;
	}

	async validateOnStartup (): Promise<void> {
		const envConfig = this.config.loadEnvConfig ();
		if (envConfig.showOnStartup) {
			await this.validate ();
		}
	}

	async validate (): Promise<void> {
		const envConfig = this.config.loadEnvConfig ();
		const results: CheckResult[] = [];

		if (envConfig.checks.gcc) {
			results.push (await this.checkCommand ('gcc', 'gcc --version', 'sudo apt install gcc'));
		}
		if (envConfig.checks.qemu) {
			results.push (await this.checkCommand ('qemu-system-x86_64', 'qemu-system-x86_64 --version', 'sudo apt install qemu-system-x86'));
		}
		if (envConfig.checks.gdb) {
			results.push (await this.checkCommand ('gdb', 'gdb --version', 'sudo apt install gdb'));
		}
		if (envConfig.checks.make) {
			results.push (await this.checkCommand ('make', 'make --version', 'sudo apt install build-essential'));
		}
		if (envConfig.checks['clang-format']) {
			results.push (await this.checkCommand ('clang-format', 'clang-format --version', 'sudo apt install clang-format'));
		}
		if (envConfig.checks.extensions) {
			results.push (this.checkExtensions ());
		}

		this.showResults (results);
	}

	private async checkCommand (
		name: string,
		cmd: string,
		fix: string
	): Promise<CheckResult> {
		try {
			const { stdout } = await execAsync (cmd, {
				cwd: this.config.getWorkspaceRoot (),
			});
			const version = stdout.split ('\n')[0];
			return { name, passed: true, message: version };
		} catch {
			return { name, passed: false, message: 'Not installed', fix };
		}
	}

	private checkExtensions (): CheckResult {
		const required = ['ms-vscode.cpptools'];
		const missing = required.filter (
			(id) => !vscode.extensions.getExtension (id)
		);
		if (missing.length === 0) {
			return { name: 'Required extensions', passed: true, message: 'All installed' };
		}
		return {
			name: 'Required extensions',
			passed: false,
			message: `Missing: ${missing.join (', ')}`,
			fix: missing.map ((id) => `code --install-extension ${id}`).join (' && '),
		};
	}

	private showResults (results: CheckResult[]): void {
		const failed = results.filter ((r) => !r.passed);
		if (failed.length === 0) {
			return;
		}

		const channel = vscode.window.createOutputChannel ('Annotation: Environment');
		channel.clear ();
		channel.appendLine ('=== Environment Validation ===\n');
		for (const r of results) {
			const status = r.passed ? 'PASS' : 'FAIL';
			channel.appendLine (`[${status}] ${r.name}: ${r.message}`);
			if (r.fix) {
				channel.appendLine (`       Fix: ${r.fix}`);
			}
		}
		channel.show ();
	}
}
