"use client";

import { useCallback, useEffect, useState } from "react";

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

const CATEGORY_COLORS: Record<string, { bg: string; border: string; fg: string }> = {
  null_co_drive_self: { bg: "#ecfdf5", border: "#6ee7b7", fg: "#065f46" },
  null_co_gmail_raw_lost: { bg: "#fef3c7", border: "#fcd34d", fg: "#92400e" },
  empty_drive_generic: { bg: "#fee2e2", border: "#fca5a5", fg: "#991b1b" },
  has_suggested: { bg: "#fdf4ff", border: "#c084fc", fg: "#581c87" },
};

export default function ResidualClient() {
  const [data, setData] = useState<ResidualResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/backoffice/list-residual-mismatch");
      const j: ResidualResponse = await res.json();
      setData(j);
      if (j.categories && j.categories.length > 0 && !activeTab) {
        setActiveTab(j.categories[0].code);
      }
    } catch {
      setData({ ok: false, error: "fetch_failed" });
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeCategory = data?.categories?.find((c) => c.code === activeTab) ?? null;

  return (
    <div className="review-shell">
      <header className="review-page-header">
        <div>
          <p className="review-eyebrow">자동 처리 불가</p>
          <h1 className="review-title">TH mismatch 잔존</h1>
          <p className="review-subtitle">
            전체 {data?.total ?? "?"}건 · 운영자 결정 영역 (cleanup or reassign or 유지)
          </p>
        </div>
      </header>

      {loading && <p style={{ color: "#6b7280" }}>불러오는 중…</p>}
      {!loading && !data?.ok && (
        <p style={{ color: "#991b1b" }}>로드 실패: {data?.error ?? "unknown"}</p>
      )}

      {data?.ok && data.categories && (
        <>
          {/* 카테고리 탭 */}
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginTop: "1rem",
              borderBottom: "2px solid #e5e7eb",
              paddingBottom: "0.5rem",
            }}
          >
            {data.categories.map((cat) => {
              const isActive = cat.code === activeTab;
              const color = CATEGORY_COLORS[cat.code] ?? {
                bg: "#f3f4f6",
                border: "#9ca3af",
                fg: "#374151",
              };
              return (
                <button
                  key={cat.code}
                  type="button"
                  onClick={() => setActiveTab(cat.code)}
                  style={{
                    padding: "0.5rem 1rem",
                    background: isActive ? color.bg : "white",
                    border: `2px solid ${isActive ? color.border : "#d1d5db"}`,
                    borderRadius: "8px 8px 0 0",
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? color.fg : "#374151",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  {cat.label}{" "}
                  <span
                    style={{
                      marginLeft: "0.25rem",
                      padding: "0.125rem 0.5rem",
                      background: isActive ? "white" : "#f3f4f6",
                      borderRadius: 12,
                      fontSize: "0.75rem",
                    }}
                  >
                    {cat.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 활성 카테고리 */}
          {activeCategory && (
            <div
              style={{
                marginTop: "1rem",
                padding: "1rem",
                background: CATEGORY_COLORS[activeCategory.code]?.bg ?? "#f9fafb",
                border: `1px solid ${CATEGORY_COLORS[activeCategory.code]?.border ?? "#d1d5db"}`,
                borderRadius: 8,
              }}
            >
              <p
                style={{
                  color: CATEGORY_COLORS[activeCategory.code]?.fg ?? "#374151",
                  fontSize: "0.875rem",
                  margin: 0,
                }}
              >
                {activeCategory.description}
              </p>
            </div>
          )}

          {activeCategory && activeCategory.items.length > 0 && (
            <table className="review-table" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th>강사</th>
                  <th>회사 / 과정</th>
                  <th>점수</th>
                  <th>n</th>
                  <th>일자</th>
                  <th>source</th>
                  <th>file/sheet</th>
                  <th>record_id</th>
                </tr>
              </thead>
              <tbody>
                {activeCategory.items.map((item) => (
                  <tr key={item.record_id}>
                    <td>
                      <strong>{item.instructor_name}</strong>
                    </td>
                    <td>
                      <div>
                        {item.company ?? <span style={{ color: "#9ca3af" }}>(null)</span>}
                      </div>
                      {item.course && (
                        <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                          {item.course.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td>{item.score.toFixed(2)}</td>
                    <td>{item.respondent_count ?? "—"}</td>
                    <td>{item.response_date ?? "—"}</td>
                    <td>{sourceTypeLabel(item.source_type)}</td>
                    <td style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                      {item.file_name?.slice(0, 60) ?? "—"}
                    </td>
                    <td style={{ color: "#9ca3af", fontSize: "0.7rem", fontFamily: "monospace" }}>
                      {item.record_id.slice(0, 8)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
