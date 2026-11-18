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
});

