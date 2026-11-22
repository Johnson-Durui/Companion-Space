import { Slider as BaseSlider } from "@base-ui/react/slider";
import clsx from "clsx";

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onValueChange: (value: number) => void;
  "aria-label": string;
  className?: string;
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  onValueChange,
  "aria-label": ariaLabel,
  className,
}: SliderProps) {
  return (
    <BaseSlider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => {
        const numeric = Array.isArray(next) ? next[0] : next;
        if (typeof numeric === "number" && Number.isFinite(numeric)) {
          onValueChange(numeric);
        }
      }}
      className={clsx("relative flex w-full touch-none select-none items-center py-2", className)}
    >
      <BaseSlider.Control className="relative flex w-full cursor-pointer items-center py-1">
        <BaseSlider.Track className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken border border-line-subtle">
          <BaseSlider.Indicator className="h-full rounded-full bg-accent" />
        </BaseSlider.Track>
        <BaseSlider.Thumb
          aria-label={ariaLabel}
          className={clsx(
            "block h-4 w-4 rounded-full border-2 border-accent bg-surface-card shadow-1",
            "transition-transform duration-fast ease-out hover:scale-110",
            "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
            "disabled:opacity-50",
          )}
        />
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
