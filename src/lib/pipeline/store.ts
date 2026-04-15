/**
 * Store — 03_data_model.md 4-1절
 *
 * 정규화된 강사 데이터를 instructors 테이블에 upsert한다.
 * 파일럿 범위: Notion 소스 → instructors 테이블만 저장.
 * teaching_histories, fee_histories, instructor_intelligence 등은 범위 밖.
 */

import { prisma } from "@/lib/prisma";
import type { NormalizedInstructor } from "./normalizer";

export interface StoreResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { name: string; message: string }[];
}

/**
 * 정규화된 강사 목록을 instructors 테이블에 저장한다.
 *
 * 동일인 판정: 01_core_policy 4절 — 이름 exact match 기준.
 * Notion 소스에서 instructor_id는 제공되지 않으므로 name으로 upsert.
 */
export async function storeInstructors(
  data: NormalizedInstructor[]
): Promise<StoreResult> {
  const result: StoreResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const inst of data) {
    try {
      const existing = await prisma.instructor.findFirst({
        where: { name: inst.name },
      });

      if (existing) {
        // 기존 레코드 업데이트 — Notion 프로필 데이터로 갱신
        await prisma.instructor.update({
          where: { id: existing.id },
          data: {
            displayName: inst.displayName,
            affiliation: inst.affiliation,
            categories: inst.categories,
            specialties: inst.specialties,
            profileSummary: inst.profileSummary,
            contactEmail: inst.contactEmail,
            contactPhone: inst.contactPhone,
            baseFeeHourly: inst.baseFeeHourly,
            feeNote: inst.feeNote,
            // 보조 연락처 보존: 기존 memoRaw에 appendix 병합
            memoRaw: mergeMemo(existing.memoRaw, inst.memoAppendix),
          },
        });
        result.updated++;
      } else {
        // 신규 레코드 생성
        await prisma.instructor.create({
          data: {
            name: inst.name,
            displayName: inst.displayName,
            affiliation: inst.affiliation,
            categories: inst.categories,
            specialties: inst.specialties,
            profileSummary: inst.profileSummary,
            contactEmail: inst.contactEmail,
            contactPhone: inst.contactPhone,
            baseFeeHourly: inst.baseFeeHourly,
            feeNote: inst.feeNote,
            memoRaw: inst.memoAppendix,
          },
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push({
        name: inst.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * 기존 memoRaw에 보조 연락처 appendix를 병합한다.
 * 이미 동일 내용이 포함되어 있으면 중복 추가하지 않는다.
 */
function mergeMemo(
  existingMemo: string | null,
  appendix: string | null
): string | null {
  if (!appendix) return existingMemo;
  if (!existingMemo) return appendix;
  // 이미 포함되어 있으면 그대로
  if (existingMemo.includes(appendix)) return existingMemo;
  return `${existingMemo}\n${appendix}`;
}
