import clsx from "clsx";

export type TutorAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface TutorAvatarProps {
  src?: string | null;
  name: string;
  size?: TutorAvatarSize;
  ring?: boolean;
  still?: string;
  className?: string;
}

const SIZE_CLASSES: Record<TutorAvatarSize, string> = {
  xs: "h-6 w-6 text-caption",
  sm: "h-8 w-8 text-caption",
  md: "h-10 w-10 text-ui",
  lg: "h-14 w-14 text-title",
  xl: "h-20 w-20 text-headline",
};

export function TutorAvatar({
  src,
  name,
  size = "md",
  ring = false,
  still,
  className,
}: TutorAvatarProps) {
  const initial = name.trim().slice(0, 1) || "师";

  return (
    <span
      data-still={still}
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft font-semibold text-accent-strong select-none",
        ring && "ring-2 ring-accent ring-offset-2 ring-offset-surface-card",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          decoding="async"
          loading="lazy"
          className="h-full w-full object-cover object-[50%_22%]"
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}
