/**
 * daily-pulse — records a snapshot of my public GitHub footprint each day.
 *
 * Writes several independent artifacts; the workflow commits each one
 * separately so every commit carries a real, self-contained diff:
 *
 *   data/stats.csv       rolling totals, one row per day
 *   data/repos.json      per-repo snapshot
 *   data/languages.csv   language mix over time
 *   data/stars.csv       per-repo star history
 *   data/streak.json     computed activity streak
 *   assets/trend.svg     sparkline rendered from stats.csv
 *   README.md            regenerated from all of the above
 */

const USER = "vanshrana21";
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

async function graphql(query: string) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const data = await graphql(`{
  user(login: "${USER}") {
    followers { totalCount }
    following { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name stargazerCount forkCount diskUsage pushedAt
        primaryLanguage { name }
        languages(first: 10) { edges { size node { name } } }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`);

const u = data.user;
const c = u.contributionsCollection;
const repos = u.repositories.nodes;
const today = new Date().toISOString().slice(0, 10);

const stars = repos.reduce((n: number, r: any) => n + r.stargazerCount, 0);
const forks = repos.reduce((n: number, r: any) => n + r.forkCount, 0);

// ---------- helpers ----------------------------------------------------------
async function readLines(path: string, header: string): Promise<string[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? (await f.text()).trim().split("\n") : [header];
}

/** Replace today's row if present, else append. Keeps the job idempotent. */
function upsert(lines: string[], date: string, row: string): string[] {
  const i = lines.findIndex((l) => l.startsWith(date + ","));
  if (i > 0) lines[i] = row;
  else lines.push(row);
  return lines;
}

// ---------- 1. data/stats.csv ------------------------------------------------
const statHeader =
  "date,contributions,commits,prs,issues,repos,stars,forks,followers";
const statRow = [
  today,
  c.contributionCalendar.totalContributions,
  c.totalCommitContributions,
  c.totalPullRequestContributions,
  c.totalIssueContributions,
  u.repositories.totalCount,
  stars,
  forks,
  u.followers.totalCount,
].join(",");

let statLines = upsert(await readLines("data/stats.csv", statHeader), today, statRow);
await Bun.write("data/stats.csv", statLines.join("\n") + "\n");

// ---------- 2. data/repos.json ----------------------------------------------
const repoSnapshot = {
  captured: today,
  count: repos.length,
  repos: repos
    .map((r: any) => ({
      name: r.name,
      stars: r.stargazerCount,
      forks: r.forkCount,
      language: r.primaryLanguage?.name ?? null,
      kb: r.diskUsage,
      pushed: r.pushedAt.slice(0, 10),
    }))
    .sort((a: any, b: any) => b.stars - a.stars || a.name.localeCompare(b.name)),
};
await Bun.write("data/repos.json", JSON.stringify(repoSnapshot, null, 2) + "\n");

// ---------- 3. data/languages.csv -------------------------------------------
const byteTotals = new Map<string, number>();
for (const r of repos) {
  for (const e of r.languages?.edges ?? []) {
    byteTotals.set(e.node.name, (byteTotals.get(e.node.name) ?? 0) + e.size);
  }
}
const langNames = [...byteTotals.keys()].sort();
const langHeader = "date," + langNames.join(",");
let langLines = await readLines("data/languages.csv", langHeader);
// header may grow as new languages appear
langLines[0] = langHeader;
langLines = upsert(
  langLines,
  today,
  [today, ...langNames.map((n) => byteTotals.get(n) ?? 0)].join(","),
);
await Bun.write("data/languages.csv", langLines.join("\n") + "\n");

// ---------- 4. data/stars.csv ------------------------------------------------
const repoNames = repos.map((r: any) => r.name).sort();
const starHeader = "date," + repoNames.join(",");
let starLines = await readLines("data/stars.csv", starHeader);
starLines[0] = starHeader;
starLines = upsert(
  starLines,
  today,
  [
    today,
    ...repoNames.map(
      (n: string) => repos.find((r: any) => r.name === n)?.stargazerCount ?? 0,
    ),
  ].join(","),
);
await Bun.write("data/stars.csv", starLines.join("\n") + "\n");

// ---------- 5. data/streak.json ---------------------------------------------
// NB: the API field is `contributionCount`, not `count` — reading the wrong
// one silently zeroes every stat below, since undefined is falsy.
const days: { date: string; count: number }[] =
  c.contributionCalendar.weeks.flatMap((w: any) =>
    w.contributionDays.map((d: any) => ({
      date: d.date,
      count: d.contributionCount,
    })),
  );

