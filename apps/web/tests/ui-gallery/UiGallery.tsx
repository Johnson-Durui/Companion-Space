import { useEffect, useState } from "react";
import {
  TUTOR_THEME_IDS,
  TUTOR_THEMES,
  applyTutorTheme,
  type TutorThemeId,
} from "../../src/styles/tutor-themes";
import {
  ArrowRight,
  Badge,
  BookOpen,
  BrandMark,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Dialog,
  DifficultyDots,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Menu,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Popover,
  SegmentedControl,
  Select,
  Settings,
  Skeleton,
  Spinner,
  Switch,
  TextInput,
  Textarea,
  Toaster,
  Tooltip,
  TooltipProvider,
  TutorAvatar,
  TutorChip,
  Volume2,
  toast,
} from "../../src/ui";

type SurfaceMode = "desk" | "stage" | "paper";
type FontMode = "bundled" | "system";

function readInitialQuery() {
  const params = new URLSearchParams(window.location.search);
  const font: FontMode = params.get("font") === "system" ? "system" : "bundled";
  const surfaceParam = params.get("surface");
  const surface: SurfaceMode =
    surfaceParam === "stage" || surfaceParam === "paper" ? surfaceParam : "desk";
  const themeParam = params.get("theme");
  const theme: TutorThemeId =
    themeParam && themeParam in TUTOR_THEMES ? (themeParam as TutorThemeId) : "default";
  return { font, surface, theme };
}

