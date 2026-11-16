from __future__ import annotations

from app.models.classroom import BoardActionV2, StepSandboxPayload
from app.models.domain import LessonScript


def advance_sandbox(actions: list[BoardActionV2]) -> list[BoardActionV2]:
    result: list[BoardActionV2] = []
    for action in actions:
        if action.kind != "step_sandbox":
            result.append(action)
            continue
        if not isinstance(action.payload, StepSandboxPayload):
            raise RuntimeError("Invalid sandbox payload")
        payload = action.payload.model_dump()
        payload["current_step"] = min(
            int(payload["current_step"]) + 1,
            max(len(payload["steps"]) - 1, 0),
        )
        result.append(action.model_copy(update={"payload": StepSandboxPayload.model_validate(payload)}))
    return result


def sandbox_at_last(actions: list[BoardActionV2]) -> bool:
    sandbox = next(action for action in actions if action.kind == "step_sandbox")
    payload = sandbox.payload
    if not isinstance(payload, StepSandboxPayload):
        raise RuntimeError("Invalid sandbox payload")
    return payload.current_step >= len(payload.steps) - 1


def binary_search_steps(target: int) -> list[dict[str, object]]:
    values = [2, 8, 12, 17, 23, 31, 44, 50]
    left, right = 0, len(values) - 1
    steps: list[dict[str, object]] = []
    while left <= right:
        mid = left + (right - left) // 2
        value = values[mid]
        steps.append(
            {
                "label": f"比较 {value}",
                "values": {"left": left, "mid": mid, "right": right, "value": value},
                "active_line": 2,
            }
        )
        if value == target:
            break
        if value < target:
            left = mid + 1
        else:
            right = mid - 1
    return steps


def update_sandbox_parameters(
    actions: list[BoardActionV2],
    parameters: dict[str, str | int | float],
) -> list[BoardActionV2]:
    result: list[BoardActionV2] = []
    for action in actions:
        if action.kind != "step_sandbox":
            result.append(action)
            continue
        if not isinstance(action.payload, StepSandboxPayload):
            raise RuntimeError("Invalid sandbox payload")
        unknown = set(parameters) - set(action.payload.editable_parameters)
        if unknown:
            raise ValueError(f"Sandbox parameter is not editable: {sorted(unknown)[0]}")
        next_parameters = {**action.payload.parameters, **parameters}
        steps = action.payload.steps
        if action.payload.editable_parameters == ["target"]:
            target = next_parameters.get("target")
            if not isinstance(target, int):
                raise ValueError("target must be an integer")
            steps = binary_search_steps(target)
        payload = StepSandboxPayload.model_validate(
            {
                **action.payload.model_dump(),
                "parameters": next_parameters,
                "steps": steps,
                "current_step": 0,
            }
        )
        result.append(action.model_copy(update={"payload": payload}))
    return result


def build_board_actions(
    topic: str,
    citation_ids: list[str],
    script: LessonScript,
) -> list[BoardActionV2]:
    normalized = topic.casefold()
    binary_search = "binary search" in normalized or "二分" in normalized
    if binary_search:
        sections = [{
            "heading": "不变量",
            "markdown": "闭区间 [L, R] 在 L == R 时仍含一个候选元素，因此循环条件是 L <= R。",
            "formula": "mid = L + ((R - L) // 2)",
        }]
        code = "while left <= right:\n    mid = left + (right-left)//2"
        parameters = {"target": 23, "values": "[2,8,12,17,23,31,44,50]"}
        steps = binary_search_steps(23)
        editable_parameters = ["target"]
        quiz_question = "闭区间二分查找更新边界后，最重要的检查是什么？"
        quiz_options = [
            {"id": "a", "label": "数组长度是否变成偶数"},
            {"id": "b", "label": "目标若存在，是否仍保留在 [L, R] 中"},
            {"id": "c", "label": "mid 是否始终等于 target"},
        ]
    else:
        sections = [
            {"heading": step.caption, "markdown": step.board.content}
            for step in script.steps
        ]
        # The sandbox shows the provider-validated source boards, not generic pseudo-code.
        code = "\n\n".join(
            f"# {step.caption}\n{step.board.content}" for step in script.steps
        )
        parameters = {"input": topic}
        steps = [
            {
                "label": step.caption,
                "values": {"board": step.board.content, "narration": step.narration},
                "active_line": index + 1,
            }
            for index, step in enumerate(script.steps)
        ]
        editable_parameters = ["input"]
        quiz_question = f"关于“{topic}”，哪一种学习顺序与当前板书一致？"
        quiz_options = [
            {"id": "a", "label": "跳过条件，直接记住最后结论"},
            {"id": "b", "label": " → ".join(step.caption for step in script.steps[:3])},
            {"id": "c", "label": "只看术语，不验证步骤之间的关系"},
        ]

    mermaid = next(
        (step.board.content for step in script.steps if step.board.kind.value == "mermaid"),
        "flowchart LR\n" + "\n".join(
            f"S{index}[{step.caption}] --> S{index + 1}[{script.steps[index + 1].caption}]"
            for index, step in enumerate(script.steps[:-1])
        ),
    )
    return [
        BoardActionV2(id="concept", kind="concept_sheet", title=f"{topic} · 核心概念", payload={"sections": sections}, citation_ids=citation_ids),
        BoardActionV2(id="sandbox", kind="step_sandbox", title="单步推演", payload={"code": code, "parameters": parameters, "editable_parameters": editable_parameters, "steps": steps, "current_step": 0}, citation_ids=citation_ids),
        BoardActionV2(id="diagram", kind="interactive_diagram", title="状态关系", payload={
            "mermaid": mermaid,
            "nodes": [{"id": f"S{index}", "label": step.caption, "question": f"请解释“{step.caption}”在 {topic} 中的作用。"} for index, step in enumerate(script.steps)],
            "edges": [{"from_id": f"S{index}", "to_id": f"S{index + 1}"} for index in range(len(script.steps) - 1)],
        }, citation_ids=citation_ids),
        BoardActionV2(id="quiz", kind="checkpoint_quiz", title="随堂检验", payload={"question": quiz_question, "options": quiz_options}, citation_ids=citation_ids),
        BoardActionV2(id="focus", kind="laser_focus", title="导师聚焦", payload={"target_action_id": "concept", "target": "sections.0"}, citation_ids=citation_ids),
    ]
