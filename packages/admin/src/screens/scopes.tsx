import { FolderTreeIcon } from "lucide-react";
import { useMemo } from "react";
import { useResource } from "../lib/api";
import { cn } from "../lib/cn";
import { href } from "../lib/router";
import type { ScopeNode } from "../lib/types";
import { CodeBadge } from "../ui/badge";
import { LinkButton } from "../ui/button";
import { MicroLabel, Mono, PageHeader } from "../ui/primitives";
import { BlockSkeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/states";

interface ScopesResponse {
  scopes: ScopeNode[];
}

interface TreeNode {
  path: string;
  segment: string;
  kind: string | null;
  depth: number;
  own: number;
  /** Own count plus every descendant's, so a parent shows the subtree weight. */
  subtree: number;
  children: TreeNode[];
  /** True when this level exists only as a path segment of a real scope. */
  implied: boolean;
}

/**
 * Builds the tree from flat paths. Intermediate segments that are not
 * themselves registered scopes still get a node, because nearest-scope-wins
 * resolution walks the path, and hiding a rung would make the walk illegible.
 */
function buildTree(scopes: readonly ScopeNode[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();

  const ordered = [...scopes].sort((a, b) => a.path.localeCompare(b.path));

  for (const scope of ordered) {
    const segments = scope.path.split("/").filter((s) => s !== "");
    let prefix = "";
    let siblings = roots;
    let node: TreeNode | undefined;

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const existing = index.get(prefix);
      if (existing) {
        node = existing;
      } else {
        node = {
          path: prefix,
          segment,
          kind: null,
          depth: i,
          own: 0,
          subtree: 0,
          children: [],
          implied: true,
        };
        index.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }

    if (node) {
      node.kind = scope.kind;
      node.own = scope.assertions;
      node.implied = false;
    }
  }

  const total = (node: TreeNode): number => {
    node.subtree = node.own + node.children.reduce((sum, c) => sum + total(c), 0);
    return node.subtree;
  };
  for (const root of roots) total(root);

  return roots;
}

function flatten(nodes: readonly TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

export function ScopesScreen({ scopeRoot }: { scopeRoot: string }) {
  const result = useResource<ScopesResponse>("/admin/api/scopes");
  const tree = useMemo(() => buildTree(result.data?.scopes ?? []), [result.data]);
  const rows = useMemo(() => flatten(tree), [tree]);

  return (
    <>
      <PageHeader
        description="Resolution is nearest-scope-wins: a read walks from the asking scope up toward the root and takes the first live answer. Nothing assumes the org root is the top of the tree."
        title="Scopes"
      />

      {result.loading ? (
        <BlockSkeleton count={1} height="h-80" />
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load the scope tree"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          body={`No scope exists below ${scopeRoot} yet. Scopes appear as soon as something is asserted in them, or when a repo is linked with \`datum link\`.`}
          icon={FolderTreeIcon}
          title="No scopes yet"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border-[0.5px] border-[#E5E5E5] shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b-[0.5px] border-b-[#E5E5E5] bg-[#FAFAFA] px-5 py-3">
            <MicroLabel>Path</MicroLabel>
            <div className="flex items-center gap-8">
              <MicroLabel>Here</MicroLabel>
              <MicroLabel>Subtree</MicroLabel>
            </div>
          </div>
          <ul>
            {rows.map((node) => (
              <ScopeRow key={node.path} node={node} scopeRoot={scopeRoot} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ScopeRow({
  node,
  scopeRoot,
}: {
  node: TreeNode;
  scopeRoot: string;
}) {
  const isRoot = node.path === scopeRoot;

  return (
    <li
      className={cn(
        "group flex items-center justify-between gap-4 border-b-[0.5px] border-b-[#E5E5E5] px-5 py-2.5 transition-colors last:border-b-0 hover:bg-muted/50",
        isRoot && "bg-primary/[0.04]",
      )}
    >
      <div
        className="flex min-w-0 items-center gap-2"
        style={{ paddingLeft: `${node.depth * 1.25}rem` }}
      >
        {node.depth > 0 ? (
          <span
            aria-hidden
            className="h-4 w-3 shrink-0 rounded-bl-[3px] border-border border-b border-l"
          />
        ) : null}
        <Mono
          className={cn(
            "truncate",
            node.implied ? "text-muted-foreground" : "font-medium",
          )}
          title={node.path}
        >
          {node.segment}
        </Mono>
        {node.kind ? (
          <CodeBadge variant="outline">{node.kind}</CodeBadge>
        ) : (
          <span
            className="text-[11px] text-muted-foreground"
            title="A path segment on the way to a real scope. It holds no assertions of its own but a read still walks through it."
          >
            path only
          </span>
        )}
        {isRoot ? <CodeBadge variant="purple">root</CodeBadge> : null}
      </div>

      <div className="flex shrink-0 items-center gap-6">
        <div className="flex w-14 items-center justify-end gap-2">
          {node.own > 0 ? (
            <LinkButton
              className="datum-num px-1.5"
              href={href("/assertions", { scope: node.path })}
              size="sm"
              variant="ghost"
            >
              {node.own}
            </LinkButton>
          ) : (
            <span className="datum-num pr-1.5 text-muted-foreground text-sm">0</span>
          )}
        </div>
        <span className="datum-num w-14 text-right text-muted-foreground text-sm">
          {node.subtree}
        </span>
      </div>
    </li>
  );
}
