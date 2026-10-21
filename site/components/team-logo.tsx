'use client';

import { useState } from 'react';
import { teamLogo } from '@/lib/team-logos';

/** The visible team name lives outside this optional, decorative image. */
export function TeamLogo({ team }: { team: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const logo = teamLogo(team);
  if (!logo || failedSource === logo.src) return null;
  return (
    <img
      className={`team-logo${logo.lightSurface ? ' light-logo-surface' : ''}`}
      src={logo.src}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSource(logo.src)}
    />
  );
}
