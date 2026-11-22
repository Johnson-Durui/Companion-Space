import t from "../../locales/zh-CN.json";
import { Dialog, Kbd } from "../../ui";

const copy = t.classroom;

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SHORTCUT_ROWS: ReadonlyArray<{ keys: readonly string[]; sep?: string; label: string }> = [
  { keys: ["Space"], label: copy.shortcutSpace },
  { keys: ["Esc"], label: copy.shortcutEsc },
  { keys: ["Enter"], label: copy.shortcutEnter },
  { keys: ["A–H", "1–9"], sep: "/", label: copy.shortcutChoices },
  { keys: ["Shift", "C"], sep: "+", label: copy.shortcutCaption },
  { keys: ["Shift", "M"], sep: "+", label: copy.shortcutMute },
  { keys: ["Shift", "T"], sep: "+", label: copy.shortcutTranscript },
  { keys: ["?"], label: copy.shortcutHelp },
];

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.shortcutsTitle}
      description={copy.shortcutsHint}
      size="sm"
      closeLabel={copy.close}
    >
      <ul data-testid="shortcuts-list" className="m-0 grid list-none gap-2.5 p-0">
        {SHORTCUT_ROWS.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between gap-4 border-b border-line-subtle pb-2 last:border-b-0 last:pb-0"
          >
            <span className="text-ui text-fg-primary">{row.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {row.keys.map((key, idx) => (
                <span key={key} className="inline-flex items-center gap-1">
                  {idx > 0 ? <span className="text-caption text-fg-tertiary">{row.sep ?? "+"}</span> : null}
                  <Kbd>{key}</Kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
