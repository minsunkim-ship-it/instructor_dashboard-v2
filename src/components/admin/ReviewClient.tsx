"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface InstructorSummary {
  id: string;
  name: string;
  contactEmail: string | null;
  contactPhone?: string | null;
  satisfactionAvg?: number | null;
  satisfactionCount?: number;
  totalCourses?: number;
  affiliation?: string | null;
}

interface PendingRow {
  id: string;
  registryKey: string;
  sourceType: string;
  company: string | null;
  course: string | null;
  candidate: string | null;
  avgScore: number | null;
  responseCount: number;
  responseDate: string | null;
  sessionLabel: string | null;
  sourceKey: string | null;
  fileName: string | null;
  sheetTitle: string | null;
  subject: string | null;
  resolutionBasis: string | null;
  resolutionLevel: string | null;
  suggestion: InstructorSummary | null;
  resolvedCandidates: InstructorSummary[];
  sourceRefs: unknown;
  createdAt: string;
  reason: { code: string; label: string; severity: "blocker" | "review" | "info" };
}

interface ReasonStat {
  code: string;
  label: string;
  severity: string;
  count: number;
}

interface ListResponse {
  ok: boolean;
  total?: number;
  offset?: number;
  limit?: number;
  rows?: PendingRow[];
  reason_distribution?: ReasonStat[];
  error?: string;
}

// v22 C: 신뢰도 낮은 record (score≤2.5 + n≤2)
interface SuspectRecord {
  record_id: string;
  matched_instructor: string | null;
  matched_instructor_id: string;
  score: number;
  respondent_count: number;
  company: string | null;
  course: string | null;
  response_date: string | null;
  source_type: string;
  th_candidates: Array<{
    instructor_id: string;
    instructor_name: string;
    company: string | null;
    course: string | null;
    start: string | null;
    end: string | null;
    days_from_response: number | null;
  }>;
  instructor_in_candidates: boolean;
  suggested_alternative: { instructor_id: string; instructor_name: string } | null;
}
interface SuspectResponse {
  ok: boolean;
  total?: number;
  records?: SuspectRecord[];
  error?: string;
}

// v24-13: th_record_gap 큰 강사 (매칭 누락 의심)
interface InstructorGap {
  instructor_id: string;
  instructor_name: string;
  record_count: number;
  avg_score: number | null;
  th_count_recent: number;
  gap: number;
  th_companies: string[];
  record_companies: string[];
  missing_companies: string[];
}
interface GapsResponse {
  ok: boolean;
  total?: number;
  instructors?: InstructorGap[];
  error?: string;
}

// 잔존 mismatch 분류 (자동 처리 불가)
interface ResidualItem {
  record_id: string;
  instructor_id: string;
  instructor_name: string;
  company: string | null;
  course: string | null;
  score: number;
  respondent_count: number | null;
  response_date: string | null;
  source_type: string;
  file_name?: string | null;
  sheet_title?: string | null;
  category: string;
}
interface ResidualCategory {
  code: string;
  label: string;
  description: string;
  count: number;
  items: ResidualItem[];
}
interface ResidualResponse {
  ok: boolean;
  total?: number;
  categories?: ResidualCategory[];
  error?: string;
}

const LIMIT = 25;

function sourceTypeLabel(t: string): string {
  switch (t) {
    case "drive_satisfaction":
      return "Drive";
    case "gmail_summary":
      return "Gmail";
    case "google_forms":
      return "Forms";
    case "sheet_summary":
      return "Sheets";
    default:
      return t;
  }
}

