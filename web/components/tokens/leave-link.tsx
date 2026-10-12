"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { ArrowUpRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/** https only, no credentials; returns the URL and its bare host, or null. */
export function normalizeExternal(url: string | undefined): { href: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return { href: u.toString(), host: u.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/**
 * A link out of unzeen (token socials). No previews, no favicons, no referrer; a confirmation first,
 * because the other site learns this IP and, by timing, that someone looked at this token.
 */
export function LeaveLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const target = normalizeExternal(href);
  if (!target) return null;
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95">
          <AlertDialog.Title className="font-medium">You are leaving unzeen</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-pretty text-muted-foreground">
            <span className="font-mono text-foreground/90 break-all">{target.host}</span> is run by the token&apos;s creator, not
            by us. It will see your IP address. We send no referrer.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" className="rounded-full px-4">
                Stay
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button asChild className="rounded-full px-4">
                <a href={target.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
                  Open {target.host}
                  <ArrowUpRight size={14} weight="bold" aria-hidden />
                </a>
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
