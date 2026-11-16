import { useState, type ReactNode } from "react";
import {
  RESEARCH_ROLE_LABELS,
  researchStages,
  type ResearchProject,
} from "../../../../contracts/research-group";
import type { ProcessSidebarGroup } from "../lancer-process/process-types";
import "./research-project-list.css";

type Session = ProcessSidebarGroup["sessions"][number];
const key = "lancer-research-collapsed-projects";
const statuses = {
  running: "协作中",
  paused: "已暂停",
  "needs-decision": "待决定",
  completed: "已完成",
};
export function ResearchProjectList({
  projects,
  sessions,
  renderSession,
  onSelect,
}: {
  readonly projects: readonly ResearchProject[];
  readonly sessions: readonly Session[];
  readonly renderSession: (session: Session, index: number, label?: string) => ReactNode;
  readonly onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  });
  const sessionKey = (ref: ResearchProject["root"]) => `${ref.workspaceId}:${ref.sessionId}`;
  const find = (ref: ResearchProject["root"]) => sessions.find((s) => s.id === sessionKey(ref));
  const visible = projects
    .filter((p) => p.members.some((m) => find(m.ref)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const assigned = new Set(
    visible.flatMap((p) =>
      [...p.members, ...(p.m3?.specialists ?? [])].map((m) => sessionKey(m.ref)),
    ),
  );
  const unassigned = sessions.filter((s) => !assigned.has(s.id));
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Browsing remains usable if preferences cannot be saved. */
      }
      return next;
    });
  return (
    <div className="research-project-list" aria-label="研究项目列表">
      {visible.map((p) => {
        const root = find(p.root),
          selected = [...p.members, ...(p.m3?.specialists ?? [])].some(
            (m) => find(m.ref)?.selected,
          );
        const title = root?.title || p.objective.slice(0, 60);
        const stage = researchStages({
          stages: p.stages,
          workflowVersion: p.workflowVersion,
          path: p.path,
        }).find((s) => s.id === p.currentStage)?.title;
        const open = !collapsed.includes(p.id);
        return (
          <section
            className="research-project"
            data-project-id={p.id}
            data-selected={selected}
            key={p.id}
          >
            <div className="research-project__heading">
              <button
                type="button"
                className="research-project__toggle"
                aria-label={`${open ? "折叠" : "展开"}研究项目 ${title}`}
                aria-expanded={open}
                onClick={() => toggle(p.id)}
              >
                {open ? "⌄" : "›"}
              </button>
              <button
                type="button"
                className="research-project__name"
                title={title}
                onClick={() =>
                  onSelect(root?.id ?? sessionKey(p.members.find((m) => find(m.ref))!.ref))
                }
              >
                <strong>{title}</strong>
                <small>
                  {statuses[p.status]}
                  {stage ? ` · ${stage}` : ""}
                </small>
              </button>
            </div>
            {open ? (
              <div className="research-project__sessions" aria-label={`${title}的成员对话`}>
                {p.members.map((m) => {
                  const session = find(m.ref);
                  return session
                    ? renderSession(
                        session,
                        sessions.indexOf(session),
                        m.role === "mentor" ? "导师 · 课题主线" : RESEARCH_ROLE_LABELS[m.role],
                      )
                    : null;
                })}
                {p.m3?.specialists?.map((s) => {
                  const session = find(s.ref);
                  return session
                    ? renderSession(session, sessions.indexOf(session), s.label)
                    : null;
                })}
              </div>
            ) : null}
          </section>
        );
      })}
      {unassigned.length ? (
        <section className="research-project__drafts" aria-label="尚未启动的课题">
          <small>尚未启动的课题</small>
          {unassigned.map((s) => renderSession(s, sessions.indexOf(s)))}
        </section>
      ) : null}
    </div>
  );
}
