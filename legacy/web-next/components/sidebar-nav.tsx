"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type NavIconName = "spaces" | "study" | "review";

function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {name === "spaces" ? (
        <>
          <path {...common} d="M4 6.2h6.2l1.6 2H20v9.9a1.9 1.9 0 0 1-1.9 1.9H5.9A1.9 1.9 0 0 1 4 18.1Z" />
          <path {...common} d="M4 9h16" />
        </>
      ) : null}
      {name === "study" ? (
        <>
          <path {...common} d="M5.1 5.3h13.8a2.1 2.1 0 0 1 2.1 2.1v7.7a2.1 2.1 0 0 1-2.1 2.1H11l-4.7 3v-3H5.1A2.1 2.1 0 0 1 3 15.1V7.4a2.1 2.1 0 0 1 2.1-2.1Z" />
          <path {...common} d="M8 11.2h.1m3.8 0h.1m3.8 0h.1" />
        </>
      ) : null}
      {name === "review" ? (
        <>
          <path {...common} d="M7 4.5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" />
          <path {...common} d="M8.5 9h7M8.5 13h4.5" />
          <path {...common} d="m14.8 16.2 1.2 1.2 2.3-2.4" />
        </>
      ) : null}
    </svg>
  );
}

const desktopItems = [
  { href: "/spaces", label: "星轨书房", ariaLabel: "星轨书房", icon: "spaces" as const, paths: ["/", "/spaces", "/room", "/me", "/characters", "/providers", "/vault", "/settings", "/library"] },
  { href: "/study", label: "互动课堂", ariaLabel: "互动课堂", icon: "study" as const, paths: ["/study"] },
  { href: "/review-items", label: "记忆复盘", ariaLabel: "记忆复盘", icon: "review" as const, paths: ["/sessions", "/memory", "/review-items"] },
];

const utilityItems = [
  { href: "/characters", label: "导师工作室", ariaLabel: "角色工作室" },
  { href: "/providers", label: "声音与模型", ariaLabel: "模型中心" },
  { href: "/vault", label: "本地保险箱", ariaLabel: "安全内核" },
  { href: "/settings", label: "偏好与设置", ariaLabel: "设置" },
];

const mobileItems = desktopItems;

export function SidebarNav({ displayName }: { displayName: string }) {
  const rawPathname = usePathname();
  const pathname = rawPathname ?? "";
  const activeLinkRef = useRef<HTMLAnchorElement | null>(null);
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const brandMark = (
    words.length > 1
      ? words.slice(0, 2).map((word) => Array.from(word)[0]).join("")
      : Array.from(displayName).slice(0, 2).join("")
  ).toUpperCase();

  function isActive(href: string) {
    return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  }

  function isDesktopActive(item: (typeof desktopItems)[number]) {
    if (pathname.startsWith("/spaces/") && pathname.endsWith("/call")) return item.href === "/study";
    return item.paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  }

  const utilityActive = utilityItems.some((item) => isActive(item.href));

  useEffect(() => {
    if (!window.matchMedia("(max-width: 820px)").matches) {
      return;
    }
    activeLinkRef.current?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "center",
    });
  }, [pathname]);

  return (
    <nav className="panel nav-panel" aria-label="主要导航">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          {brandMark || "CS"}
        </div>
        <div>
          <p className="eyebrow">{displayName}</p>
          <strong className="brand-name">本地共学空间</strong>
        </div>
      </div>

      <div className="desktop-task-nav" aria-label="主要任务">
        {desktopItems.map((item) => {
          const active = isDesktopActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? "nav-link desktop-task-link active" : "nav-link desktop-task-link"}
              aria-current={active ? "page" : undefined}
              aria-label={item.ariaLabel}
            >
              <span className="nav-task-icon"><NavIcon name={item.icon} /></span>
              <strong>{item.label}</strong>
            </Link>
          );
        })}
      </div>

      <details className="desktop-utility-nav" open={utilityActive || undefined}>
        <summary>本地与服务设置</summary>
        <div className="desktop-utility-links">
          {utilityItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.ariaLabel}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </details>

      <div className="mobile-tab-bar" aria-label="移动端主导航">
        {mobileItems.map((item) => {
          const active = isDesktopActive(item);
          const href = item.href === "/study" && active && pathname.endsWith("/call")
            ? pathname
            : item.href;
          return (
            <Link
              key={`${item.label}-${item.href}`}
              href={href}
              className={active ? "mobile-tab active" : "mobile-tab"}
              data-primary={item.href === "/study" || undefined}
              aria-current={active ? "page" : undefined}
            >
              <span className="mobile-tab-icon"><NavIcon name={item.icon} /></span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="nav-footer">
        <strong>Local-first companion</strong>
        <p className="muted">凭据留在本地，学习记录按空间隔离。</p>
      </div>
    </nav>
  );
}
