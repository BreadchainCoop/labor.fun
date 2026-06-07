/**
 * GitHub Projects V2 GraphQL client + result normalization.
 *
 * Pulls every project (board) in an org and every item inside each project,
 * then flattens the polymorphic `fieldValues` payload into a flat object
 * keyed by field name. The normalized shape is what the sync engine writes
 * out as KB markdown frontmatter.
 *
 * Scope: requires the configured PAT to have `read:project` (fine-grained:
 * "Projects: Read"). Auth uses the same `GITHUB_PERSONAL_ACCESS_TOKEN`
 * that the bundled github-mcp-server already uses.
 *
 * Pagination: Phase 1 takes the first page of projects (20) and the first
 * page of items per project (100). Multi-page support is a TODO once a
 * deployment actually hits those limits.
 */

import { GITHUB_SYNC_ISSUE_DEPS } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const GH_API = 'https://api.github.com/graphql';

const envCache = readEnvFile(['GITHUB_PERSONAL_ACCESS_TOKEN']);

export function getGitHubToken(): string | null {
  return (
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    envCache.GITHUB_PERSONAL_ACCESS_TOKEN ||
    null
  );
}

/** Flat, write-ready representation of one ProjectV2 item. */
export interface NormalizedProjectItem {
  /** Stable composite key, also used as the KB filename stem. */
  id: string;
  itemType: 'Issue' | 'PullRequest' | 'DraftIssue';
  title: string;
  body: string;
  url: string | null;
  org: string;
  projectNumber: number;
  projectTitle: string;
  repoNameWithOwner: string | null;
  issueNumber: number | null;
  state: string | null;
  assignees: string[];
  labels: string[];
  status: string | null;
  priority: string | null;
  iteration: string | null;
  iterationStartDate: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string | null;
  closedAt: string | null;
  /** All custom field values keyed by field name (for future use). */
  extraFields: Record<string, string | number>;
  /** Dependency edges — issues that block this one (KB ids). → `upstream`. */
  blockedBy: string[];
  /** Dependency edges — issues this one blocks (KB ids). → `downstream`. */
  blocks: string[];
  /** Parent issue KB id (sub-issue hierarchy), or null. */
  parent: string | null;
  /** Child issue KB ids (sub-issue hierarchy). */
  subIssues: string[];
  /** Numeric estimate / story points, surfaced from extraFields. */
  estimate: number | null;
}

/** Project board metadata, written as `context/projects/GHP-<org>-<n>.md`. */
export interface NormalizedProject {
  id: string;
  org: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  readme: string;
  updatedAt: string;
}

/** What a single sync run returns. */
export interface OrgSyncResult {
  org: string;
  projects: NormalizedProject[];
  items: NormalizedProjectItem[];
}

