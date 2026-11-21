// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DelayedSkeleton,
  Dialog,
  DifficultyDots,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Menu,
  Play,
  Popover,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  TextInput,
  Textarea,
  Toaster,
  Tooltip,
  TooltipProvider,
  TutorAvatar,
  TutorChip,
  toast,
} from "../src/ui";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toast.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  toast.clear();
  vi.useRealTimers();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

describe("U1 UI component library", () => {
  it("Button keeps label during pending, sets aria-busy, and prevents duplicate clicks", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" pending onClick={onClick}>
        保存设置
      </Button>,
    );
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("保存设置");
    expect(btn.getAttribute("aria-busy")).toBe("true");
    act(() => {
      btn.click();
    });
    expect(onClick).not.toHaveBeenCalled();

    render(
      <Button variant="primary" onClick={onClick}>
        保存设置
      </Button>,
    );
    act(() => {
      container.querySelector("button")!.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("IconButton exposes accessible name and active state", () => {
    render(<IconButton aria-label="播放声音" icon={<Play size={16} />} active />);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("播放声音");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("DelayedSkeleton delays showing by 400ms and maintains min display 400ms", () => {
    vi.useFakeTimers();
    render(
      <DelayedSkeleton loading={true} delayMs={400} minDisplayMs={400} fallback={<div data-testid="skel">skeleton</div>}>
        <div data-testid="content">ready</div>
      </DelayedSkeleton>,
    );
    expect(container.querySelector('[data-testid="skel"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('[data-testid="skel"]')).not.toBeNull();

    // Stop loading after 100ms: skeleton must remain visible for the remaining 300ms.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    render(
      <DelayedSkeleton loading={false} delayMs={400} minDisplayMs={400} fallback={<div data-testid="skel">skeleton</div>}>
        <div data-testid="content">ready</div>
      </DelayedSkeleton>,
    );
    expect(container.querySelector('[data-testid="skel"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="skel"]')).toBeNull();
    expect(container.querySelector('[data-testid="content"]')?.textContent).toBe("ready");
  });

  it("Field connects label, description, and error to TextInput and Textarea", () => {
    render(
      <>
        <Field label="名称" description="不超过 40 字" error="请填写名称" required>
          <TextInput />
        </Field>
        <Field label="说明">
          <Textarea />
        </Field>
      </>,
    );
    const input = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    expect(input.id).toBe(label.htmlFor);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("请填写名称");
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("Chip toggles aria-pressed and Switch invokes onCheckedChange", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <>
        <Chip selected={true} showCheck onClick={onSelect}>选项 A</Chip>
        <Switch checked={false} label="启用提示音" onCheckedChange={onToggle} />
      </>,
    );
    const chip = container.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    act(() => {
      chip.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);

    const sw = container.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    act(() => {
      sw.click();
    });
    expect(onToggle).toHaveBeenCalledWith(true, expect.anything());
  });

  it("SegmentedControl supports click and arrow-key keyboard selection", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="节奏"
        value="normal"
        onValueChange={onChange}
        options={[
          { value: "slow", label: "偏慢" },
          { value: "normal", label: "适中" },
          { value: "fast", label: "偏快" },
        ]}
      />,
    );
    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios).toHaveLength(3);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");

    act(() => {
      radios[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("fast");

    act(() => {
      radios[0].click();
    });
    expect(onChange).toHaveBeenCalledWith("slow");
  });

  it("ConfirmDialog opens as alertdialog, defaults focus to cancel, and confirms on click", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="删除项目"
        description="删除后无法恢复。"
        confirmLabel="确认删除"
        cancelLabel="保留"
        onConfirm={onConfirm}
      />,
    );
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    const buttons = Array.from(dialog!.querySelectorAll("button"));
    const cancelBtn = buttons.find((b) => b.textContent?.includes("保留"))!;
    const confirmBtn = buttons.find((b) => b.textContent?.includes("确认删除"))!;
    expect(cancelBtn).toBeTruthy();
    expect(confirmBtn).toBeTruthy();

    act(() => {
      confirmBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Dialog, Select, Menu, Popover, Tooltip render without errors", () => {
    render(
      <TooltipProvider>
        <Card padding="sm">
          <Badge tone="ok">正常</Badge>
          <Spinner size={16} />
          <Select
            aria-label="类型"
            value="a"
            options={[
              { value: "a", label: "选项 A" },
              { value: "b", label: "选项 B" },
            ]}
          />
          <Menu
            trigger={<Button>更多</Button>}
            items={[{ id: "one", label: "操作一", onSelect: () => {} }]}
          />
          <Popover trigger={<Button>详情</Button>} title="浮层标题">
            <p>一段说明文字</p>
          </Popover>
          <Tooltip content="提示文案">
            <Button>悬停</Button>
          </Tooltip>
          <Dialog open={true} onOpenChange={() => {}} title="窗口标题">
            <p>窗口正文</p>
          </Dialog>
        </Card>
      </TooltipProvider>,
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("窗口标题");
  });

  it("Toaster auto-dismisses status toasts after 5s, pauses on hover, and keeps action toasts", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    expect(container.querySelector('[data-testid="toast-item"]')).toBeNull();

    act(() => {
      toast.success("已保存");
    });
    const statusToast = container.querySelector('[role="status"][data-testid="toast-item"]') as HTMLElement;
    expect(statusToast).not.toBeNull();
    expect(statusToast.textContent).toContain("已保存");

    // Hover pauses auto-dismiss (flush state before advancing timer)
    act(() => {
      statusToast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(container.querySelector('[data-testid="toast-item"]')).not.toBeNull();

    // Leave resumes countdown and dismisses
    act(() => {
      statusToast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(container.querySelector('[data-testid="toast-item"]')).toBeNull();

    // Action toast does not auto-dismiss, and error toast uses role="alert"
    const undo = vi.fn();
    act(() => {
      toast.error("连接中断", { action: { label: "撤销", onClick: undo } });
      vi.advanceTimersByTime(10000);
    });
    const alertToast = container.querySelector('[role="alert"][data-testid="toast-item"]');
    expect(alertToast).not.toBeNull();
  });

  it("EmptyState, ErrorState, TutorAvatar, TutorChip, and DifficultyDots render accessible output", () => {
    const retry = vi.fn();
    render(
      <>
        <EmptyState title="还没有内容" description="一段说明文字" action={<Button variant="primary">开始</Button>} />
        <ErrorState error={new Error("HTTP 500 Internal Server Error")} onRetry={retry} />
        <TutorAvatar name="雪川" size="md" />
        <TutorChip name="初棠" subtitle="伴学老师" />
        <DifficultyDots value={2} max={3} />
      </>,
    );
    expect(container.textContent).toContain("还没有内容");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("暂时没有完成这一步");
    expect(container.querySelector("details")?.textContent).toContain("HTTP 500");
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("重试"))!;
    act(() => {
      retryBtn.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("2 / 3");
  });
});
