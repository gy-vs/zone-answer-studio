import { useEffect, useState } from 'react';
import type { BootState, PublishedVersion, RR } from '@shared/types.js';
import { api } from '../api.js';
import { displayName, renderRdata } from '../components/display.js';

interface Props {
  boot: BootState;
  onQueryVersion: (name: string, qtype: string) => void;
}

export function VersionsTab({ boot, onQueryVersion }: Props) {
  const [versions, setVersions] = useState<PublishedVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.versions().then((vs) => {
      setVersions(vs);
      if (!selected && vs.length > 0) setSelected(vs[vs.length - 1]?.id ?? null);
    });
  }, [boot.published?.id, selected]);

  const current = versions.find((v) => v.id === selected) ?? null;
  const draft = boot.draft;

  const curMap = new Map<string, RR[]>();
  if (current) {
    for (const r of current.records) {
      const list = curMap.get(r.name) ?? [];
      list.push(r);
      curMap.set(r.name, list);
    }
  }
  const draftMap = new Map<string, RR[]>();
  for (const r of draft.records) {
    const list = draftMap.get(r.name) ?? [];
    list.push(r);
    draftMap.set(r.name, list);
  }

  const allNames = new Set([...curMap.keys(), ...draftMap.keys()]);
  const rows = [...allNames].sort().map((name) => {
    const oldList = curMap.get(name) ?? [];
    const newList = draftMap.get(name) ?? [];
    const sig = (list: RR[]) => list
      .map((r) => `${r.type}|${r.ttl}|${renderRdata(r.type, r.rdata)}`)
      .sort().join('||');
    return {
      name,
      oldList, newList,
      status: oldList.length === 0 ? 'added' : newList.length === 0 ? 'removed' : sig(oldList) === sig(newList) ? 'same' : 'changed',
    };
  });

  return (
    <div className="versions-tab">
      <section className="version-list-card">
        <h3>不可变的已发布版本</h3>
        <p className="muted">
          每次发布写入新版本与当时的完整记录；历史查询依据的是发布时冻结的数据，不会被当前草稿或后续版本倒灌。
        </p>
        <ul className="version-list">
          {versions.length === 0 && <li className="muted">还没有发布过版本。</li>}
          {versions.map((v) => (
            <li key={v.id} className={v.id === boot.published?.id ? 'latest' : ''}>
              <label>
                <input
                  type="radio"
                  name="ver"
                  checked={selected === v.id}
                  onChange={() => setSelected(v.id)}
                />
                <div>
                  <div className="ver-id">
                    {v.id}
                    {v.id === boot.published?.id && <span className="latest-tag">当前正式版本</span>}
                  </div>
                  <div className="ver-meta">
                    发布于 {v.publishedAt.slice(0, 19).replace('T', ' ')} · SOA serial {v.serial}
                    {v.note ? ` · ${v.note}` : ''} · {v.records.length} 条记录
                  </div>
                </div>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="version-diff-card">
        <h3>
          {current ? `版本 ${current.id}  → 当前草稿 (rev ${draft.revision})` : '当前草稿（尚无历史版本可对照）'}
        </h3>
        <table className="diff-table">
          <thead>
            <tr><th>状态</th><th>名字</th><th>所选版本记录</th><th>当前草稿记录</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className={`diff-${row.status}`}>
                <td>
                  <span className={`diff-status ${row.status}`}>
                    {row.status === 'same' ? '一致' : row.status === 'added' ? '新增' : row.status === 'removed' ? '删除' : '修改'}
                  </span>
                </td>
                <td className="diff-name">{displayName(row.name, boot.meta.zoneName)}</td>
                <td>{row.oldList.map((r) => (
                  <div key={r.id} className="diff-rr old">{r.ttl} {r.type} {renderRdata(r.type, r.rdata)}</div>
                ))}</td>
                <td>{row.newList.map((r) => (
                  <div key={r.id} className="diff-rr new">{r.ttl} {r.type} {renderRdata(r.type, r.rdata)}</div>
                ))}</td>
                <td>
                  <button className="small" onClick={() => onQueryVersion(row.name, 'A')}>查 A</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
