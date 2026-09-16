/**
 * 流式输出时的「自动跟随底部」判定。
 *
 * 为什么不能只看「距底部距离」：虚拟列表的程序化滚动（scrollToItem）在长消息上
 * 只会把该项顶部对齐到视口，距底部仍然很远，若只看距离会把自己的滚动误判成
 * 「用户向上翻」而关掉跟随。所以规则是：
 *   1. 距底部足够近 -> 恢复跟随（用户自己滚回了底部）
 *   2. 仅当 scrollTop 变小（向上滚）时才停止跟随
 */

/** 距底部小于该像素数即视为「在底部」 */
export const FOLLOW_BOTTOM_THRESHOLD_PX = 80;

export interface ScrollFollowState {
  following: boolean;
  lastScrollTop: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function createFollowState(): ScrollFollowState {
  return { following: true, lastScrollTop: 0 };
}

/** 依据一次滚动事件推导新的跟随状态 */
export function nextFollowState(
  state: ScrollFollowState,
  metrics: ScrollMetrics,
  thresholdPx = FOLLOW_BOTTOM_THRESHOLD_PX
): ScrollFollowState {
  const distanceToBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  let following = state.following;

  if (distanceToBottom <= thresholdPx) {
    following = true;
  } else if (metrics.scrollTop < state.lastScrollTop) {
    following = false;
  }

  return { following, lastScrollTop: metrics.scrollTop };
}