interface GraphQLError {
  message: string;
  type?: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export class GitHubProjectsError extends Error {
  constructor(
    message: string,
    public readonly graphqlErrors?: GraphQLError[],
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubProjectsError';
  }
}

// Issue dependency + sub-issue edges (issue #31). `blockedBy`/`blocking` are GA
// in GitHub's GraphQL; `subIssues`/`parent` need the `GraphQL-Features: sub_issues`
// request header. Interpolated so we can drop them for the degrade path on
// instances (older GHES) that lack the fields.
const ISSUE_EDGES_FRAGMENT = `
                parent { number repository { nameWithOwner } }
                subIssues(first: 20) {
                  totalCount
                  nodes { number repository { nameWithOwner } }
                }
                blockedBy(first: 20) {
                  totalCount
                  nodes { number repository { nameWithOwner } }
                }
                blocking(first: 20) {
                  totalCount
                  nodes { number repository { nameWithOwner } }
                }`;

const buildProjectsQuery = (includeEdges: boolean): string => `
query OrgProjects($org: String!) {
  organization(login: $org) {
    projectsV2(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id
        number
        title
        url
        closed
        readme
        updatedAt
        items(first: 100) {
          nodes {
            id
            type
            content {
              __typename
              ... on Issue {
                number
                title
                url
                state
                body
                createdAt
                closedAt
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }${includeEdges ? ISSUE_EDGES_FRAGMENT : ''}
              }
              ... on PullRequest {
                number
                title
                url
                state
                body
                createdAt
                closedAt
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }
              }
              ... on DraftIssue {
                title
                body
                createdAt
                assignees(first: 10) { nodes { login } }
              }
            }
            fieldValues(first: 30) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  startDate
                  duration
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const PROJECTS_QUERY = buildProjectsQuery(true);
const PROJECTS_QUERY_NO_DEPS = buildProjectsQuery(false);

interface RawFieldValue {
  __typename: string;
  name?: string;
  text?: string;
  number?: number;
  date?: string;
  title?: string;
  startDate?: string;
  duration?: number;
  field?: { name?: string };
}

interface RawIssueRef {
  number?: number;
  repository?: { nameWithOwner?: string };
}

interface RawContent {
  __typename?: 'Issue' | 'PullRequest' | 'DraftIssue';
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  body?: string;
  createdAt?: string;
  closedAt?: string;
  repository?: { nameWithOwner: string };
  assignees?: { nodes: Array<{ login: string }> };
  labels?: { nodes: Array<{ name: string }> };
  parent?: RawIssueRef | null;
  subIssues?: { totalCount?: number; nodes: RawIssueRef[] };
  blockedBy?: { totalCount?: number; nodes: RawIssueRef[] };
  blocking?: { totalCount?: number; nodes: RawIssueRef[] };
}

interface RawItem {
  id: string;
  type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED';
  content: RawContent | null;
  fieldValues: { nodes: RawFieldValue[] };
}

interface RawProject {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  readme: string | null;
  updatedAt: string;
  items: { nodes: RawItem[] };
}

interface RawData {
  organization: { projectsV2: { nodes: RawProject[] } } | null;
}

/** Slug a string into something safe for an ID/filename. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the KB ID for a project item. Issues/PRs get a stable
 * `GH-<org>-<repo>-<number>` key; draft items get
 * `GHD-<org>-<project>-<itemNodeId>` so they're disambiguated from issues.
 */
function itemId(
  org: string,
  projectNumber: number,
  itemNodeId: string,
  content: RawContent | null,
): string {
  if (
    content?.__typename === 'Issue' ||
    content?.__typename === 'PullRequest'
  ) {
    const repo = content.repository?.nameWithOwner.split('/')[1] ?? 'unknown';
    return `GH-${slug(org)}-${slug(repo)}-${content.number}`;
  }
  // DraftIssue or REDACTED (private repo we can't see) — use the project +
  // raw node id (last segment) so the file is stable across syncs.
  const tail = itemNodeId.split('_').pop() || itemNodeId;
  return `GHD-${slug(org)}-${projectNumber}-${slug(tail)}`;
}

/**
 * Build the KB id for a *referenced* issue (a dependency / sub-issue edge),
 * which only carries `number` + `repository.nameWithOwner`. Uses the TARGET's
 * own owner/repo so the id matches that issue's own synced file (cross-repo /
 * cross-org edges line up). Returns null when the target repo is unreadable
 * (private/redacted) — we have no context to disambiguate, so we drop it.
 */
function issueRefId(ref: RawIssueRef | null | undefined): string | null {
  if (!ref || ref.number == null) return null;
  const owner = ref.repository?.nameWithOwner;
  if (!owner || !owner.includes('/')) return null;
  const [targetOrg, repo] = owner.split('/');
  return `GH-${slug(targetOrg)}-${slug(repo)}-${ref.number}`;
}

/** Map an edge connection to deduped KB ids, dropping self-references. */
function edgeIds(
  selfId: string,
  conn: { nodes: RawIssueRef[] } | undefined,
): string[] {
  const ids = (conn?.nodes ?? [])
    .map(issueRefId)
    .filter((x): x is string => !!x && x !== selfId);
  return [...new Set(ids)];
}

const ESTIMATE_FIELD_NAMES = [
  'estimate',
  'story points',
  'points',
  'sp',
  'size',
];

/** Pick a numeric estimate from the captured custom fields (case-insensitive). */
function pickEstimate(extra: Record<string, string | number>): number | null {
  for (const [k, v] of Object.entries(extra)) {
    if (
      typeof v === 'number' &&
      ESTIMATE_FIELD_NAMES.includes(k.toLowerCase())
    ) {
      return v;
    }
  }
  return null;
}

interface FlattenedFields {
  extraFields: Record<string, string | number>;
  status: string | null;
  priority: string | null;
  iteration: string | null;
  iterationStartDate: string | null;
  startDate: string | null;
  endDate: string | null;
}

function flattenFieldValues(values: RawFieldValue[]): FlattenedFields {
  const extra: Record<string, string | number> = {};
  let status: string | null = null;
  let priority: string | null = null;
  let iteration: string | null = null;
  let iterationStartDate: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;

  for (const v of values) {
    const name = v.field?.name;
    if (!name) continue;
    const lower = name.toLowerCase();
    switch (v.__typename) {
      case 'ProjectV2ItemFieldSingleSelectValue': {
        const val = v.name ?? null;
        if (val != null) extra[name] = val;
        if (lower === 'status') status = val;
        if (lower === 'priority') priority = val;
        break;
      }
      case 'ProjectV2ItemFieldTextValue':
        if (v.text != null) extra[name] = v.text;
        break;
      case 'ProjectV2ItemFieldNumberValue':
        if (v.number != null) extra[name] = v.number;
        break;
      case 'ProjectV2ItemFieldDateValue': {
        const val = v.date ?? null;
        if (val != null) extra[name] = val;
        if (lower === 'start date' || lower === 'start') startDate = val;
        if (
          lower === 'end date' ||
          lower === 'target date' ||
          lower === 'due date'
        )
          endDate = val;
        break;
      }
      case 'ProjectV2ItemFieldIterationValue': {
        if (v.title != null) extra[name] = v.title;
        if (lower.includes('iteration') || lower.includes('sprint')) {
          iteration = v.title ?? null;
          iterationStartDate = v.startDate ?? null;
          // Use the iteration window for start/end when not set explicitly.
          if (!startDate && v.startDate) startDate = v.startDate;
          if (!endDate && v.startDate && v.duration) {
            const start = new Date(v.startDate);
            start.setUTCDate(start.getUTCDate() + v.duration);
            endDate = start.toISOString().slice(0, 10);
          }
        }
        break;
      }
    }
  }

  return {
    extraFields: extra,
    status,
    priority,
    iteration,
    iterationStartDate,
    startDate,
    endDate,
  };
}

export function normalizeProject(
  org: string,
  raw: RawProject,
): NormalizedProject {
  return {
    id: `GHP-${slug(org)}-${raw.number}`,
    org,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    closed: raw.closed,
    readme: raw.readme ?? '',
    updatedAt: raw.updatedAt,
  };
}

export function normalizeItem(
  org: string,
  project: RawProject,
  raw: RawItem,
): NormalizedProjectItem | null {
  if (raw.type === 'REDACTED') return null;
  const content = raw.content ?? null;
  const id = itemId(org, project.number, raw.id, content);
  const {
    extraFields,
    status,
    priority,
    iteration,
    iterationStartDate,
    startDate,
    endDate,
  } = flattenFieldValues(raw.fieldValues.nodes);
  const itemType: NormalizedProjectItem['itemType'] =
    content?.__typename === 'PullRequest'
      ? 'PullRequest'
      : content?.__typename === 'DraftIssue'
        ? 'DraftIssue'
        : 'Issue';

  // Status fallback: if the project has no Status field on this item,
  // derive a coarse one from the underlying issue/PR state.
  const fallbackStatus =
    status ??
    (content?.state === 'CLOSED' || content?.state === 'MERGED'
      ? 'closed'
      : content?.state === 'OPEN'
        ? 'open'
        : null);

  return {
    id,
    itemType,
    title: content?.title ?? '(untitled item)',
    body: content?.body ?? '',
    url: content?.url ?? null,
    org,
    projectNumber: project.number,
    projectTitle: project.title,
    repoNameWithOwner: content?.repository?.nameWithOwner ?? null,
    issueNumber: content?.number ?? null,
    state: content?.state ?? null,
    assignees: content?.assignees?.nodes.map((n) => n.login) ?? [],
    labels: content?.labels?.nodes.map((n) => n.name) ?? [],
    status: fallbackStatus,
    priority,
    iteration,
    iterationStartDate,
    startDate,
    endDate,
    createdAt: content?.createdAt ?? null,
    closedAt: content?.closedAt ?? null,
    extraFields,
    blockedBy: edgeIds(id, content?.blockedBy),
    blocks: edgeIds(id, content?.blocking),
    parent: issueRefId(content?.parent),
    subIssues: edgeIds(id, content?.subIssues),
    estimate: pickEstimate(extraFields),
  };
}

/** Run the projects query once; returns parsed data or throws on HTTP/GraphQL error. */
async function runProjectsQuery(
  org: string,
  token: string,
  query: string,
  withEdges: boolean,
  fetchImpl: typeof fetch,
): Promise<RawData> {
  const res = await fetchImpl(GH_API, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'breadbrich-engels-project-sync',
      // sub-issue fields require this opt-in header (harmless once GA).
      ...(withEdges ? { 'GraphQL-Features': 'sub_issues' } : {}),
    },
    body: JSON.stringify({ query, variables: { org } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GitHubProjectsError(
      `GitHub GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`,
      undefined,
      res.status,
    );
  }
  const json = (await res.json()) as GraphQLResponse<RawData>;
  if (json.errors && json.errors.length > 0) {
    throw new GitHubProjectsError(
      `GitHub GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`,
      json.errors,
    );
  }
  return json.data as RawData;
}

/** True when a GraphQL error looks like the instance lacks the edge fields. */
function isEdgeFieldError(err: unknown): boolean {
  if (!(err instanceof GitHubProjectsError) || !err.graphqlErrors) return false;
  return err.graphqlErrors.some((e) =>
    /blockedBy|blocking|subIssues|parent|sub_issues/i.test(e.message),
  );
}

export async function fetchOrgProjects(
  org: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  includeEdges: boolean = GITHUB_SYNC_ISSUE_DEPS,
): Promise<OrgSyncResult> {
  let data: RawData;
  if (includeEdges) {
    try {
      data = await runProjectsQuery(
        org,
        token,
        PROJECTS_QUERY,
        true,
        fetchImpl,
      );
    } catch (err) {
      if (!isEdgeFieldError(err)) throw err;
      // Instance lacks issue dependency / sub-issue fields — degrade gracefully.
      logger.warn(
        { org },
        'GH sync: issue dependency/sub-issue fields unavailable, retrying without edges',
      );
      data = await runProjectsQuery(
        org,
        token,
        PROJECTS_QUERY_NO_DEPS,
        false,
        fetchImpl,
      );
    }
  } else {
    data = await runProjectsQuery(
      org,
      token,
      PROJECTS_QUERY_NO_DEPS,
      false,
      fetchImpl,
    );
  }
  const raw = data?.organization?.projectsV2.nodes ?? [];
  const projects: NormalizedProject[] = [];
  const items: NormalizedProjectItem[] = [];
  for (const rp of raw) {
    projects.push(normalizeProject(org, rp));
    for (const ri of rp.items.nodes) {
      const norm = normalizeItem(org, rp, ri);
      if (norm) items.push(norm);
    }
  }
  return { org, projects, items };
}
