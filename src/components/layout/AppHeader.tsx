"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { getUserRole, ROLE_PERMISSIONS } from "@/lib/roles";
import { AlertSettingsPanel } from "@/components/alerts/AlertSettingsPanel";

interface TabDef {
  href: string;
  label: string;
  permission: keyof (typeof ROLE_PERMISSIONS)["owner"];
}

const TABS: TabDef[] = [
  { href: "/", label: "Dashboard", permission: "canViewDashboard" },
  { href: "/trends", label: "Trends", permission: "canViewTrends" },
  { href: "/analysis", label: "Analysis", permission: "canViewAnalysis" },
  { href: "/insights", label: "AI Insights", permission: "canViewInsights" },
];

interface AppHeaderProps {
  onBedsideClick?: () => void;
  statusIndicator?: React.ReactNode;
}

export function AppHeader({
  onBedsideClick,
  statusIndicator,
}: AppHeaderProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [patientName, setPatientName] = useState("ClearSugar");

  useEffect(() => {
    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { name?: string } | null) => {
        if (p?.name) setPatientName(p.name);
      })
      .catch(() => {});
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = getUserRole((session?.user as any)?.role);
  const perms = ROLE_PERMISSIONS[role];

  const visibleTabs = TABS.filter((tab) => perms[tab.permission]);

  return (
    <>
    <header className="sticky top-0 z-10 bg-[var(--background)]/80 backdrop-blur-xl border-b border-[var(--border)]">
      <div className="max-w-6xl mx-auto px-4">
        {/* Top row: logo + user + status */}
        <div className="h-12 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              ClearSugar
            </Link>
            <span className="text-sm text-[var(--text-secondary)] hidden sm:inline">
              {patientName}
            </span>
          </div>
          {/* Right cluster must fit a 390px viewport without wrapping or
              overflowing (it was the source of page-level horizontal scroll
              on phones): non-essential labels collapse below sm. */}
          <div className="flex items-center gap-1.5 sm:gap-3 text-xs text-[var(--text-secondary)] whitespace-nowrap shrink-0">
            {statusIndicator}
            {perms.canViewInsights && (
              <button
                onClick={() => setAlertsOpen(true)}
                className="px-2.5 py-1 rounded-full text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--foreground)] transition-colors"
                title="Alert settings"
                aria-label="Open alert settings"
              >
                🔔<span className="hidden sm:inline"> Alerts</span>
              </button>
            )}
            {onBedsideClick && (
              <button
                onClick={onBedsideClick}
                className="hidden sm:inline-block px-2.5 py-1 rounded-full text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--foreground)] transition-colors"
                title="Bedside / Movie mode"
              >
                Bedside
              </button>
            )}
            {session?.user && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline text-[11px]">
                  {session.user.name || session.user.email}
                </span>
                <span className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
                  {perms.label}
                </span>
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="px-2 py-1 rounded-full text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--foreground)] transition-colors"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Tab bar — filtered by role */}
        <div className="flex items-center gap-0.5 -mb-px overflow-x-auto scrollbar-none">
          {visibleTabs.map((tab) => {
            const isActive =
              tab.href === "/"
                ? pathname === "/"
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? "border-[var(--accent)] text-[var(--foreground)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:border-[var(--border-hover)]"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>
    </header>

    {/* Alert settings slide-over */}

    {alertsOpen && (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setAlertsOpen(false)}
        />
        {/* Panel */}
        <div className="fixed right-0 top-0 h-full w-80 max-w-full z-50 bg-[var(--background)] border-l border-[var(--border)] shadow-2xl flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
            <span className="text-sm font-semibold">Alert Settings</span>
            <button
              onClick={() => setAlertsOpen(false)}
              className="text-[var(--text-secondary)] hover:text-[var(--foreground)] transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <AlertSettingsPanel />
          </div>
        </div>
      </>
    )}
    </>
  );
}
