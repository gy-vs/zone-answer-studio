import { useMemo, useState } from "react";
import type { EditorCtx } from "../App";
import type { ResourceRecord } from "../types";

interface TreeNode {
  name: string;
  label: string;
  children: Map<string, TreeNode>;
  records: ResourceRecord[];
  isCut: boolean;
}

function buildTree(records: ResourceRecord[], origin: string): TreeNode {
  const root: TreeNode = {
    name: origin,
    label: "@",
    children: new Map(),
    records: [],
    isCut: false,
  };

  const cutNames = new Set(
    records
      .filter((r) => r.type === "NS" && r.name !== origin)
      .map((r) => r.name),
  );

  for (const r of records) {
    if (r.name === origin) {
      root.records.push(r);
      continue;
    }
    if (!r.name.endsWith("." + origin)) continue;
    const suffix = r.name.slice(0, -(origin.length + 1));
    const labels = suffix.split(".");
    let node = root;
    for (let i = labels.length - 1; i >= 0; i--) {
      const lab = labels[i];
      const childName =
        i === labels.length - 1
          ? `${lab}.${origin}`
          : `${lab}.${labels.slice(i + 1).join(".")}.${origin}`;
      let child = node.children.get(lab);
      if (!child) {
        child = {
          name: childName,
          label: lab,
          children: new Map(),
          records: [],
          isCut: cutNames.has(childName),
        };
        node.children.set(lab, child);
      }
      node = child;
    }
    node.records.push(r);
  }
  return root;
}

function sortTree(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    // 字母排序，通配放最后
    if (a.label === "*") return 1;
    if (b.label === "*") return -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

export function ZoneTree({
  ctx,
  selectedName,
  onSelect,
}: {
  ctx: EditorCtx;
  selectedName: string;
  onSelect: (n: string) => void;
}) {
  const root = useMemo(
    () => buildTree(ctx.draft.records, ctx.draft.origin),
    [ctx.draft.records, ctx.draft.origin],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (name: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // 默认展开全部
  const isCollapsed = (n: string) => collapsed.has(n);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const kids = sortTree(node);
    const hasKids = kids.length > 0;
    const isOpen = !isCollapsed(node.name);
    const types = [...new Set(node.records.map((r) => r.type))];
    return (
      <div key={node.name}>
        <div
          className={`tree-node ${selectedName === node.name ? "selected" : ""} ${
            node.isCut ? "delegated" : ""
          } ${node.label === "*" ? "wild" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => onSelect(node.name)}
        >
          <span
            className="tree-toggle"
            onClick={(e) => {
              if (hasKids) {
                e.stopPropagation();
                toggle(node.name);
              }
            }}
          >
            {hasKids ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span title={node.name}>
            {node.label === "*" ? "*.（通配）" : node.label}
            {node.name === ctx.draft.origin ? `  (${ctx.draft.origin})` : ""}
          </span>
          <span className="tree-rrtypes">
            {node.name === ctx.draft.origin && <span className="rrtype-chip soa">SOA</span>}
            {types.map((t) => (
              <span key={t} className={`rrtype-chip ${t === "NS" ? "ns" : ""} ${t === "CNAME" ? "cname" : ""}`}>
                {t}
              </span>
            ))}
          </span>
        </div>
        {hasKids && isOpen && (
          <div>{kids.map((k) => renderNode(k, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="panel">
      <header>
        <h2>区域树</h2>
      </header>
      <div className="body scroll">
        <div className="origin-box">
          <label>区域起点 ORIGIN</label>
          <div className="mono" style={{ fontSize: 13 }}>
            {ctx.draft.origin}.
          </div>
        </div>
        <div className="tree" style={{ marginTop: 8 }}>
          {renderNode(root, 0)}
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>
          紫色 = 委派切点（非起点 NS）；青色 = 通配节点。
          切点之下的名字在查询时按转介处理。
        </p>
      </div>
    </div>
  );
}