export function UiGallery() {
  const initial = readInitialQuery();
  const [fontMode, setFontMode] = useState<FontMode>(initial.font);
  const [surface, setSurface] = useState<SurfaceMode>(initial.surface);
  const [themeId, setThemeId] = useState<TutorThemeId>(initial.theme);

  const [chipSelected, setChipSelected] = useState(true);
  const [switchOn, setSwitchOn] = useState(true);
  const [segmentValue, setSegmentValue] = useState("b");
  const [selectValue, setSelectValue] = useState("a");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDemo, setPendingDemo] = useState(false);

  useEffect(() => {
    applyTutorTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    if (fontMode === "system") {
      document.documentElement.dataset.font = "system";
    } else {
      delete document.documentElement.dataset.font;
    }
  }, [fontMode]);

  const surfaceAttr = surface === "desk" ? undefined : surface;

  return (
    <TooltipProvider>
      <div
        data-surface={surfaceAttr}
        className="min-h-dvh bg-surface-page text-fg-primary pb-16"
      >
        <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
            <div className="flex items-center gap-3">
              <BrandMark size={34} />
              <div>
                <h1 className="text-title font-semibold text-fg-primary">组件陈列与版式样板</h1>
                <p className="text-caption text-fg-secondary">
                  中性占位样例 · 用于核对字体、主题色、表面模式与基础版式
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                aria-label="字体切换"
                size="sm"
                value={fontMode}
                onValueChange={setFontMode}
                options={[
                  { value: "bundled", label: "打包字体" },
                  { value: "system", label: "系统字体" },
                ]}
              />
              <SegmentedControl
                aria-label="表面切换"
                size="sm"
                value={surface}
                onValueChange={setSurface}
                options={[
                  { value: "desk", label: "书桌" },
                  { value: "stage", label: "舞台" },
                  { value: "paper", label: "纸面" },
                ]}
              />
            </div>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-10 px-6 pt-8">
          {/* Section 1: Comparison controls — Font specimen & 8 Tutor Themes */}
          <section className="grid gap-4" aria-labelledby="sec-compare">
            <h2 id="sec-compare" className="text-title font-semibold text-fg-primary">
              一、对比开关：八组主题色与字体对比
            </h2>
            <Card padding="md" className="grid gap-5">
              <div className="flex flex-wrap gap-2" role="group" aria-label="老师主题色">
                {TUTOR_THEME_IDS.map((id) => {
                  const palette = TUTOR_THEMES[id];
                  return (
                    <Chip
                      key={id}
                      selected={themeId === id}
                      showCheck
                      onClick={() => setThemeId(id)}
                      icon={
                        <span
                          aria-hidden="true"
                          className="inline-block h-3 w-3 rounded-full"
                          style={{ backgroundColor: palette.accent }}
                        />
                      }
                    >
                      {palette.label}
                    </Chip>
                  );
                })}
              </div>

              <div className="grid gap-4 md:grid-cols-3" data-testid="font-specimen">
                <div className="grid gap-1 rounded-md bg-surface-sunken p-4">
                  <span className="text-caption text-fg-tertiary">14px 正文与控件（text-ui）</span>
                  <p className="text-ui text-fg-primary">
                    这是一段常规长度的界面说明文字，用来核对中文与数字 1234567890 的清晰度、字重层级与行距呼吸感。
                  </p>
                </div>
                <div className="grid gap-1 rounded-md bg-surface-sunken p-4">
                  <span className="text-caption text-fg-tertiary">20px 分区标题（text-title · 600）</span>
                  <p className="text-title font-semibold text-fg-primary">
                    今天的学习安排与最近进展 08 / 12
                  </p>
                  <p className="text-caption text-fg-secondary">副标题与说明文字保持清晰层次</p>
                </div>
                <div
                  data-surface="stage"
                  className="grid gap-1 rounded-md bg-surface-page p-4 text-fg-primary"
                >
                  <span className="text-caption text-fg-tertiary">课堂字幕样板（16px · 500）</span>
                  <p className="text-body font-medium leading-relaxed text-fg-primary">
                    我们先看第一行的条件变化，再一起确认下一步怎么往下走。
                  </p>
                </div>
              </div>
            </Card>
          </section>

          {/* Section 2: All U1 Components & States */}
          <section className="grid gap-4" aria-labelledby="sec-components">
            <h2 id="sec-components" className="text-title font-semibold text-fg-primary">
              二、全部基础组件各状态
            </h2>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card padding="md" className="grid gap-4">
                <h3 className="text-ui font-semibold text-fg-secondary">按钮与图标按钮</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary">主按钮</Button>
                  <Button variant="secondary">次按钮</Button>
                  <Button variant="ghost">幽灵按钮</Button>
                  <Button variant="danger">危险操作</Button>
                  <Button
                    variant="primary"
                    pending={pendingDemo}
                    onClick={() => {
                      setPendingDemo(true);
                      window.setTimeout(() => setPendingDemo(false), 1200);
                    }}
                  >
                    进行中示例
                  </Button>
                  <Button variant="secondary" disabled>已禁用</Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" leftIcon={<Plus size={14} />}>小号</Button>
                  <Button size="md" rightIcon={<ArrowRight size={16} />}>中号</Button>
                  <Button size="lg">大号按钮</Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <IconButton aria-label="麦克风" variant="primary" size="xl" icon={<Mic size={22} />} />
                  <IconButton aria-label="播放" variant="secondary" size="lg" icon={<Play size={18} />} />
                  <IconButton aria-label="暂停" variant="secondary" size="md" active icon={<Pause size={18} />} />
                  <IconButton aria-label="音量" variant="ghost" size="md" icon={<Volume2 size={18} />} />
                  <IconButton aria-label="更多" variant="ghost" shape="square" size="sm" icon={<MoreHorizontal size={16} />} />
                  <Spinner size={20} />
                </div>
              </Card>

              <Card padding="md" className="grid gap-4">
                <h3 className="text-ui font-semibold text-fg-secondary">徽标、芯片、分段、开关与老师组件</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">默认</Badge>
                  <Badge tone="accent">主题</Badge>
                  <Badge tone="ok">完成</Badge>
                  <Badge tone="retry">再想想</Badge>
                  <Badge tone="warn">提醒</Badge>
                  <Badge tone="danger">异常</Badge>
                  <Badge tone="info">说明</Badge>
                  <DifficultyDots value={2} max={3} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip selected={chipSelected} showCheck onClick={() => setChipSelected((v) => !v)}>
                    选项 A
                  </Chip>
                  <Chip selected={!chipSelected} showCheck onClick={() => setChipSelected((v) => !v)}>
                    选项 B
                  </Chip>
                  <Chip disabled>不可选</Chip>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <SegmentedControl
                    aria-label="三档切换"
                    value={segmentValue}
                    onValueChange={setSegmentValue}
                    options={[
                      { value: "a", label: "选项一" },
                      { value: "b", label: "选项二" },
                      { value: "c", label: "选项三" },
                    ]}
                  />
                  <Switch checked={switchOn} onCheckedChange={setSwitchOn} label="即时生效开关" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <TutorAvatar name="雪川" size="sm" />
                  <TutorAvatar name="初棠" size="md" ring />
                  <TutorChip name="示例老师" subtitle="在线陪伴" interactive />
                </div>
              </Card>

              <Card padding="md" className="grid gap-4">
                <h3 className="text-ui font-semibold text-fg-secondary">表单与选择器</h3>
                <Field label="文本输入" description="一段字段说明文字">
                  <TextInput defaultValue="输入内容示例" />
                </Field>
                <Field label="带错误提示的字段" error="这里需要补充有效内容" required>
                  <TextInput defaultValue="" placeholder="请输入" />
                </Field>
                <Field label="下拉选择">
                  <Select
                    value={selectValue}
                    onValueChange={setSelectValue}
                    options={[
                      { value: "a", label: "选项 A", description: "简短说明" },
                      { value: "b", label: "选项 B", description: "另一条说明" },
                      { value: "c", label: "选项 C" },
                    ]}
                  />
                </Field>
                <Field label="多行文本">
                  <Textarea rows={2} defaultValue="一段用于核对多行输入间距与边框的占位文字。" />
                </Field>
              </Card>

              <Card padding="md" className="grid gap-4">
                <h3 className="text-ui font-semibold text-fg-secondary">浮层、对话框、通知与状态</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => setDialogOpen(true)}>打开对话框</Button>
                  <Button variant="danger" onClick={() => setConfirmOpen(true)}>打开确认框</Button>
                  <Menu
                    trigger={<Button variant="secondary">菜单</Button>}
                    items={[
                      { id: "m1", label: "常规动作", onSelect: () => toast.info("触发了常规动作") },
                      { id: "m2", label: "危险动作", danger: true, onSelect: () => toast.warning("触发了提醒") },
                    ]}
                  />
                  <Popover trigger={<Button variant="secondary">浮层</Button>} title="设置浮层" description="一段简短说明">
                    <Switch defaultChecked label="选项开关" />
                  </Popover>
                  <Tooltip content="这是一条悬停提示">
                    <Button variant="ghost">悬停提示</Button>
                  </Tooltip>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => toast.success("已保存更改")}>成功 Toast</Button>
                  <Button size="sm" onClick={() => toast.info("已更新列表", { action: { label: "撤销", onClick: () => {} } })}>带撤销 Toast</Button>
                  <Button size="sm" onClick={() => toast.error("暂时未能连接")}>错误 Toast</Button>
                </div>
                <div className="grid gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
                <ErrorState
                  title="暂时没有加载出来"
                  message="请确认本机服务正常运行后再试一次。"
                  error={new Error("HTTP 503 Service Unavailable")}
                  onRetry={() => toast.info("正在重新尝试")}
                />
              </Card>
            </div>
          </section>

          {/* Section 3: Layout Specimens */}
          <section className="grid gap-6" aria-labelledby="sec-specimens">
            <h2 id="sec-specimens" className="text-title font-semibold text-fg-primary">
              三、版式样板（后续所有页面的视觉基调）
            </h2>

            {/* Page header + teacher greeting bar */}
            <Card padding="md" className="grid gap-5">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line-subtle pb-4">
                <div className="grid gap-1">
                  <span className="text-caption font-medium text-accent-strong">页面眉标</span>
                  <h3 className="text-headline font-semibold text-fg-primary">页面主标题示例</h3>
                  <p className="text-ui text-fg-secondary">一句话说明这一页的主要任务，保持安静留白。</p>
                </div>
                <Button variant="primary" leftIcon={<Plus size={16} />}>主要动作</Button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-surface-sunken p-4">
                <div className="flex items-center gap-3">
                  <TutorAvatar name="雪川" size="lg" ring />
                  <div className="grid gap-0.5">
                    <p className="text-body font-medium text-fg-primary">
                      欢迎回来，今天我们先把重点内容过一遍。
                    </p>
                    <p className="text-caption text-fg-secondary">
                      带老师小窗的问候条样板 · 只有一个清晰下一步
                    </p>
                  </div>
                </div>
                <Button variant="primary" rightIcon={<ArrowRight size={16} />}>继续下一步</Button>
              </div>

              {/* Stat blocks */}
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ["24 分钟", "本周专注时长"],
                  ["8 / 12", "已完成条目"],
                  ["3 项", "待处理提醒"],
                ].map(([value, label]) => (
                  <div key={label} className="grid gap-1 rounded-md bg-surface-sunken p-4">
                    <strong className="text-headline font-semibold tabular-nums text-fg-primary">{value}</strong>
                    <span className="text-caption text-fg-secondary">{label}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Card grid */}
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { title: "卡片标题一", desc: "一段简短的说明文字，展示卡片内边距与阴影层次。", tag: "进行中", tone: "accent" as const },
                { title: "卡片标题二", desc: "另一张卡片的占位描述，强调明度与留白而非重线条。", tag: "已完成", tone: "ok" as const },
                { title: "卡片标题三", desc: "待确认状态的卡片样例，按钮统一右对齐或底部对齐。", tag: "待处理", tone: "warn" as const },
              ].map((card) => (
                <Card key={card.title} padding="md" interactive className="grid content-between gap-4">
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-title font-semibold text-fg-primary">{card.title}</h3>
                      <Badge tone={card.tone}>{card.tag}</Badge>
                    </div>
                    <p className="text-ui text-fg-secondary">{card.desc}</p>
                  </div>
                  <div className="flex items-center justify-between border-t border-line-subtle pt-3">
                    <span className="text-caption text-fg-tertiary tabular-nums">更新于今天</span>
                    <Button variant="ghost" size="sm" rightIcon={<ArrowRight size={14} />}>查看</Button>
                  </div>
                </Card>
              ))}
            </div>

            {/* List rows & Form section */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card padding="none" className="overflow-hidden">
                <div className="border-b border-line-subtle px-6 py-4">
                  <h3 className="text-title font-semibold text-fg-primary">列表行样板</h3>
                </div>
                <ul className="divide-y divide-line-subtle">
                  {[
                    { name: "条目一", meta: "15 分钟 · 常规项", icon: <BookOpen size={16} /> },
                    { name: "条目二", meta: "10 分钟 · 优先项", icon: <Settings size={16} /> },
                    { name: "条目三", meta: "20 分钟 · 待安排", icon: <BookOpen size={16} /> },
                  ].map((row) => (
                    <li key={row.name} className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-surface-sunken/60">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-accent-strong">{row.icon}</span>
                        <div className="grid min-w-0">
                          <span className="text-ui font-medium text-fg-primary truncate">{row.name}</span>
                          <span className="text-caption text-fg-secondary">{row.meta}</span>
                        </div>
                      </div>
                      <Button variant="secondary" size="sm">打开</Button>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card padding="md" className="grid gap-4">
                <div className="border-b border-line-subtle pb-3">
                  <h3 className="text-title font-semibold text-fg-primary">表单分区样板</h3>
                  <p className="text-caption text-fg-secondary">同一表单保持统一的显式保存或即时生效节奏。</p>
                </div>
                <Field label="显示名称">
                  <TextInput defaultValue="默认配置" />
                </Field>
                <Field label="补充说明">
                  <Textarea rows={2} defaultValue="一段说明文字" />
                </Field>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary">还原</Button>
                  <Button variant="primary" onClick={() => toast.success("已保存表单示例")}>保存</Button>
                </div>
              </Card>
            </div>

            {/* Empty state specimen */}
            <EmptyState
              visual={<TutorAvatar name="初棠" size="xl" ring />}
              title="这里还没有任何条目"
              description="这是一段空状态占位说明，只提供一个清晰的主动作。"
              action={<Button variant="primary" leftIcon={<Plus size={16} />}>新建第一项</Button>}
            />
          </section>
        </main>

        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="标准对话框示例"
          description="用于表单编辑或补充说明，关闭后焦点自动归还触发按钮。"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button variant="primary" onClick={() => { setDialogOpen(false); toast.success("已确认"); }}>确定</Button>
            </>
          }
        >
          <p className="text-ui text-fg-secondary">这是一段对话框内的占位说明文字。</p>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="删除这条示例记录？"
          description="删除后无法恢复。默认焦点在安全的保留按钮上。"
          confirmLabel="确认删除"
          cancelLabel="保留"
          onConfirm={() => {
            setConfirmOpen(false);
            toast.success("已删除示例记录");
          }}
        />

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
