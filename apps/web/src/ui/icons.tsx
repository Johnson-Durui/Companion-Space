import type { SVGProps } from "react";

export {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
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
  FolderOpen,
  Gauge,
  GraduationCap,
  Hand,
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
  Pause,
  Pencil,
  PhoneOff,
  Pin,
  PinOff,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  SkipForward,
  SlidersHorizontal,
  Smartphone,
  Sparkle,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
  XCircle,
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
      <rect width="36" height="36" rx="10" fill="#1B2126" />
      <path
        d="M18 7.5C18.55 13.1 22.9 17.45 28.5 18C22.9 18.55 18.55 22.9 18 28.5C17.45 22.9 13.1 18.55 7.5 18C13.1 17.45 17.45 13.1 18 7.5Z"
        fill="#F6F5F2"
      />
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
