import { computed, ref } from 'vue';

/**
 * 亮/暗色主题切换。
 *
 * Element Plus 的暗色方案是给 <html> 加 `dark` 类，
 * 项目自己的 CSS 变量也在 theme.css 的 `html.dark` 下覆盖，两者共用同一个开关。
 */

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'research-agent-theme';
const DARK_CLASS = 'dark';

/** 首次进入时的取值规则：用户显式选过就照旧，否则跟随系统 */
export function resolveInitialMode(stored: string | null, prefersDark: boolean): ThemeMode {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

function readStored(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // 隐私模式下 localStorage 可能不可写，降级为跟随系统
    return null;
  }
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// 模块级单例：多个组件调用 useTheme 时共享同一份状态
const mode = ref<ThemeMode>(resolveInitialMode(readStored(), prefersDark()));

function applyMode(next: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(DARK_CLASS, next === 'dark');
}

applyMode(mode.value);

export function useTheme() {
  const isDark = computed(() => mode.value === 'dark');

  function setMode(next: ThemeMode) {
    mode.value = next;
    applyMode(next);
    try {
      localStorage?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 存不下就只在本次会话生效
    }
  }

  return {
    mode,
    isDark,
    setMode,
    toggle: () => setMode(mode.value === 'dark' ? 'light' : 'dark')
  };
}
