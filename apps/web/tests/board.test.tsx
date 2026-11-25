import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BoardBlock, applyBoardEvent, parseImageSpec, parsePlotSpec, validPlotExpression, type Board,
} from "@companion-space/board";

describe("board package", () => {
  it("renders math and a GFM table without raw HTML", () => {
    const math = renderToStaticMarkup(<BoardBlock block={{ id: "m", type: "math", content: "x^2+1" }} />);
    const table = renderToStaticMarkup(<BoardBlock block={{ id: "t", type: "table", content: "|x|y|\n|-|-|\n|1|2|" }} />);
    expect(math).toContain("katex");
    expect(table).toContain("<table>");
    expect(renderToStaticMarkup(<BoardBlock block={{ id: "x", type: "text", content: "<script>alert(1)</script>" }} />))
      .not.toContain("<script>");

    // Render failures show a friendly Chinese explanation with collapsed raw source, never English "Render failed"
    const invalidImage = renderToStaticMarkup(
      <BoardBlock block={{ id: "bad", type: "image", content: "not-valid-json" }} />,
    );
    expect(invalidImage).toContain("这张图没画出来");
    expect(invalidImage).toContain("查看原始内容");
    expect(invalidImage).toContain("<details");
    expect(invalidImage).not.toContain("Render failed");
  });

  it("accepts bounded plot specs and rejects executable or malformed expressions", async () => {
    await expect(parsePlotSpec('{"fn":["sin(x)/x"],"x":[-10,10],"points":[[0,1]]}')).resolves.toMatchObject({ x: [-10, 10] });
    await expect(validPlotExpression("sqrt(x^2) + cos(x)")).resolves.toBe(true);
    for (const source of ["import('x')", "evaluate('2+2')", "f(x)=x", "x[0]", "x; 2"]) {
      await expect(validPlotExpression(source)).resolves.toBe(false);
    }
    await expect(parsePlotSpec('{"fn":["x.constructor"],"x":[-1,1]}')).resolves.toBeNull();
  });

  it("validates same-origin material images and preserves cleared pages", () => {
    expect(parseImageSpec('{"material_id":"material_1","page":2,"bbox":[0.1,0.2,0.8,0.9]}')).not.toBeNull();
    expect(parseImageSpec('{"material_id":"../secret","page":2}')).toBeNull();
    const initial: Board = { pages: [{ id: "page-1", blocks: [] }] };
    const added = applyBoardEvent(initial, { type: "board", data: { op: "add", id: "b1", type: "text", content: "first" } });
    const cleared = applyBoardEvent(added, { type: "board", data: { op: "clear" } });
    expect(cleared.pages).toHaveLength(2);
    expect(cleared.pages[0].blocks[0].content).toBe("first");
  });

  it("accepts parameterized plot specs with keyframes and rejects unsafe or out-of-range params", async () => {
    const valid = JSON.stringify({
      fn: ["a * x^2 + b"],
      x: [-5, 5],
      y: [-4, 4],
      params: [
        { name: "a", label: "开口系数 a", min: -3, max: 3, step: 0.5, default: 1 },
        { name: "b", label: "截距 b", min: -2, max: 2, step: 0.5, default: 0 },
      ],
      keyframes: [
        { label: "标准抛物线", values: { a: 1, b: 0 } },
        { label: "开口向下", values: { a: -1, b: 1 } },
      ],
    });
    await expect(parsePlotSpec(valid)).resolves.toMatchObject({
      params: [
        { name: "a", default: 1 },
        { name: "b", default: 0 },
      ],
      keyframes: [
        { label: "标准抛物线", values: { a: 1, b: 0 } },
        { label: "开口向下", values: { a: -1, b: 1 } },
      ],
    });

    // Undeclared parameter in expression must fail
    await expect(parsePlotSpec(JSON.stringify({
      fn: ["c * x"],
      x: [-5, 5],
      params: [{ name: "a", label: "a", min: -2, max: 2, step: 0.5, default: 1 }],
    }))).resolves.toBeNull();

    // Reserved symbol name ("x" or "sin") as parameter must fail
    await expect(parsePlotSpec(JSON.stringify({
      fn: ["x^2"],
      x: [-5, 5],
      params: [{ name: "x", label: "x", min: -2, max: 2, step: 0.5, default: 0 }],
    }))).resolves.toBeNull();
    await expect(parsePlotSpec(JSON.stringify({
      fn: ["sin(x)"],
      x: [-5, 5],
      params: [{ name: "sin", label: "sin", min: -2, max: 2, step: 0.5, default: 0 }],
    }))).resolves.toBeNull();

    // Out-of-range default or keyframe value must fail
    await expect(parsePlotSpec(JSON.stringify({
      fn: ["a * x"],
      x: [-5, 5],
      params: [{ name: "a", label: "a", min: -2, max: 2, step: 0.5, default: 5 }],
    }))).resolves.toBeNull();
    await expect(parsePlotSpec(JSON.stringify({
      fn: ["a * x"],
      x: [-5, 5],
      params: [{ name: "a", label: "a", min: -2, max: 2, step: 0.5, default: 1 }],
      keyframes: [{ label: "越界", values: { a: 9 } }],
    }))).resolves.toBeNull();
  });

  it("applies board_param events in board reducer and updates block paramValues", () => {
    const plotContent = JSON.stringify({
      fn: ["a * x^2"],
      x: [-4, 4],
      params: [{ name: "a", label: "a", min: -3, max: 3, step: 0.5, default: 1 }],
    });
    const initial: Board = { pages: [{ id: "page-1", blocks: [] }] };
    const added = applyBoardEvent(initial, {
      type: "board",
      seq: 1,
      data: { op: "add", id: "b1", type: "plot", content: plotContent },
    });
    const updated = applyBoardEvent(added, {
      type: "board_param",
      seq: 4,
      data: { target: "b1", name: "a", value: -1.5 },
    });
    expect(updated.pages[0].blocks[0].paramValues).toEqual({ a: -1.5 });
    expect(updated.pages[0].blocks[0].paramSeq).toBe(4);
  });
});