export default function ReviewClient() {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  // v22 C: 신뢰도 낮은 record 큐
  const [suspectData, setSuspectData] = useState<SuspectResponse | null>(null);
  const [suspectOpen, setSuspectOpen] = useState(false);
  const [suspectLoading, setSuspectLoading] = useState(false);
  // v24-13: th_record_gap 강사 큐
  const [gapsData, setGapsData] = useState<GapsResponse | null>(null);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [gapsLoading, setGapsLoading] = useState(false);
  // 잔존 mismatch 분류 (자동 처리 불가)
  const [residualData, setResidualData] = useState<ResidualResponse | null>(null);
  const [residualOpen, setResidualOpen] = useState(false);
  const [residualLoading, setResidualLoading] = useState(false);
  const [residualExpanded, setResidualExpanded] = useState<Record<string, boolean>>({});

  const fetchSuspect = useCallback(async () => {
    setSuspectLoading(true);
    try {
      // v24-13: score≤3.5 + n_lte=999 — 매칭 정확성·점수 분포 폭 넓게 surface
      const res = await fetch("/api/backoffice/suspect-records?score_lte=3.5&n_lte=999&limit=50");
      const j: SuspectResponse = await res.json();
      setSuspectData(j);
    } catch {
      setSuspectData({ ok: false, error: "fetch_failed" });
    } finally {
      setSuspectLoading(false);
    }
  }, []);

  const fetchGaps = useCallback(async () => {
    setGapsLoading(true);
    try {
      const res = await fetch("/api/backoffice/instructor-gaps?min_gap=5&limit=40");
      const j: GapsResponse = await res.json();
      setGapsData(j);
    } catch {
      setGapsData({ ok: false, error: "fetch_failed" });
    } finally {
      setGapsLoading(false);
    }
  }, []);

  const fetchResidual = useCallback(async () => {
    setResidualLoading(true);
    try {
      const res = await fetch("/api/backoffice/list-residual-mismatch");
      const j: ResidualResponse = await res.json();
      setResidualData(j);
    } catch {
      setResidualData({ ok: false, error: "fetch_failed" });
    } finally {
      setResidualLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuspect();
    fetchGaps();
    fetchResidual();
  }, [fetchSuspect, fetchGaps, fetchResidual]);

  const handleSuspectCleanup = async (recordId: string) => {
    try {
      const res = await fetch("/api/backoffice/cleanup-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId }),
      });
      const j = await res.json();
      if (!j.ok) {
        setToast({ kind: "error", message: `삭제 실패: ${j.error || res.status}` });
        setTimeout(() => setToast(null), 3500);
        return;
      }
      setToast({ kind: "success", message: "record 삭제됨 (registry pending 복원)" });
      setTimeout(() => setToast(null), 3500);
      setSuspectData((prev) =>
        prev?.records
          ? { ...prev, records: prev.records.filter((r) => r.record_id !== recordId) }
          : prev
      );
    } catch {
      setToast({ kind: "error", message: "네트워크 오류" });
      setTimeout(() => setToast(null), 3500);
    }
  };

  const fetchPage = useCallback(async (nextOffset: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/backoffice/list-pending?offset=${nextOffset}&limit=${LIMIT}`);
      const j: ListResponse = await res.json();
      setData(j);
      if (j.rows && j.rows.length > 0 && !selectedId) {
        setSelectedId(j.rows[0].id);
      }
    } catch {
      setData({ ok: false, error: "fetch_failed" });
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    fetchPage(offset);
  }, [offset, fetchPage]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  const showToast = (kind: "success" | "error", message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 3500);
  };

  const handleApprove = async (registryId: string, instructorId: string) => {
    try {
      const res = await fetch("/api/backoffice/approve-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryId, instructorId }),
      });
      const j = await res.json();
      if (!j.ok) {
        showToast("error", `승인 실패: ${j.error || res.status}`);
        return;
      }
      showToast(
        "success",
        `${j.instructor?.name ?? "강사"} 승인 (avg ${j.instructor?.satisfactionAvg ?? "?"}/${j.instructor?.satisfactionCount ?? "?"})`
      );
      const removedId = registryId;
      // refresh list, select 다음 row
      setData((prev) => {
        if (!prev?.rows) return prev;
        const newRows = prev.rows.filter((r) => r.id !== removedId);
        const newTotal = (prev.total ?? 0) - 1;
        if (newRows.length === 0 && newTotal > 0) {
          fetchPage(Math.max(0, offset - LIMIT));
          return { ...prev, rows: newRows, total: newTotal };
        }
        return { ...prev, rows: newRows, total: newTotal };
      });
      setSelectedId((cur) => {
        if (cur !== removedId) return cur;
        const remaining = (data?.rows ?? []).filter((r) => r.id !== removedId);
        return remaining[0]?.id ?? null;
      });
    } catch {
      showToast("error", "네트워크 오류");
    }
  };

  const handleReject = async (registryId: string, reason: string) => {
    try {
      const res = await fetch("/api/backoffice/reject-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryId, reason }),
      });
      const j = await res.json();
      if (!j.ok) {
        showToast("error", `반려 실패: ${j.error || res.status}`);
        return;
      }
      showToast("success", "반려 처리됨");
      setData((prev) => {
        if (!prev?.rows) return prev;
        return {
          ...prev,
          rows: prev.rows.filter((r) => r.id !== registryId),
          total: (prev.total ?? 0) - 1,
        };
      });
      setSelectedId((cur) => {
        if (cur !== registryId) return cur;
        const remaining = (data?.rows ?? []).filter((r) => r.id !== registryId);
        return remaining[0]?.id ?? null;
      });
    } catch {
      showToast("error", "네트워크 오류");
    }
  };

  const reasonStats = data?.reason_distribution ?? [];

  return (
    <div className="review-shell">
      <header className="review-page-header">
        <div>
          <p className="review-eyebrow">검토 대기</p>
          <h1 className="review-title">만족도 검토 큐</h1>
          <p className="review-subtitle">
            전체 {total.toLocaleString()}건 · 응답자 수 내림차순 · 자동 매칭 실패 케이스
          </p>
        </div>
        <div className="review-pagination">
          <button
            type="button"
            className="review-paginate-btn"
            disabled={offset === 0}
            onClick={() => {
              setSelectedId(null);
              setOffset(Math.max(0, offset - LIMIT));
            }}
          >
            ← 이전
          </button>
          <span className="review-paginate-info">
            {Math.min(offset + 1, Math.max(total, 1))} – {Math.min(offset + rows.length, total)}
          </span>
          <button
            type="button"
            className="review-paginate-btn"
            disabled={offset + rows.length >= total}
            onClick={() => {
              setSelectedId(null);
              setOffset(offset + LIMIT);
            }}
          >
            다음 →
          </button>
        </div>
      </header>

      {reasonStats.length > 0 && (
        <section className="reason-bar">
          <div className="reason-bar-title">자동 매칭 실패 사유 (이 페이지 기준)</div>
          <div className="reason-bar-chips">
            {reasonStats.map((s) => (
              <span key={s.code} className={`reason-chip reason-chip-${s.severity}`}>
                <strong>{s.count}</strong>
                <span>{s.label}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* v24-13: th_record_gap 강사 큐 — 매칭 누락 의심 */}
      <section style={{
        marginTop: "0.75rem",
        padding: "0.875rem 1rem",
        background: "#eff6ff",
        border: "1px solid #93c5fd",
        borderRadius: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ color: "#1e40af", fontSize: "0.9rem" }}>
              📊 매칭 누락 의심 강사 ({gapsLoading ? "..." : gapsData?.instructors?.length ?? 0}명)
            </strong>
            <span style={{ marginLeft: "0.5rem", color: "#1e3a8a", fontSize: "0.8rem" }}>
              TH 6개월 ≥ record + 5건 — 매칭 누락 가능
            </span>
          </div>
          <button
            type="button"
            onClick={() => setGapsOpen((v) => !v)}
            style={{
              padding: "0.25rem 0.75rem",
              fontSize: "0.8rem",
              background: "#dbeafe",
              border: "1px solid #60a5fa",
              borderRadius: 4,
              cursor: "pointer",
              color: "#1e3a8a",
            }}
          >
            {gapsOpen ? "접기" : "펼치기"}
          </button>
        </div>
        {gapsOpen && (gapsData?.instructors?.length ?? 0) > 0 && (
          <table className="review-table" style={{ marginTop: "0.75rem", fontSize: "0.82rem" }}>
            <thead>
              <tr>
                <th>강사</th>
                <th>record / TH (6m)</th>
                <th>gap</th>
                <th>현재 avg</th>
                <th>누락 의심 회사</th>
              </tr>
            </thead>
            <tbody>
              {(gapsData?.instructors ?? []).map((g) => (
                <tr key={g.instructor_id}>
                  <td>
                    <strong>{g.instructor_name}</strong>
                  </td>
                  <td>
                    {g.record_count} / {g.th_count_recent}
                  </td>
                  <td>
                    <strong style={{ color: "#dc2626" }}>{g.gap}</strong>
                  </td>
                  <td>{g.avg_score?.toFixed(2) ?? "—"}</td>
                  <td style={{ fontSize: "0.75rem", color: "#374151" }}>
                    {g.missing_companies.length === 0 ? (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    ) : (
                      g.missing_companies.slice(0, 5).join(", ")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 잔존 mismatch 분류 (자동 처리 불가) */}
      <section style={{
        marginTop: "0.75rem",
        padding: "0.875rem 1rem",
        background: "#fdf4ff",
        border: "1px solid #c084fc",
        borderRadius: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ color: "#6b21a8", fontSize: "0.9rem" }}>
              🧩 잔존 mismatch 분류 ({residualLoading ? "..." : residualData?.total ?? 0}건)
            </strong>
            <span style={{ marginLeft: "0.5rem", color: "#581c87", fontSize: "0.8rem" }}>
              자동 처리 불가 — 운영자 결정 영역
            </span>
          </div>
          <button
            type="button"
            onClick={() => setResidualOpen((v) => !v)}
            style={{
              padding: "0.25rem 0.75rem",
              fontSize: "0.8rem",
              background: "#f3e8ff",
              border: "1px solid #c084fc",
              borderRadius: 4,
              cursor: "pointer",
              color: "#581c87",
            }}
          >
            {residualOpen ? "접기" : "펼치기"}
          </button>
        </div>
        {residualOpen && residualData?.categories && (
          <div style={{ marginTop: "0.75rem" }}>
            {residualData.categories.map((cat) => {
              const expanded = residualExpanded[cat.code] ?? false;
              return (
                <div
                  key={cat.code}
                  style={{
                    marginTop: "0.5rem",
                    background: "white",
                    border: "1px solid #e9d5ff",
                    borderRadius: 6,
                    padding: "0.625rem 0.875rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      setResidualExpanded((p) => ({ ...p, [cat.code]: !expanded }))
                    }
                  >
                    <div>
                      <strong style={{ color: "#581c87", fontSize: "0.85rem" }}>
                        {cat.label} ({cat.count})
                      </strong>
                      <div style={{ color: "#6b7280", fontSize: "0.75rem", marginTop: "0.125rem" }}>
                        {cat.description}
                      </div>
                    </div>
                    <span style={{ fontSize: "0.75rem", color: "#7c3aed" }}>
                      {expanded ? "▾" : "▸"}
                    </span>
                  </div>
                  {expanded && cat.items.length > 0 && (
                    <table className="review-table" style={{ marginTop: "0.625rem", fontSize: "0.78rem" }}>
                      <thead>
                        <tr>
                          <th>강사</th>
                          <th>회사 / 과정</th>
                          <th>점수</th>
                          <th>n</th>
                          <th>일자</th>
                          <th>source</th>
                          <th>file/sheet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cat.items.map((item) => (
                          <tr key={item.record_id}>
                            <td>
                              <strong>{item.instructor_name}</strong>
                            </td>
                            <td>
                              <div>{item.company ?? <span style={{ color: "#9ca3af" }}>(null)</span>}</div>
                              {item.course && (
                                <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>
                                  {item.course.slice(0, 60)}
                                </div>
                              )}
                            </td>
                            <td>{item.score.toFixed(2)}</td>
                            <td>{item.respondent_count ?? "—"}</td>
                            <td>{item.response_date ?? "—"}</td>
                            <td>{sourceTypeLabel(item.source_type)}</td>
                            <td style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                              {item.file_name?.slice(0, 50) ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* v22 C / v24-13: 신뢰도 낮은 record 검토 큐 — score≤3.5 */}
      <section className="suspect-bar" style={{
        marginTop: "0.75rem",
        padding: "0.875rem 1rem",
        background: "#fff7ed",
        border: "1px solid #fdba74",
        borderRadius: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ color: "#9a3412", fontSize: "0.9rem" }}>
              ⚠️ 신뢰도 낮은 record ({suspectLoading ? "..." : suspectData?.records?.length ?? 0}건)
            </strong>
            <span style={{ marginLeft: "0.5rem", color: "#7c2d12", fontSize: "0.8rem" }}>
              score≤3.5 — 매칭 오류 또는 진짜 낮은 점수 확인 필요
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSuspectOpen((v) => !v)}
            style={{
              padding: "0.25rem 0.75rem",
              fontSize: "0.8rem",
              background: "#fed7aa",
              border: "1px solid #fb923c",
              borderRadius: 4,
              cursor: "pointer",
              color: "#7c2d12",
            }}
          >
            {suspectOpen ? "접기" : "펼치기"}
          </button>
        </div>
        {suspectOpen && (suspectData?.records?.length ?? 0) > 0 && (
          <table className="review-table" style={{ marginTop: "0.75rem", fontSize: "0.82rem" }}>
            <thead>
              <tr>
                <th>현재 강사</th>
                <th>회사 · 과정</th>
                <th>score / n</th>
                <th>응답일</th>
                <th>TH 후보 (가까운 순)</th>
                <th>액션</th>
              </tr>
            </thead>
            <tbody>
              {(suspectData?.records ?? []).map((r) => (
                <tr key={r.record_id} style={!r.instructor_in_candidates ? { background: "#fee2e2" } : undefined}>
                  <td>
                    <strong>{r.matched_instructor ?? "—"}</strong>
                    {!r.instructor_in_candidates && (
                      <div style={{ fontSize: "0.7rem", color: "#dc2626" }}>TH 후보에 없음</div>
                    )}
                  </td>
                  <td>
                    <div>{r.company ?? "—"}</div>
                    <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>{r.course?.slice(0, 50) ?? "—"}</div>
                  </td>
                  <td>
                    <strong>{r.score.toFixed(2)}</strong> / {r.respondent_count}
                  </td>
                  <td>{r.response_date ?? "—"}</td>
                  <td style={{ fontSize: "0.72rem" }}>
                    {r.th_candidates.length === 0
                      ? <span style={{ color: "#9ca3af" }}>없음</span>
                      : r.th_candidates.slice(0, 3).map((c, i) => (
                          <div key={i} style={c.instructor_name === r.matched_instructor ? { fontWeight: 600 } : undefined}>
                            {c.instructor_name} · {c.days_from_response}일차
                          </div>
                        ))}
                    {r.suggested_alternative && (
                      <div style={{ marginTop: 4, color: "#0369a1" }}>
                        제안: <strong>{r.suggested_alternative.instructor_name}</strong>
                      </div>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => handleSuspectCleanup(r.record_id)}
                      style={{
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                        background: "#dc2626",
                        color: "white",
                        border: "none",
                        borderRadius: 3,
                        cursor: "pointer",
                      }}
                    >
                      삭제 + pending 복원
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="review-grid">
        <section className="review-table-wrap">
          {loading && rows.length === 0 ? (
            <div className="review-loading">불러오는 중…</div>
          ) : rows.length === 0 ? (
            <div className="review-empty">
              <p className="review-empty-title">검토 대기 항목이 없습니다.</p>
              <p className="review-empty-desc">자동 매칭이 모두 처리되었거나 새로운 만족도 데이터가 없습니다.</p>
            </div>
          ) : (
            <table className="review-table">
              <thead>
                <tr>
                  <th className="th-source">출처</th>
                  <th className="th-company">회사 · 과정</th>
                  <th className="th-score">평균 / N</th>
                  <th className="th-date">응답일자</th>
                  <th className="th-reason">사유</th>
                  <th className="th-suggestion">자동 추천</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`review-row${row.id === selectedId ? " review-row-active" : ""}`}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <td className="td-source">
                      <span className={`source-chip source-chip-${row.sourceType}`}>
                        {sourceTypeLabel(row.sourceType)}
                      </span>
                    </td>
                    <td className="td-company">
                      <div className="company-name">{row.company ?? "—"}</div>
                      <div className="course-name">{row.course ?? "(과정명 없음)"}</div>
                    </td>
                    <td className="td-score">
                      <div className="score-val">{row.avgScore?.toFixed(2) ?? "—"}</div>
                      <div className="score-n">N={row.responseCount}</div>
                    </td>
                    <td className="td-date">{row.responseDate?.slice(0, 10) ?? "—"}</td>
                    <td className="td-reason">
                      <span className={`reason-chip-mini reason-chip-${row.reason.severity}`} title={row.reason.label}>
                        {row.reason.label.split(" ")[0].slice(0, 18)}
                      </span>
                    </td>
                    <td className="td-suggestion">
                      {row.suggestion ? (
                        <span className="suggestion-chip">{row.suggestion.name}</span>
                      ) : (
                        <span className="suggestion-empty">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <aside className="review-detail">
          {selectedRow ? (
            <ReviewDetail
              row={selectedRow}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ) : (
            <div className="review-detail-empty">
              <p>좌측에서 검토할 항목을 선택하세요.</p>
            </div>
          )}
        </aside>
      </div>

      {toast && (
        <div className={`review-toast review-toast-${toast.kind}`}>
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

interface DetailProps {
  row: PendingRow;
  onApprove: (registryId: string, instructorId: string) => void;
  onReject: (registryId: string, reason: string) => void;
}

interface Candidate {
  instructor_id: string;
  instructor_name: string;
  ops_count: number;
  th_in_window: boolean;
  sample_messages: string[];
}

function ReviewDetail({ row, onApprove, onReject }: DetailProps) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<InstructorSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [manualSelected, setManualSelected] = useState<InstructorSummary | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  // v24-15: ops_report cross-check candidates
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  useEffect(() => {
    setSearch("");
    setResults([]);
    setManualSelected(null);
    setRejectReason("");
    setRejectOpen(false);
    setCandidates([]);
    // 자동 cross-check fetch
    if (row.registryKey) {
      setCandidatesLoading(true);
      fetch(`/api/backoffice/suggest-candidates?registry_key=${encodeURIComponent(row.registryKey)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j.ok && Array.isArray(j.candidates)) setCandidates(j.candidates);
        })
        .catch(() => {})
        .finally(() => setCandidatesLoading(false));
    }
  }, [row.id, row.registryKey]);

  useEffect(() => {
    if (search.trim().length < 1) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/backoffice/search-instructors?q=${encodeURIComponent(search.trim())}`);
        const j = await res.json();
        if (j.ok) setResults(j.results ?? []);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  const effectiveTarget = manualSelected ?? row.suggestion;

  return (
    <div className="review-detail-inner">
      <div className="detail-section">
        <h2 className="detail-section-title">검토 항목</h2>
        <dl className="detail-list">
          <DetailItem label="회사">{row.company ?? "—"}</DetailItem>
          <DetailItem label="과정">{row.course ?? "(과정명 없음)"}</DetailItem>
          <DetailItem label="평균 / 응답">
            <strong>{row.avgScore?.toFixed(2) ?? "—"}</strong> · N={row.responseCount}
          </DetailItem>
          <DetailItem label="응답일자">{row.responseDate?.slice(0, 10) ?? "—"}</DetailItem>
          {row.sessionLabel && <DetailItem label="차수">{row.sessionLabel}</DetailItem>}
          <DetailItem label="출처">{sourceTypeLabel(row.sourceType)}</DetailItem>
        </dl>
      </div>

      <div className="detail-section">
        <h2 className="detail-section-title">자동 매칭 실패 사유</h2>
        <div className={`reason-detail reason-chip-${row.reason.severity}`}>
          <strong>{row.reason.label}</strong>
          <p className="reason-detail-code">code: <code>{row.reason.code}</code></p>
          <ReasonHelp code={row.reason.code} />
        </div>
      </div>

      <div className="detail-section">
        <h2 className="detail-section-title">근거</h2>
        <dl className="detail-list detail-list-evidence">
          {row.fileName && <DetailItem label="파일명">{row.fileName}</DetailItem>}
          {row.sheetTitle && <DetailItem label="시트">{row.sheetTitle}</DetailItem>}
          {row.subject && <DetailItem label="제목">{row.subject}</DetailItem>}
          {row.candidate && <DetailItem label="후보강사">{row.candidate}</DetailItem>}
          {row.resolutionLevel && <DetailItem label="레벨">{row.resolutionLevel}</DetailItem>}
          {row.resolutionBasis && <DetailItem label="근거">{row.resolutionBasis}</DetailItem>}
          {row.sourceKey && <DetailItem label="source_key">{row.sourceKey}</DetailItem>}
        </dl>
      </div>

      <div className="detail-section">
        <h2 className="detail-section-title">강사 지정</h2>
        {row.suggestion && (
          <div className="suggestion-block">
            <div className="suggestion-meta">자동 추천</div>
            <div className="suggestion-card">
              <div className="suggestion-name">{row.suggestion.name}</div>
              {row.suggestion.contactEmail && (
                <div className="suggestion-contact">{row.suggestion.contactEmail}</div>
              )}
            </div>
          </div>
        )}
        {/* v24-15: ops_report cross-check 다중 후보 */}
        {(candidatesLoading || candidates.length > 0) && (
          <div style={{ marginTop: "0.75rem" }}>
            <div className="suggestion-meta">
              운영보고/일반 채널 cross-check 후보 ({candidatesLoading ? "..." : candidates.length}명)
            </div>
            {candidates.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
                {candidates.map((c) => (
                  <div
                    key={c.instructor_id}
                    style={{
                      padding: "0.5rem 0.75rem",
                      background: c.th_in_window ? "#eff6ff" : "#f3f4f6",
                      border: `1px solid ${c.th_in_window ? "#93c5fd" : "#d1d5db"}`,
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: "0.9rem" }}>{c.instructor_name}</strong>
                      <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "#6b7280" }}>
                        ops {c.ops_count}건 {c.th_in_window ? "· TH 확인" : "· TH 없음"}
                      </span>
                      {c.sample_messages[0] && (
                        <div style={{ fontSize: "0.72rem", color: "#374151", marginTop: 2 }}>
                          {c.sample_messages[0].slice(0, 100)}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onApprove(row.id, c.instructor_id)}
                      style={{
                        padding: "0.3rem 0.7rem",
                        fontSize: "0.8rem",
                        background: c.th_in_window ? "#2563eb" : "#6b7280",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      이 강사로 승인
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="manual-search">
          <label htmlFor="instructor-search" className="manual-search-label">
            다른 강사로 지정
          </label>
          <input
            id="instructor-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="강사 이름 검색 (예: 박상훈)"
            className="manual-search-input"
          />
          {searching && <div className="manual-search-status">검색 중…</div>}
          {results.length > 0 && (
            <ul className="manual-search-results">
              {results.map((r) => (
                <li
                  key={r.id}
                  className={`manual-search-item${manualSelected?.id === r.id ? " manual-search-item-active" : ""}`}
                  onClick={() => setManualSelected(r)}
                >
                  <div className="manual-name">{r.name}</div>
                  <div className="manual-meta">
                    {r.affiliation ?? ""}
                    {r.contactEmail ? ` · ${r.contactEmail}` : ""}
                    {r.satisfactionAvg !== null && r.satisfactionAvg !== undefined
                      ? ` · avg ${r.satisfactionAvg}`
                      : ""}
                    {r.satisfactionCount ? `/${r.satisfactionCount}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {manualSelected && (
            <div className="manual-selected">
              선택됨 → <strong>{manualSelected.name}</strong>
              <button
                type="button"
                className="manual-selected-clear"
                onClick={() => setManualSelected(null)}
              >
                초기화
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="detail-actions">
        <button
          type="button"
          className="action-btn action-btn-primary"
          disabled={!effectiveTarget}
          onClick={() => {
            if (!effectiveTarget) return;
            onApprove(row.id, effectiveTarget.id);
          }}
        >
          {effectiveTarget ? `${effectiveTarget.name} 으로 승인` : "강사 선택 후 승인"}
        </button>
        <button
          type="button"
          className="action-btn action-btn-secondary"
          onClick={() => setRejectOpen((v) => !v)}
        >
          반려
        </button>
      </div>
      {rejectOpen && (
        <div className="reject-block">
          <label htmlFor="reject-reason" className="reject-label">반려 사유 (선택)</label>
          <input
            id="reject-reason"
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="예: 만족도 아님 / 잘못된 ingest"
            className="reject-input"
          />
          <div className="reject-actions">
            <button
              type="button"
              className="action-btn action-btn-danger"
              onClick={() => onReject(row.id, rejectReason)}
            >
              반려 확정
            </button>
            <button
              type="button"
              className="action-btn action-btn-ghost"
              onClick={() => setRejectOpen(false)}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReasonHelp({ code }: { code: string }) {
  const TIPS: Record<string, string> = {
    non_instructor_course: "사이버연수/이러닝 등 강사 출강 없는 콘텐츠. 강사 매칭 의미 없음 → 반려 권장.",
    no_company: "회사명이 파싱되지 않음. 파일명/시트제목에서 직접 확인 후 수동 지정 또는 반려.",
    no_response_date: "응답일자가 없어 슬랙/지메일과 시기 매칭 불가. 파일 생성시점 등 참고.",
    low_evidence: "응답 1건 이하 + 자동 추천 없음. 테스트 응답일 가능성 — 반려 검토.",
    has_suggestion: "normalizer가 추천한 강사가 있음. 우측 패널 '강사 지정' 영역에서 확인 후 승인.",
    gmail_no_signal: "메일 본문/제목에 회사·강사 신호 부족. 보낸이/수신인/링크 확인 후 수동 지정.",
    no_slack_match: "응답일자 기준 ±14일 슬랙(운영보고/일반)에 해당 회사 메시지 없음. 수동 강사 검색.",
  };
  const tip = TIPS[code];
  if (!tip) return null;
  return <p className="reason-detail-tip">{tip}</p>;
}
