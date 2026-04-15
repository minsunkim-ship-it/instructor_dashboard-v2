import InstructorList from "@/components/InstructorList";

// 06_implementation_spec.md 1절: 좌측 목록 + 우측 상세 패널
// 파일럿: 목록만 구현, 상세 패널은 빈 상태

export default function Home() {
  return (
    <div className="flex h-screen bg-gray-50">
      {/* 좌측 목록 영역 */}
      <div className="w-[420px] border-r border-gray-200 bg-white flex flex-col">
        <InstructorList />
      </div>

      {/* 우측 상세 패널 — 06_implementation_spec.md 1절: 첫 진입 시 빈 상태 */}
      <div className="flex-1 flex items-center justify-center text-gray-400">
        강사를 선택하면 상세 정보가 표시됩니다.
      </div>
    </div>
  );
}
