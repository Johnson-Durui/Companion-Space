export interface BoardFollowState {
  autoFollow: boolean;
  unreadCount: number;
  seenCount: number;
}

export const INITIAL_BOARD_FOLLOW: BoardFollowState = {
  autoFollow: true,
  unreadCount: 0,
  seenCount: 0,
};

export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = 48,
): boolean {
  if (scrollHeight <= clientHeight + 2) return true;
  return scrollHeight - (scrollTop + clientHeight) <= thresholdPx;
}

export function updateFollowOnScroll(
  state: BoardFollowState,
  nearBottom: boolean,
): BoardFollowState {
  if (nearBottom) {
    if (state.autoFollow && state.unreadCount === 0) return state;
    return { ...state, autoFollow: true, unreadCount: 0 };
  }
  if (!state.autoFollow) return state;
  return { ...state, autoFollow: false };
}

export function updateFollowOnContent(
  state: BoardFollowState,
  totalItems: number,
): BoardFollowState {
  if (totalItems <= state.seenCount) {
    if (totalItems === state.seenCount) return state;
    return { ...state, seenCount: totalItems, unreadCount: 0 };
  }
  const delta = totalItems - state.seenCount;
  if (state.autoFollow) {
    return { autoFollow: true, unreadCount: 0, seenCount: totalItems };
  }
  return {
    autoFollow: false,
    unreadCount: state.unreadCount + delta,
    seenCount: totalItems,
  };
}

export function jumpToLatestFollow(totalItems: number): BoardFollowState {
  return {
    autoFollow: true,
    unreadCount: 0,
    seenCount: totalItems,
  };
}
