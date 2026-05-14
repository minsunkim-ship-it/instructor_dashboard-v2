import Link from "next/link";

export default function AdminHome() {
  return (
    <div className="admin-home">
      <div className="admin-home-hero">
        <p className="admin-home-eyebrow">Backoffice</p>
        <h1 className="admin-home-title">강사 운영 검토</h1>
        <p className="admin-home-lede">
          자동 매칭으로 처리되지 않은 만족도 데이터를 검토하고, 정확한 강사에게
          귀속시키세요.
        </p>
      </div>
      <div className="admin-home-grid">
        <Link href="/admin/review" className="admin-home-card">
          <div className="admin-home-card-tag">검토 대기</div>
          <div className="admin-home-card-title">만족도 검토 큐</div>
          <div className="admin-home-card-desc">
            normalizer가 단일 강사로 매칭하지 못한 만족도 데이터. 운영자가 회사·과정·
            응답일자 기반으로 정확한 강사를 지정합니다.
          </div>
          <div className="admin-home-card-cta">바로가기 →</div>
        </Link>
      </div>
    </div>
  );
}
