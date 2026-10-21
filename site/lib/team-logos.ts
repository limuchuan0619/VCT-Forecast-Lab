// Only exact, verified identities belong here. Unknown teams keep their name.
import manifest from '../public/team-logos/manifest.json' with { type: 'json' };
export type VerifiedTeamLogo = {
  src: string;
  source: string;
  lightSurface: boolean;
};
const verified = new Map<string, VerifiedTeamLogo>();
for (const team of manifest.teams) {
  for (const name of [team.name, ...team.aliases]) {
    verified.set(name.trim().toLocaleLowerCase('en-US'), {
      src: team.src,
      source: team.source,
      // Its original black mark needs a neutral backing, not recoloring.
      lightSurface: team.id === 'vlr_team_2059',
    });
  }
}

export function teamLogo(name: string): VerifiedTeamLogo | null {
  return verified.get(name.trim().toLocaleLowerCase('en-US')) ?? null;
}
