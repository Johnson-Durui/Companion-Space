import {
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import clsx from "clsx";
import t from "../../locales/zh-CN.json";
import {
  Button,
  Captions,
  CaptionsOff,
  Hand,
  Headphones,
  Menu,
  MessageSquareText,
  Mic,
  MicOff,
  MoreHorizontal,
  Pause,
  PhoneOff,
  Popover,
  Select,
  Send,
  Slider,
  SlidersHorizontal,
  Switch,
  Volume1,
  Volume2,
  VolumeX,
} from "../../ui";

const copy = t.classroom;

export interface ControlDockProps {
  ready: boolean;
  audioMode: boolean;
  sttConfigured: boolean;
  recording: boolean;
  micLevel: number;
  handsFree: boolean;
  handsFreeLoading: boolean;
  canInterrupt: boolean;
  text: string;
  composerRef: RefObject<HTMLInputElement | null>;
  showCaption: boolean;
  transcriptOpen: boolean;
  volume: number;
  muted: boolean;
  soundCuesEnabled: boolean;
  soundCuesVolume: number;
  currentStyle: string;
  onTextChange: (next: string) => void;
  onSubmitText: (event: FormEvent) => void;
  onMicPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onMicPointerUp: () => void;
  onMicKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onToggleHandsFree: () => void;
  onInterrupt: () => void;
  onQuickAction: (kind: string) => void;
  onToggleCaption: () => void;
  onToggleTranscript: () => void;
  onVolumeChange: (next: number) => void;
  onToggleMute: () => void;
  onSoundCuesEnabledChange: (enabled: boolean) => void;
  onSoundCuesVolumeChange: (volume: number) => void;
  onStyleChange: (style: string) => void;
  onPause: () => void;
  onRequestEnd: () => void;
}

const STYLE_OPTIONS = Object.entries(copy.styles).map(([value, label]) => ({ value, label }));

export function ControlDock({
  ready,
  audioMode,
  sttConfigured,
  recording,
  micLevel,
  handsFree,
  handsFreeLoading,
  canInterrupt,
  text,
  composerRef,
  showCaption,
  transcriptOpen,
  volume,
  muted,
  soundCuesEnabled,
  soundCuesVolume,
  currentStyle,
  onTextChange,
  onSubmitText,
  onMicPointerDown,
  onMicPointerUp,
  onMicKey,
  onToggleHandsFree,
  onInterrupt,
  onQuickAction,
  onToggleCaption,
  onToggleTranscript,
  onVolumeChange,
  onToggleMute,
  onSoundCuesEnabledChange,
  onSoundCuesVolumeChange,
  onStyleChange,
  onPause,
  onRequestEnd,
}: ControlDockProps) {
  const [recentChip, setRecentChip] = useState<string | null>(null);
  const micEnabled = ready && sttConfigured;

  const fireQuick = (kind: string) => {
    onQuickAction(kind);
    setRecentChip(kind);
    window.setTimeout(() => {
      setRecentChip((prev) => (prev === kind ? null : prev));
    }, 1200);
  };

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  const moreItems = [
    { id: "confused", label: copy.quick.confused, onSelect: () => fireQuick("confused") },
    { id: "example", label: copy.quick.example, onSelect: () => fireQuick("example") },
    { id: "hint", label: copy.quick.hint, onSelect: () => fireQuick("hint") },
    { id: "show_answer", label: copy.quick.show_answer, onSelect: () => fireQuick("show_answer") },
    { id: "repeat", label: copy.quick.repeat, onSelect: () => fireQuick("repeat") },
    { id: "skip", label: copy.quick.skip, onSelect: () => fireQuick("skip") },
    { id: "break", label: copy.quick.break, onSelect: () => fireQuick("break") },
  ];

  const dockBtnBase =
    "min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-subtle bg-surface-card text-fg-primary text-caption font-medium transition-[background-color,border-color,color,transform] duration-fast ease-out hover:border-line-control hover:bg-surface-sunken active:not-disabled:scale-[0.97] disabled:opacity-45 disabled:cursor-not-allowed";

  return (
    <div className="flex h-full w-full items-center justify-between gap-2 overflow-x-clip">
      {/* Group 1: Speak (Mic, Hands-free, Fixed Interrupt) */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            disabled={!micEnabled || handsFree}
            data-testid="dock-mic-button"
            aria-label={recording ? copy.micListening : copy.holdToSpeak}
            aria-pressed={recording}
            title={!sttConfigured ? copy.configureMic : copy.holdToSpeak}
            data-recording={recording || undefined}
            style={{ "--mic-level": Math.min(1, Math.max(0, micLevel)) } as CSSProperties}
            onPointerDown={onMicPointerDown}
            onPointerUp={onMicPointerUp}
            onPointerCancel={onMicPointerUp}
            onKeyDown={onMicKey}
            onKeyUp={onMicKey}
            className={clsx(
              "relative inline-flex h-12 w-12 shrink-0 touch-none select-none items-center justify-center rounded-full border-2 sm:h-14 sm:w-14",
              "transition-[background-color,border-color,color,transform,box-shadow] duration-fast ease-out",
              "active:not-disabled:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45",
              recording
                ? "border-danger bg-danger text-on-accent shadow-[0_0_0_calc(4px+var(--mic-level,0)*10px)_rgb(179_38_30/0.35)]"
                : "border-accent bg-accent text-on-accent hover:border-accent-strong hover:bg-accent-strong",
            )}
          >
            {sttConfigured ? <Mic size={22} aria-hidden="true" /> : <MicOff size={22} aria-hidden="true" />}
          </button>

          {!sttConfigured ? (
            <a
              href="/settings#voice"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="dock-stt-hint"
              className="hidden min-h-11 min-w-11 flex-col items-start justify-center rounded-md px-2 leading-tight hover:bg-surface-sunken xl:inline-flex"
            >
              <span className="text-micro text-fg-secondary">{copy.configureMic}</span>
              <span className="text-micro font-medium text-accent-strong underline-offset-2 hover:underline">
                {copy.micEnable}
              </span>
            </a>
          ) : null}
        </div>

        <button
          type="button"
          disabled={!micEnabled}
          aria-pressed={handsFree}
          aria-busy={handsFreeLoading || undefined}
          title={!sttConfigured ? copy.configureMic : handsFree ? copy.handsFreeOn : copy.handsFree}
          onClick={onToggleHandsFree}
          className={clsx(
            dockBtnBase,
            "hidden px-3 sm:inline-flex",
            handsFree && "border-accent bg-accent-soft text-accent-strong",
          )}
        >
          <Headphones size={16} aria-hidden="true" />
          <span className="max-w-[112px] truncate">
            {handsFreeLoading ? copy.handsFreeLoading : handsFree ? copy.handsFreeOn : copy.handsFree}
          </span>
        </button>

        {/* Fixed-slot Interrupt button: never removed, disabled when idle */}
        <button
          type="button"
          disabled={!ready || !canInterrupt}
          aria-label={copy.interrupt}
          onClick={onInterrupt}
          className={clsx(dockBtnBase, "hidden px-3 sm:inline-flex")}
        >
          <Hand size={16} aria-hidden="true" />
          <span className="hidden md:inline">{copy.interrupt}</span>
        </button>
      </div>

      {/* Group 2: Write (Composer + inline quick chips + More menu) */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
        <form onSubmit={onSubmitText} className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            ref={composerRef}
            type="text"
            value={text}
            maxLength={4000}
            disabled={!ready}
            aria-label={copy.typeHere}
            placeholder={copy.typeHere}
            onChange={(event) => onTextChange(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-line-default bg-surface-card px-3 text-ui text-fg-primary placeholder:text-fg-tertiary focus:border-accent focus:outline-none disabled:opacity-50 md:min-w-[240px]"
          />
          <button
            type="submit"
            disabled={!ready || !text.trim()}
            aria-label={copy.send}
            className={clsx(
              "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-accent bg-accent px-3 text-ui font-medium text-on-accent",
              "transition-[background-color,transform] duration-fast ease-out hover:bg-accent-strong active:not-disabled:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45",
            )}
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </form>

        {/* Inline quick chips (collapsed via container query below 1180px) */}
        <button
          type="button"
          disabled={!ready}
          onClick={() => fireQuick("confused")}
          className={clsx(dockBtnBase, "cs-dock-chip-inline inline-flex px-3")}
        >
          <span>{recentChip === "confused" ? copy.sentTag : copy.quick.confused}</span>
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => fireQuick("example")}
          className={clsx(dockBtnBase, "cs-dock-chip-inline inline-flex px-3")}
        >
          <span>{recentChip === "example" ? copy.sentTag : copy.quick.example}</span>
        </button>

        {/* More quick actions menu */}
        <Menu
          trigger={
            <button
              type="button"
              disabled={!ready}
              aria-label={copy.moreActions}
              className={clsx(dockBtnBase, "inline-flex px-2.5")}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
              <span className="hidden xl:inline">{copy.more}</span>
            </button>
          }
          items={moreItems}
          align="end"
        />
      </div>

      {/* Group 3: Classroom controls (Caption, Volume, Settings, Transcript, Pause, End) */}
      <div className="flex shrink-0 items-center gap-1.5">
        {audioMode ? (
          <button
            type="button"
            aria-label={copy.toggleCaption}
            aria-pressed={showCaption}
            title={copy.toggleCaption}
            onClick={onToggleCaption}
            className={clsx(
              dockBtnBase,
              "hidden sm:inline-flex",
              showCaption && "border-accent text-accent-strong",
            )}
          >
            {showCaption ? <Captions size={18} aria-hidden="true" /> : <CaptionsOff size={18} aria-hidden="true" />}
          </button>
        ) : null}

        {audioMode ? (
          <Popover
            side="top"
            align="end"
            trigger={
              <button
                type="button"
                aria-label={copy.volume}
                title={copy.volume}
                className={clsx(dockBtnBase, "hidden sm:inline-flex")}
              >
                <VolumeIcon size={18} aria-hidden="true" />
              </button>
            }
            className="w-56"
          >
            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <span className="text-caption font-semibold text-fg-primary">{copy.volume}</span>
                <span className="text-caption tabular-nums text-fg-secondary">
                  {muted ? "0%" : `${Math.round(volume * 100)}%`}
                </span>
              </div>
              <Slider
                value={muted ? 0 : Math.round(volume * 100)}
                min={0}
                max={100}
                step={5}
                aria-label={copy.volume}
                onValueChange={(next) => {
                  if (muted && next > 0) onToggleMute();
                  onVolumeChange(next / 100);
                }}
              />
              <Button variant="secondary" size="sm" onClick={onToggleMute}>
                {muted ? copy.unmute : copy.mute}
              </Button>
            </div>
          </Popover>
        ) : null}

        <button
          type="button"
          data-testid="dock-transcript-toggle"
          aria-label={copy.transcriptTitle}
          aria-pressed={transcriptOpen}
          title={copy.transcriptTitle}
          onClick={onToggleTranscript}
          className={clsx(
            dockBtnBase,
            "cs-dock-transcript-inline inline-flex",
            transcriptOpen && "border-accent bg-accent-soft text-accent-strong",
          )}
        >
          <MessageSquareText size={18} aria-hidden="true" />
        </button>

        <Popover
          side="top"
          align="end"
          trigger={
            <button
              type="button"
              disabled={!ready}
              aria-label={copy.classroomSettings}
              title={copy.classroomSettings}
              className={clsx(dockBtnBase, "inline-flex")}
            >
              <SlidersHorizontal size={18} aria-hidden="true" />
            </button>
          }
          className="w-64"
        >
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <span className="text-caption font-semibold text-fg-primary">{copy.style}</span>
              <Select
                options={STYLE_OPTIONS}
                value={currentStyle}
                aria-label={copy.style}
                onValueChange={(next) => {
                  onStyleChange(next);
                  fireQuick(`style:${next}`);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-caption font-semibold text-fg-primary">{copy.paceControl}</span>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" onClick={() => fireQuick("slower")}>
                  {copy.quick.slower}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => fireQuick("faster")}>
                  {copy.quick.faster}
                </Button>
              </div>
            </div>
            <div className="grid gap-2 border-t border-line-subtle pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption font-semibold text-fg-primary">{copy.soundCues}</span>
                <Switch
                  checked={soundCuesEnabled}
                  aria-label={copy.soundCues}
                  onCheckedChange={onSoundCuesEnabledChange}
                />
              </div>
              {soundCuesEnabled ? (
                <div className="grid gap-1">
                  <div className="flex items-center justify-between text-micro text-fg-secondary">
                    <span>{copy.soundCueVolume}</span>
                    <span className="tabular-nums">{Math.round(soundCuesVolume * 100)}%</span>
                  </div>
                  <Slider
                    value={Math.round(soundCuesVolume * 100)}
                    min={5}
                    max={100}
                    step={5}
                    aria-label={copy.soundCueVolume}
                    onValueChange={(val) => onSoundCuesVolumeChange(val / 100)}
                  />
                </div>
              ) : null}
            </div>
            {/* Mobile quick access to transcript / pause / captions / end inside settings popover */}
            <div className="grid grid-cols-2 gap-2 border-t border-line-subtle pt-2 sm:hidden">
              <Button variant="secondary" size="sm" onClick={onToggleTranscript}>
                {copy.transcriptTitle}
              </Button>
              <Button variant="secondary" size="sm" onClick={onPause}>
                {copy.pause}
              </Button>
              {audioMode ? (
                <Button variant="secondary" size="sm" onClick={onToggleCaption}>
                  {copy.toggleCaption}
                </Button>
              ) : null}
              <Button variant="danger" size="sm" onClick={onRequestEnd}>
                {copy.end}
              </Button>
            </div>
            {!sttConfigured ? (
              <div className="flex items-center justify-between gap-2 border-t border-line-subtle pt-2">
                <span className="text-caption text-fg-secondary">{copy.configureMic}</span>
                <a
                  href="/settings#voice"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-caption font-medium text-accent-strong hover:underline"
                >
                  {copy.micEnable}
                </a>
              </div>
            ) : null}
          </div>
        </Popover>

        <button
          type="button"
          disabled={!ready}
          aria-label={copy.pause}
          title={copy.pause}
          onClick={onPause}
          className={clsx(dockBtnBase, "hidden sm:inline-flex")}
        >
          <Pause size={18} aria-hidden="true" />
        </button>

        <button
          type="button"
          disabled={!ready}
          aria-label={copy.end}
          title={copy.end}
          onClick={onRequestEnd}
          className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-danger/50 bg-danger-soft px-3 text-caption font-semibold text-danger-text transition-[background-color,border-color,transform] duration-fast ease-out hover:border-danger hover:bg-danger hover:text-on-accent active:not-disabled:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 sm:inline-flex"
        >
          <PhoneOff size={17} aria-hidden="true" />
          <span className="hidden lg:inline">{copy.end}</span>
        </button>
      </div>
    </div>
  );
}
