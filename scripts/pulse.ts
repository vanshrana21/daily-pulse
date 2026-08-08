/**
 * daily-pulse — records one snapshot of my public GitHub footprint per day.
 *
 * Appends a row to data/stats.csv and regenerates README.md with a sparkline.
 * Run by .github/workflows/pulse.yml every morning.
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
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC) {
      totalCount
      nodes { name stargazerCount primaryLanguage { name } }
    }
    contributionsCollection {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
    }
  }
}`);

const u = data.user;
const c = u.contributionsCollection;
const stars = u.repositories.nodes.reduce(
  (n: number, r: any) => n + r.stargazerCount,
  0,
);

// Language mix across public repos
const langs = new Map<string, number>();
for (const r of u.repositories.nodes) {
  const l = r.primaryLanguage?.name;
  if (l) langs.set(l, (langs.get(l) ?? 0) + 1);
}

const today = new Date().toISOString().slice(0, 10);

const row = {
  date: today,
  contributions: c.contributionCalendar.totalContributions,
  commits: c.totalCommitContributions,
  prs: c.totalPullRequestContributions,
  issues: c.totalIssueContributions,
  repos: u.repositories.totalCount,
  stars,
  followers: u.followers.totalCount,
};

// ---- append to CSV (idempotent per day) -------------------------------------
const CSV = "data/stats.csv";
const header = Object.keys(row).join(",");
const line = Object.values(row).join(",");

const file = Bun.file(CSV);
let lines: string[] = (await file.exists())
  ? (await file.text()).trim().split("\n")
  : [header];

// replace today's row if the job runs twice, otherwise append
const idx = lines.findIndex((l) => l.startsWith(today + ","));
if (idx >= 0) lines[idx] = line;
else lines.push(line);

await Bun.write(CSV, lines.join("\n") + "\n");

// ---- sparkline over the recorded history ------------------------------------
const BARS = "▁▂▃▄▅▆▇█";
function spark(values: number[]): string {
  if (values.length < 2) return BARS[0].repeat(Math.max(values.length, 1));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => BARS[Math.round(((v - min) / span) * (BARS.length - 1))])
    .join("");
}

const history = lines.slice(1).map((l) => l.split(","));
const recent = history.slice(-30);
const contribSeries = recent.map((r) => Number(r[1]));
const starSeries = recent.map((r) => Number(r[6]));

const first = history[0]?.[0] ?? today;
const days = history.length;

// day-over-day delta
const delta =
  history.length > 1
    ? Number(history.at(-1)![1]) - Number(history.at(-2)![1])
    : 0;
const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;

const langRows = [...langs.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([name, n]) => `| \`${name}\` | ${n} |`)
  .join("\n");

const stamp = new Date().toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

const readme = `# 📈 daily-pulse

A small self-updating record of my public GitHub footprint. A [GitHub Action](.github/workflows/pulse.yml)
runs every morning, queries the GitHub GraphQL API, appends a row to
[\`data/stats.csv\`](data/stats.csv), and rewrites this page.

Nothing here is typed by hand — including the numbers below.

## Today

| Metric | Value |
|---|---|
| Contributions (rolling year) | **${row.contributions}** (${deltaStr} since yesterday) |
| Commits | ${row.commits} |
| Pull requests | ${row.prs} |
| Issues | ${row.issues} |
| Public repos | ${row.repos} |
| Stars earned | ${row.stars} |
| Followers | ${row.followers} |

## Trend

Contributions, last ${recent.length} recorded day${recent.length === 1 ? "" : "s"}:

\`\`\`
${spark(contribSeries)}
\`\`\`

Stars, same window:

\`\`\`
${spark(starSeries)}
\`\`\`

## Language mix

| Language | Repos |
|---|---|
${langRows || "| — | — |"}

## About the data

- **${days}** snapshot${days === 1 ? "" : "s"} recorded since \`${first}\`
- Source: GitHub GraphQL API, public data only
- Schema: \`${header}\`

<sub>Last run: ${stamp} IST</sub>
`;

await Bun.write("README.md", readme);

console.log(`✓ ${today}: ${row.contributions} contributions, ${row.stars} stars`);
