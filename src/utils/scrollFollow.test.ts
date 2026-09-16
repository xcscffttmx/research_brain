import { describe, it, expect } from 'vitest';
import { createFollowState, nextFollowState, FOLLOW_BOTTOM_THRESHOLD_PX } from './scrollFollow';

/** 视口 500、内容 2000 的滚动容器，底部位置即 scrollTop = 1500 */
function metrics(scrollTop: number, scrollHeight = 2000, clientHeight = 500) {
  return { scrollTop, scrollHeight, clientHeight };
}

describe('nextFollowState', () => {
  it('默认跟随底部', () => {
    expect(createFollowState().following).toBe(true);
  });

  it('用户向上滚动时停止跟随', () => {
    const state = { following: true, lastScrollTop: 1500 };
    expect(nextFollowState(state, metrics(600)).following).toBe(false);
  });

  it('滚回底部附近时恢复跟随', () => {
    const state = { following: false, lastScrollTop: 600 };
    const nearBottom = 1500 - FOLLOW_BOTTOM_THRESHOLD_PX + 1;
    expect(nextFollowState(state, metrics(nearBottom)).following).toBe(true);
  });

  it('程序化向下滚动不会被误判为向上翻阅', () => {
    // 长消息上 scrollToItem 只把该项顶部对齐视口，距底部仍很远
    const state = { following: true, lastScrollTop: 300 };
    expect(nextFollowState(state, metrics(900)).following).toBe(true);
  });

  it('已停止跟随时，向下滚动但未到底部不恢复跟随', () => {
    const state = { following: false, lastScrollTop: 300 };
    expect(nextFollowState(state, metrics(700)).following).toBe(false);
  });

  it('每次都记录最新 scrollTop', () => {
    expect(nextFollowState(createFollowState(), metrics(420)).lastScrollTop).toBe(420);
  });
});
