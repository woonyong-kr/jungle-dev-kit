import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify (exec);

interface GitHubRemoteInfo {
	owner: string;
	repo: string;
	token: string | null;
}

interface ExistingPullRequest {
	html_url: string;
	title: string;
	state: string;
}

interface CreatedPullRequest {
	html_url: string;
	number: number;
}

interface CreatePullRequestInput {
	title: string;
	body: string;
	head: string;
	base: string;
}

export class GitHubPrClient {
	private remoteInfo: GitHubRemoteInfo;

	private constructor (remoteInfo: GitHubRemoteInfo) {
		this.remoteInfo = remoteInfo;
	}

	static async resolve (root: string): Promise<GitHubPrClient | null> {
		let remoteUrl = '';
		try {
			const { stdout } = await execAsync ('git remote get-url origin', { cwd: root, timeout: 10000 });
			remoteUrl = stdout.trim ();
		} catch {
			return null;
		}

		const remoteInfo = GitHubPrClient.parseGitHubRemote (remoteUrl);
		if (!remoteInfo) { return null; }
		if (!remoteInfo.token) {
			remoteInfo.token = await GitHubPrClient.getGitCredentialToken (root);
		}

		return new GitHubPrClient (remoteInfo);
	}

	get hasToken (): boolean {
		return Boolean (this.remoteInfo.token);
	}

	async findExistingPullRequest (headBranch: string): Promise<ExistingPullRequest | null> {
		const response = await this.githubRequest (
			'GET',
			`/repos/${this.remoteInfo.owner}/${this.remoteInfo.repo}/pulls?head=${encodeURIComponent (`${this.remoteInfo.owner}:${headBranch}`)}&state=open`
		);

		const pullRequests = JSON.parse (response) as ExistingPullRequest[];
		return pullRequests[0] || null;
	}

	async createPullRequest (input: CreatePullRequestInput): Promise<CreatedPullRequest> {
		const response = await this.githubRequest (
			'POST',
			`/repos/${this.remoteInfo.owner}/${this.remoteInfo.repo}/pulls`,
			{
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
			}
		);

		return JSON.parse (response) as CreatedPullRequest;
	}

	async requestPullRequestReviewers (prNumber: number, reviewers: string[]): Promise<void> {
		if (reviewers.length === 0) { return; }
		await this.githubRequest (
			'POST',
			`/repos/${this.remoteInfo.owner}/${this.remoteInfo.repo}/pulls/${prNumber}/requested_reviewers`,
			{ reviewers }
		);
	}

	private static parseGitHubRemote (remoteUrl: string): GitHubRemoteInfo | null {
		const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

		try {
			if (remoteUrl.startsWith ('http://') || remoteUrl.startsWith ('https://')) {
				const parsed = new URL (remoteUrl);
				if (parsed.hostname !== 'github.com') { return null; }
				const normalizedPath = parsed.pathname
					.replace (/\/+$/, '')
					.replace (/^\//, '')
					.replace (/\.git$/, '');
				const pathParts = normalizedPath.split ('/');
				if (pathParts.length < 2) { return null; }

				const username = decodeURIComponent (parsed.username || '');
				const password = decodeURIComponent (parsed.password || '');
				const remoteToken = GitHubPrClient.extractEmbeddedToken (username, password);

				return {
					owner: pathParts[0],
					repo: pathParts[1],
					token: envToken || remoteToken,
				};
			}

			const sshMatch = remoteUrl.match (/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/);
			if (!sshMatch) { return null; }

			return {
				owner: sshMatch[1],
				repo: sshMatch[2],
				token: envToken,
			};
		} catch {
			return null;
		}
	}

	private static extractEmbeddedToken (username: string, password: string): string | null {
		if (password) { return password; }
		if (/^(gh[pousr]_|github_pat_)/.test (username)) { return username; }
		return null;
	}

	private static async getGitCredentialToken (root: string): Promise<string | null> {
		try {
			const { stdout } = await execAsync (
				"printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
				{ cwd: root, timeout: 10000 }
			);

			const passwordLine = stdout
				.split ('\n')
				.find ((line) => line.startsWith ('password='));

			if (!passwordLine) { return null; }
			const token = passwordLine.slice ('password='.length).trim ();
			return token || null;
		} catch {
			return null;
		}
	}

	private async githubRequest (
		method: 'GET' | 'POST',
		apiPath: string,
		body?: unknown
	): Promise<string> {
		if (!this.remoteInfo.token) {
			throw new Error ('Authentication token not available');
		}

		const payload = body ? JSON.stringify (body) : undefined;

		return new Promise<string> ((resolve, reject) => {
			const request = https.request (
				{
					hostname: 'api.github.com',
					path: apiPath,
					method,
					headers: {
						'Accept': 'application/vnd.github+json',
						'Authorization': `Bearer ${this.remoteInfo.token}`,
						'User-Agent': 'jungle-dev-kit',
						'X-GitHub-Api-Version': '2022-11-28',
						...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength (payload) } : {}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on ('data', (chunk) => chunks.push (Buffer.isBuffer (chunk) ? chunk : Buffer.from (chunk)));
					response.on ('end', () => {
						const responseBody = Buffer.concat (chunks).toString ('utf8');
						if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
							reject (new Error (responseBody || `GitHub API request failed with status ${response.statusCode}`));
							return;
						}
						resolve (responseBody);
					});
				}
			);

			request.on ('error', reject);
			if (payload) {
				request.write (payload);
			}
			request.end ();
		});
	}
}
