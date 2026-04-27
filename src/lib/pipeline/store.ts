/**
 * Store — 03_data_model.md 4-1절
 *
 * 정규화된 강사 데이터를 instructors 테이블에 upsert한다.
 * 파일럿 범위: Notion 소스 → instructors 테이블만 저장.
 * teaching_histories, fee_histories, instructor_intelligence 등은 범위 밖.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mergeMemoNonDestructive } from "@/lib/pipeline/memo-utils";
import type { NormalizedInstructor } from "@/lib/pipeline/normalizer";
import { buildCanonicalInstructorByNameMap } from "@/lib/instructor-name-canonical";

const LOOKUP_BATCH_SIZE = 500;
const CREATE_BATCH_SIZE = 200;
const UPDATE_BATCH_SIZE = 200;

export interface StoreResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { name: string; message: string }[];
}

async function syncNotionSourceLinks(
  data: NormalizedInstructor[]
): Promise<Array<{ name: string; message: string }>> {
  if (data.length === 0) return [];

  const instructors: Array<{ id: string; name: string; createdAt: Date }> = [];
  const names = data.map((item) => item.name);
  for (let i = 0; i < names.length; i += LOOKUP_BATCH_SIZE) {
    const batch = names.slice(i, i + LOOKUP_BATCH_SIZE);
    instructors.push(
      ...(await prisma.instructor.findMany({
        where: {
          name: {
            in: batch,
          },
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      }))
    );
  }

  const instructorByName = buildCanonicalInstructorByNameMap(instructors);
  const existingLinks: Array<{ id: string; instructorDbId: string }> = [];
  const instructorIds = instructors.map((row) => row.id);
  for (let i = 0; i < instructorIds.length; i += LOOKUP_BATCH_SIZE) {
    const batch = instructorIds.slice(i, i + LOOKUP_BATCH_SIZE);
    existingLinks.push(
      ...(await prisma.sourceLink.findMany({
        where: {
          instructorDbId: {
            in: batch,
          },
          sourceType: "notion",
        },
        select: {
          id: true,
          instructorDbId: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      }))
    );
  }

  const existingLinkByInstructorId = new Map<string, { id: string }>();
  for (const row of existingLinks) {
    if (!existingLinkByInstructorId.has(row.instructorDbId)) {
      existingLinkByInstructorId.set(row.instructorDbId, { id: row.id });
    }
  }

  const errors: Array<{ name: string; message: string }> = [];
  for (const item of data) {
    const instructor = instructorByName.get(item.name);
    if (!instructor) continue;

    const payload = {
      sourceType: "notion",
      externalKey: item.notionPageId,
      externalName: item.name,
      matchStatus: "matched",
      matchBasis: {
        strategy: "notion_name_exact_match",
        notion_page_id: item.notionPageId,
      },
    } as const;

    try {
      const existingLink = existingLinkByInstructorId.get(instructor.id);
      if (existingLink) {
        await prisma.sourceLink.update({
          where: { id: existingLink.id },
          data: payload,
        });
      } else {
        await prisma.sourceLink.create({
          data: {
            instructorDbId: instructor.id,
            ...payload,
          },
        });
      }
    } catch (error) {
      errors.push({
        name: item.name,
        message:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  return errors;
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

  const existingRows: Array<{
    id: string;
    name: string;
    createdAt: Date;
    displayName: string;
    affiliation: string | null;
    categories: string[];
    specialties: string[];
    profileSummary: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    baseFeeHourly: number | null;
    feeNote: string | null;
    memoRaw: string | null;
    notionRawProperties: Prisma.JsonValue;
  }> = [];
  const instructorNames = uniqueInstructors.map((inst) => inst.name);
  for (let i = 0; i < instructorNames.length; i += LOOKUP_BATCH_SIZE) {
    const batch = instructorNames.slice(i, i + LOOKUP_BATCH_SIZE);
    existingRows.push(
      ...(await prisma.instructor.findMany({
        where: {
          name: {
            in: batch,
          },
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          displayName: true,
          affiliation: true,
          categories: true,
          specialties: true,
          profileSummary: true,
          contactEmail: true,
          contactPhone: true,
          baseFeeHourly: true,
          feeNote: true,
          memoRaw: true,
          notionRawProperties: true,
        },
      }))
    );
  }

  const existingByName = buildCanonicalInstructorByNameMap(existingRows);

  const creates: NormalizedInstructor[] = [];
  const updates: Array<{
    id: string;
    name: string;
    displayName: string;
    affiliation: string | null;
    categories: string[];
    specialties: string[];
    profileSummary: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    baseFeeHourly: number | null;
    feeNote: string | null;
    memoRaw: string | null;
    notionRawProperties: Prisma.InputJsonObject;
  }> = [];

  for (const inst of uniqueInstructors) {
    const existing = existingByName.get(inst.name);

    if (!existing) {
      creates.push(inst);
      continue;
    }

    const mergedMemo = mergeMemoNonDestructive(
      existing.memoRaw,
      inst.memoRawCandidate
    );
    const unchanged =
      existing.displayName === inst.displayName &&
      existing.affiliation === inst.affiliation &&
      jsonArrayEquals(existing.categories, inst.categories) &&
      jsonArrayEquals(existing.specialties, inst.specialties) &&
      existing.profileSummary === inst.profileSummary &&
      existing.contactEmail === inst.contactEmail &&
      existing.contactPhone === inst.contactPhone &&
      existing.baseFeeHourly === inst.baseFeeHourly &&
      existing.feeNote === inst.feeNote &&
      existing.memoRaw === mergedMemo &&
      JSON.stringify(existing.notionRawProperties ?? {}) ===
        JSON.stringify(inst.notionRawProperties);

    if (unchanged) {
      continue;
    }

    updates.push({
      id: existing.id,
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
      memoRaw: mergedMemo,
      notionRawProperties:
        inst.notionRawProperties as Prisma.InputJsonObject,
    });
  }

  for (let i = 0; i < creates.length; i += CREATE_BATCH_SIZE) {
    const batch = creates.slice(i, i + CREATE_BATCH_SIZE);
    try {
      await prisma.instructor.createMany({
        data: batch.map((inst) => ({
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
          memoRaw: inst.memoRawCandidate,
          notionRawProperties:
            inst.notionRawProperties as Prisma.InputJsonObject,
        })),
        skipDuplicates: true,
      });
      result.created += batch.length;
    } catch (error) {
      for (const inst of batch) {
        result.errors.push({
          name: inst.name,
          message:
            error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
    try {
      await prisma.$executeRaw(
        Prisma.sql`
          WITH incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS x(
              id uuid,
              name text,
              "displayName" text,
              affiliation text,
              categories text[],
              specialties text[],
              "profileSummary" text,
              "contactEmail" text,
              "contactPhone" text,
              "baseFeeHourly" int,
              "feeNote" text,
              "memoRaw" text,
              "notionRawProperties" jsonb
            )
          )
          UPDATE instructors AS i
          SET
            display_name = incoming."displayName",
            affiliation = incoming.affiliation,
            categories = incoming.categories,
            specialties = incoming.specialties,
            profile_summary = incoming."profileSummary",
            contact_email = incoming."contactEmail",
            contact_phone = incoming."contactPhone",
            base_fee_hourly = incoming."baseFeeHourly",
            fee_note = incoming."feeNote",
            memo_raw = incoming."memoRaw",
            notion_raw_properties = incoming."notionRawProperties"
          FROM incoming
          WHERE i.id = incoming.id
        `
      );
      result.updated += batch.length;
    } catch (error) {
      for (const inst of batch) {
        result.errors.push({
          name: inst.name,
          message:
            error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  result.errors.push(...(await syncNotionSourceLinks(uniqueInstructors)));

  return result;
}

function jsonArrayEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
