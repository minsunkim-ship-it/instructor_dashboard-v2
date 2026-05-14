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
}

interface ListResponse {
  ok: boolean;
  total?: number;
  offset?: number;
  limit?: number;
  rows?: PendingRow[];
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

function ReviewDetail({ row, onApprove, onReject }: DetailProps) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<InstructorSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [manualSelected, setManualSelected] = useState<InstructorSummary | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);

  useEffect(() => {
    setSearch("");
    setResults([]);
    setManualSelected(null);
    setRejectReason("");
    setRejectOpen(false);
  }, [row.id]);

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
