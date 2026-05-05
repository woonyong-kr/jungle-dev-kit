module.exports = {
	root: true,
	env: {
		node: true,
		es2022: true,
	},
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 'latest',
		sourceType: 'module',
	},
	plugins: ['@typescript-eslint'],
	ignorePatterns: ['out/**', 'node_modules/**'],
	extends: ['eslint:recommended'],
	overrides: [
		{
			files: ['src/**/*.ts'],
			extends: ['plugin:@typescript-eslint/recommended'],
			rules: {
				'no-undef': 'off',
				'@typescript-eslint/no-explicit-any': 'off',
				'@typescript-eslint/no-var-requires': 'off',
				'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			},
		},
	],
};