let current = 0;
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].date > today) continue; // ignore future padding
  if (days[i].count > 0) current++;
  // Today having 0 doesn't break the streak — the day isn't over yet.
  else if (days[i].date === today) continue;
  else break;
}
let longest = 0;
let run = 0;
for (const d of days) {
  if (d.count > 0) run++, (longest = Math.max(longest, run));
  else run = 0;
}
const active = days.filter((d) => d.count > 0).length;
const busiest = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);

await Bun.write(
  "data/streak.json",
  JSON.stringify(
    {
      captured: today,
      currentStreak: current,
      longestStreak: longest,
      activeDays: active,
      totalDays: days.length,
      busiestDay: { date: busiest.date, contributions: busiest.count },
    },
    null,
    2,
  ) + "\n",
);

// ---------- 6. assets/trend.svg ---------------------------------------------
const history = statLines.slice(1).map((l) => l.split(","));
const series = history.slice(-60).map((r) => Number(r[1]));

function sparkSvg(values: number[]): string {
  const W = 720,
    H = 120,
    P = 8;
  if (values.length < 2) values = [...values, ...values];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = P + (i / (values.length - 1)) * (W - 2 * P);
    const y = H - P - ((v - min) / span) * (H - 2 * P);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Contribution trend">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#39d353" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#39d353" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <polygon fill="url(#g)" points="${P},${H - P} ${pts.join(" ")} ${W - P},${H - P}"/>
  <polyline fill="none" stroke="#39d353" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/>
</svg>
`;
}
await Bun.write("assets/trend.svg", sparkSvg(series));

// ---------- 7. README.md -----------------------------------------------------
const BARS = "▁▂▃▄▅▆▇█";
function spark(values: number[]): string {
  if (values.length < 2) return BARS[0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => BARS[Math.round(((v - min) / span) * (BARS.length - 1))])
    .join("");
}

const delta =
  history.length > 1
    ? Number(history.at(-1)![1]) - Number(history.at(-2)![1])
    : 0;

const topLangs = [...byteTotals.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);
const langTotal = topLangs.reduce((n, [, v]) => n + v, 0) || 1;

const stamp = new Date().toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

await Bun.write(
  "README.md",
  `# 📈 daily-pulse

A self-updating record of my public GitHub footprint. A [scheduled Action](.github/workflows/pulse.yml)
runs each morning, queries the GitHub GraphQL API, and rewrites the data files below.
Every number on this page is generated — nothing is typed by hand.

![trend](assets/trend.svg)

## Today · ${today}

| Metric | Value |
|---|---|
| Contributions (rolling year) | **${statRow.split(",")[1]}** (${delta >= 0 ? "+" : ""}${delta} vs. previous snapshot) |
| Commits | ${c.totalCommitContributions} |
| Pull requests | ${c.totalPullRequestContributions} |
| Issues | ${c.totalIssueContributions} |
| Public repos | ${u.repositories.totalCount} |
| Stars earned | ${stars} |
| Forks | ${forks} |
| Followers | ${u.followers.totalCount} |

**Streak:** ${current} day${current === 1 ? "" : "s"} current · ${longest} longest · ${active}/${days.length} days active
**Busiest day:** ${busiest.date} (${busiest.count} contributions)

## Trend

Contributions across the last ${Math.min(history.length, 60)} snapshot${history.length === 1 ? "" : "s"}:

\`\`\`
${spark(series)}
\`\`\`

## Repositories

| Repo | ★ | Language | Last push |
|---|---|---|---|
${repoSnapshot.repos
  .map(
    (r: any) =>
      `| [${r.name}](https://github.com/${USER}/${r.name}) | ${r.stars} | ${r.language ?? "—"} | ${r.pushed} |`,
  )
  .join("\n")}

## Language mix

| Language | Share |
|---|---|
${topLangs
  .map(
    ([n, v]) =>
      `| \`${n}\` | ${((v / langTotal) * 100).toFixed(1)}% ${"█".repeat(Math.max(1, Math.round((v / langTotal) * 20)))} |`,
  )
  .join("\n")}

## Files

| Path | Contents |
|---|---|
| [\`data/stats.csv\`](data/stats.csv) | one row per day — totals |
| [\`data/repos.json\`](data/repos.json) | per-repo snapshot |
| [\`data/languages.csv\`](data/languages.csv) | language bytes over time |
| [\`data/stars.csv\`](data/stars.csv) | per-repo star history |
| [\`data/streak.json\`](data/streak.json) | computed streak stats |
| [\`assets/trend.svg\`](assets/trend.svg) | rendered sparkline |

<sub>Last run: ${stamp} IST · source: GitHub GraphQL API, public data only</sub>
`,
);

console.log(`✓ ${today}: ${statRow.split(",")[1]} contributions, ${stars} stars, streak ${current}`);
