"use client";

import { useState } from "react";
import type { HandleTypeId, ResolveCandidate } from "@zeekpay/shared";
import { OAUTH_ICON, displayHandle } from "@/lib/handle-ui";
import { ExternalLinkIcon } from "@/components/icons";

/** Provider photo when one is on file, else a plain initial. Never a fake
 *  placeholder image, so a missing photo just falls back to text. */
function Avatar({
  avatarUrl,
  initial,
  size,
}: {
  avatarUrl?: string | null;
  initial: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-fog font-bold text-graphite"
      style={{ width: size, height: size, fontSize: Math.round(size / 2.4) }}
    >
      {initial}
    </div>
  );
}

/** Confirmed-recipient header: avatar, name, and a type + handle line with a
 *  link to verify the person's public profile. Used both for a resolved
 *  recipient and for an unregistered GitHub login, which still has a real
 *  public avatar and profile to show. */
export function RecipientRow({
  name,
  type,
  handle,
  avatarUrl,
  profileUrl,
  onChange,
  changeDisabled,
}: {
  name: string;
  type?: string;
  handle: string;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  onChange?: () => void;
  changeDisabled?: boolean;
}) {
  const BrandIcon = type ? OAUTH_ICON[type as HandleTypeId] : undefined;
  const initial = name.replace(/^@/, "").charAt(0).toUpperCase() || "?";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-fog px-3 py-2.5">
      <Avatar avatarUrl={avatarUrl} initial={initial} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{name}</p>
        <div className="flex min-w-0 items-center gap-1 text-xs text-graphite">
          {BrandIcon && <BrandIcon className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{handle}</span>
          {profileUrl && (
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open public profile"
              className="shrink-0 text-graphite transition-colors hover:text-ink"
            >
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      {onChange && (
        <button
          onClick={onChange}
          disabled={changeDisabled}
          className="shrink-0 rounded-full border border-fog px-3 py-1.5 text-xs font-medium text-graphite transition-colors hover:border-graphite hover:text-ink disabled:opacity-50"
        >
          Change
        </button>
      )}
    </div>
  );
}

/** One row in the /resolve ambiguity picker: avatar, handle, and the
 *  platform's brand mark on the right (accessible name via sr-only text,
 *  since the icon alone is the only indicator of platform now). Same
 *  avatar/initial fallback as RecipientRow, at a smaller size for a list of
 *  several rows. */
export function CandidateRow({
  candidate,
  onSelect,
  disabled,
}: {
  candidate: ResolveCandidate;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const BrandIcon = OAUTH_ICON[candidate.type as HandleTypeId];
  const label = displayHandle(candidate.type, candidate.handle);
  const initial = label.replace(/^@/, "").charAt(0).toUpperCase() || "?";

  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-full border border-fog bg-white px-3 py-2 text-sm transition-colors hover:border-graphite disabled:opacity-50"
    >
      <Avatar avatarUrl={candidate.avatarUrl} initial={initial} size={32} />
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {label}
      </span>
      {BrandIcon && (
        <span className="shrink-0 text-graphite">
          <BrandIcon className="h-4 w-4" />
          <span className="sr-only">{candidate.label}</span>
        </span>
      )}
    </button>
  );
}
