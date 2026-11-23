import type { SVGProps } from "react";

export {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Award,
  BarChart3,
  BookOpen,
  Brain,
  Calendar,
  Captions,
  CaptionsOff,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Compass,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  Filter,
  Flag,
  Flame,
  FolderOpen,
  Gauge,
  GraduationCap,
  Hand,
  Headphones,
  Heart,
  HelpCircle,
  History,
  Home,
  Info,
  KeyRound,
  Keyboard,
  Layers,
  Lightbulb,
  Loader2,
  Lock,
  Maximize2,
  MessageSquareText,
  Mic,
  MicOff,
  Minimize2,
  Minus,
  Monitor,
  MoreHorizontal,
  MoreVertical,
  Orbit,
  Pause,
  Pencil,
  PhoneOff,
  PictureInPicture2,
  Pin,
  PinOff,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shield,
  SkipForward,
  SlidersHorizontal,
  Smartphone,
  Sparkle,
  Sparkles,
  Square,
  Star,
  Target,
  Trash2,
  TrendingUp,
  Unlock,
  Upload,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  Wand2,
  Wifi,
  WifiOff,
  X,
  XCircle,
  Zap,
} from "lucide-react";

export interface BrandMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export function BrandMark({ size = 36, className, ...props }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <rect width="36" height="36" rx="10" fill="var(--text-primary)" />
      <rect
        x="1"
        y="1"
        width="34"
        height="34"
        rx="9"
        stroke="var(--surface-card)"
        strokeOpacity="0.16"
      />
      <circle cx="26.5" cy="9.5" r="5.5" fill="var(--accent)" fillOpacity="0.32" />
      <path
        d="M17.2 7.5C17.75 12.95 21.95 17.15 27.4 17.7C21.95 18.25 17.75 22.45 17.2 27.9C16.65 22.45 12.45 18.25 7 17.7C12.45 17.15 16.65 12.95 17.2 7.5Z"
        fill="var(--surface-page)"
      />
      <circle cx="26.8" cy="9.4" r="2.1" fill="var(--accent-on-dark)" />
    </svg>
  );
}

export interface DifficultyDotsProps {
  value: number;
  max?: number;
  label?: string;
}

export function DifficultyDots({ value, max = 3, label }: DifficultyDotsProps) {
  const clamped = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span
      role="img"
      aria-label={label ?? `难度 ${clamped} / ${max}`}
      className="inline-flex items-center gap-1.5 align-middle"
    >
      {Array.from({ length: max }, (_, index) => {
        const filled = index < clamped;
        return (
          <span
            key={index}
            aria-hidden="true"
            className={
              filled
                ? "inline-block h-2.5 w-2.5 rounded-full bg-accent"
                : "inline-block h-2.5 w-2.5 rounded-full border border-line-control bg-transparent"
            }
          />
        );
      })}
    </span>
  );
}
