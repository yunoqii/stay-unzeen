"use client";

import { useState } from "react";

/** Owner illustration for empty states; disappears if the file is missing (the silhouette stays). */
export function EmptyArt() {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local 960x480 webp
    <img
      src="/illustrations/empty.webp"
      alt=""
      aria-hidden
      width={960}
      height={480}
      onError={() => setOk(false)}
      className="relative mb-2 h-auto w-full max-w-[240px] opacity-70"
    />
  );
}
