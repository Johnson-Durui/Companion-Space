import { describe, expect, it } from "vitest";
import {
  INITIAL_BOARD_FOLLOW,
  isNearBottom,
  jumpToLatestFollow,
  updateFollowOnContent,
  updateFollowOnScroll,
} from "../src/features/classroom/board-follow";

describe("board auto-follow state logic", () => {
  it("stays in auto-follow when new content arrives while near bottom", () => {
    expect(isNearBottom(560, 400, 1000, 48)).toBe(true);
    expect(isNearBottom(200, 400, 1000, 48)).toBe(false);
    expect(isNearBottom(0, 500, 320, 48)).toBe(true);

    let state = updateFollowOnContent(INITIAL_BOARD_FOLLOW, 3);
    expect(state).toEqual({ autoFollow: true, unreadCount: 0, seenCount: 3 });

    state = updateFollowOnContent(state, 5);
    expect(state).toEqual({ autoFollow: true, unreadCount: 0, seenCount: 5 });
  });

  it("pauses auto-follow on manual upward scroll and counts unread blocks until jump", () => {
    let state = updateFollowOnContent(INITIAL_BOARD_FOLLOW, 4);
    state = updateFollowOnScroll(state, false);
    expect(state.autoFollow).toBe(false);
    expect(state.unreadCount).toBe(0);

    // New board blocks arrive while user is reading earlier content
    state = updateFollowOnContent(state, 6);
    expect(state.autoFollow).toBe(false);
    expect(state.unreadCount).toBe(2);

    state = updateFollowOnContent(state, 7);
    expect(state.unreadCount).toBe(3);

    // Jumping back to latest clears unread and re-enables auto-follow
    state = jumpToLatestFollow(7);
    expect(state).toEqual({ autoFollow: true, unreadCount: 0, seenCount: 7 });

    // Scrolling back to bottom manually also clears unread and resumes auto-follow
    state = updateFollowOnScroll(state, false);
    state = updateFollowOnContent(state, 9);
    expect(state.unreadCount).toBe(2);
    state = updateFollowOnScroll(state, true);
    expect(state).toEqual({ autoFollow: true, unreadCount: 0, seenCount: 9 });
  });
});
