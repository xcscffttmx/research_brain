import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

/**
 * ESLint flat config。
 *
 * 分三段配置：前端 TS/Vue、服务端 ESM JS、测试文件。
 * 服务端还没迁 TS（S8-d），所以这里对 .js 只做基础规则，不接类型信息。
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.server-build/**',
      'node_modules/**',
      'bench/**',
      'src/types/auto-imports.d.ts',
      'src/types/components.d.ts'
    ]
  },

  js.configs.recommended,

  {
    files: ['**/*.{ts,vue}'],
    extends: [...tseslint.configs.recommended, ...pluginVue.configs['flat/recommended']],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    rules: {
      // TS 版规则更准，关掉基础版避免同一处报两遍
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'vue/multi-word-component-names': 'off'
    }
  },

  {
    // 声明文件里的 var / 命名空间是惯例写法
    files: ['**/*.d.ts'],
    rules: {
      'no-var': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off'
    }
  },

  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        performance: 'readonly',
        crypto: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },

  {
    files: ['**/*.test.{ts,js}', '**/*.bench.test.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    }
  },

  prettier
);
