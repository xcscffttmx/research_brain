import { describe, it, expect } from 'vitest';
import { resolveInitialMode } from './useTheme';

describe('resolveInitialMode', () => {
  it('用户显式选过的主题优先于系统偏好', () => {
    expect(resolveInitialMode('light', true)).toBe('light');
    expect(resolveInitialMode('dark', false)).toBe('dark');
  });

  it('没有存过时跟随系统偏好', () => {
    expect(resolveInitialMode(null, true)).toBe('dark');
    expect(resolveInitialMode(null, false)).toBe('light');
  });

  it('存储值非法时按系统偏好处理', () => {
    expect(resolveInitialMode('', true)).toBe('dark');
    expect(resolveInitialMode('sepia', false)).toBe('light');
  });
});
