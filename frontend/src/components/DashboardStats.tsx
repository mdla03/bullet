"use client";

import { useEffect, useState } from "react";

export interface StatSpec {
  id: string;
  label: string;
  value: number | string;
  note?: string;
}

const STORE_KEY = "bullet:dashboard-hidden";

function readHidden(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** The stat grid, plus the settings panel that hides cards from it. Opened by
 *  the Settings item in the nav dropdown, which dispatches the event below.
 *  Preference is per-browser (localStorage): it changes what this viewer sees,
 *  never what the dashboard reports. */
export default function DashboardStats({ stats }: { stats: StatSpec[] }) {
  // null until mounted, so the server render and the first client render match.
  // Cards flash once before a hidden one disappears; cheaper than blanking the
  // whole grid on every load.
  const [hidden, setHidden] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setHidden(readHidden());
    const onOpen = () => setOpen(true);
    window.addEventListener("bullet:dashboard-settings", onOpen);
    return () => window.removeEventListener("bullet:dashboard-settings", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function toggle(id: string) {
    setHidden((current) => {
      const list = current ?? [];
      const next = list.includes(id)
        ? list.filter((x) => x !== id)
        : [...list, id];
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        // Private mode or a full quota: the toggle still applies this session.
      }
      return next;
    });
  }

  const isHidden = (id: string) => hidden?.includes(id) ?? false;
  const shown = stats.filter((s) => !isHidden(s.id));

  return (
    <>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {shown.map((s) => (
          <div key={s.id} className="rounded-2xl border border-fog bg-white p-4">
            <div className="text-2xl font-bold tracking-tight">
              {typeof s.value === "number" ? s.value.toLocaleString() : s.value}
            </div>
            <div className="mt-1 text-xs text-graphite">{s.label}</div>
            {s.note && (
              <div className="font-mono text-[10px] text-graphite">{s.note}</div>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <p className="col-span-full text-sm text-graphite">
            All metrics are hidden. Turn some back on in Settings.
          </p>
        )}
      </section>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard settings"
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-fog bg-white p-5"
          >
            <h2 className="text-sm font-medium">Settings</h2>
            <p className="mt-1 text-xs text-graphite">
              Choose which metrics this browser shows. Saved locally, not shared
              with other viewers.
            </p>
            <ul className="mt-4 space-y-1">
              {stats.map((s) => {
                const on = !isHidden(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      onClick={() => toggle(s.id)}
                      className="flex w-full items-center justify-between gap-4 rounded-xl px-2 py-2.5 text-left text-sm hover:bg-paper"
                    >
                      <span>{s.label}</span>
                      <span
                        aria-hidden
                        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                          on ? "bg-ink" : "bg-fog"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                            on ? "translate-x-[1.125rem]" : "translate-x-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              onClick={() => setOpen(false)}
              className="mt-5 w-full rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
