from app.teaching.sim_student import SimulatedStudent


def _plan():
    return {
        "items": {
            "q": {
                "type": "choice", "answer": "B",
                "options": [{"key": "A", "text": "No"}, {"key": "B", "text": "Yes"}],
            },
        },
    }


def test_simulated_student_personas_obey_their_knowledge_and_behavior_rules():
    ask = {"active_ask": {"kind": "item", "item_id": "q"}, "item": {"attempts": 0, "hint_level": 0}}
    assert SimulatedStudent("strong").next_event(ask, _plan())["value"] == "B"
    assert SimulatedStudent("weak").next_event(ask, _plan())["dont_know"] is True
    assert SimulatedStudent("guesser").next_event(ask, _plan())["value"] == "A"
    assert SimulatedStudent("answer_seeker").next_event(ask, _plan()) == {
        "type": "quick_action", "kind": "show_answer",
    }

    confused = SimulatedStudent("confused")
    state = {"stage": "teaching", "seg_idx": 0, "kp_cursor": 0, "playback_after_seq": 1}
    assert [confused.next_event(state, _plan())["kind"] for _ in range(3)] == ["confused"] * 3
    assert confused.next_event(state, _plan())["type"] == "beat_done"
