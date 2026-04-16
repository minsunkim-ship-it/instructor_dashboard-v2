/**
 * Store — 03_data_model.md 4-1절
 *
 * 정규화된 강사 데이터를 instructors 테이블에 upsert한다.
 * 파일럿 범위: Notion 소스 → instructors 테이블만 저장.
 * teaching_histories, fee_histories, instructor_intelligence 등은 범위 밖.
 */

import { prisma } from "@/lib/prisma";
import type { NormalizedInstructor } from "./normalizer";

const STORE_BATCH_SIZE = 25;

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

  const uniqueByName = new Map<string, NormalizedInstructor>();
  for (const inst of data) {
    const trimmedName = inst.name.trim();
    if (!trimmedName) {
      result.skipped++;
      continue;
    }

    if (uniqueByName.has(trimmedName)) {
      result.skipped++;
    }

    uniqueByName.set(trimmedName, {
      ...inst,
      name: trimmedName,
    });
  }

  const uniqueInstructors = Array.from(uniqueByName.values());
  if (uniqueInstructors.length === 0) {
    return result;
  }

  const existingRows = await prisma.instructor.findMany({
    where: {
      name: {
        in: uniqueInstructors.map((inst) => inst.name),
      },
    },
    select: {
      id: true,
      name: true,
      memoRaw: true,
    },
  });

  const existingByName = new Map(
    existingRows.map((row) => [row.name, row])
  );

  for (let i = 0; i < uniqueInstructors.length; i += STORE_BATCH_SIZE) {
    const batch = uniqueInstructors.slice(i, i + STORE_BATCH_SIZE);

    const settled = await Promise.allSettled(
      batch.map(async (inst) => {
        const existing = existingByName.get(inst.name);

        if (existing) {
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
              memoRaw: mergeMemo(existing.memoRaw, inst.memoAppendix),
            },
          });

          return { action: "updated" as const };
        }

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

        return { action: "created" as const };
      })
    );

    settled.forEach((item, index) => {
      const inst = batch[index];

      if (item.status === "fulfilled") {
        if (item.value.action === "created") {
          result.created++;
        } else {
          result.updated++;
        }
        return;
      }

      result.errors.push({
        name: inst.name,
        message:
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason),
      });
    });
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
