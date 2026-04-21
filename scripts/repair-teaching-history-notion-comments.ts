import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  buildStoredFallbackSnapshot,
  writeStoredFallbackSnapshot,
} from "@/lib/fallback-snapshot";
import { mergeMemoNonDestructive } from "@/lib/pipeline/memo-utils";
import {
  extractNotionCommentMemoLinesFromCourseName,
  isNotionCommentCourseName,
  sanitizeTeachingHistoryCourseName,
} from "@/lib/pipeline/notion-comment-course-name";

const prisma = new PrismaClient();

function dedupeMemoLines(lines: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }

  return deduped;
}

function dedupeMemoText(value: string | null): string | null {
  if (!value) return null;
  const deduped = dedupeMemoLines(value.split("\n"));
  return deduped.length > 0 ? deduped.join("\n") : null;
}

function parseArgs() {
  const args = new Map<string, string>();
  for (const entry of process.argv.slice(2)) {
    const [key, value] = entry.split("=", 2);
    if (key?.startsWith("--")) {
      args.set(key.slice(2), value ?? "");
    }
  }

  return {
    dryRun: args.get("dryRun") === "1",
    courseId: args.get("courseId") || null,
    instructorName: args.get("instructorName") || null,
    refreshSnapshot: args.get("refreshSnapshot") !== "0",
  };
}

const { dryRun, courseId, instructorName, refreshSnapshot } = parseArgs();

console.log(
  `Repair teaching_history notion comments${dryRun ? " [dry-run]" : ""}`
    + `${courseId ? ` [courseId=${courseId}]` : ""}`
    + `${instructorName ? ` [instructor=${instructorName}]` : ""}`
);

const rows = await prisma.teachingHistory.findMany({
  where: {
    courseName: {
      contains: "[Notion comment ·",
    },
  },
  select: {
    id: true,
    instructorDbId: true,
    companyName: true,
    courseName: true,
    courseId: true,
    sourceType: true,
    instructor: {
      select: {
        name: true,
        memoRaw: true,
      },
    },
  },
});

const targets = rows.filter((row) => {
  if (!isNotionCommentCourseName(row.courseName)) return false;
  if (courseId && row.courseId !== courseId) return false;
  if (instructorName && row.instructor.name !== instructorName) return false;
  return true;
});

const memoLinesByInstructorId = new Map<string, string[]>();
const courseUpdates = targets
  .map((row) => {
    const nextCourseName = sanitizeTeachingHistoryCourseName(row.courseName);
    const memoLines = extractNotionCommentMemoLinesFromCourseName(row.courseName);

    if (memoLines.length > 0) {
      const bucket = memoLinesByInstructorId.get(row.instructorDbId) ?? [];
      bucket.push(...memoLines);
      memoLinesByInstructorId.set(row.instructorDbId, bucket);
    }

    return {
      id: row.id,
      instructorDbId: row.instructorDbId,
      instructorName: row.instructor.name,
      courseId: row.courseId,
      currentCourseName: row.courseName,
      nextCourseName,
      memoLines,
    };
  })
  .filter((row) => row.nextCourseName && row.nextCourseName !== row.currentCourseName);

const memoUpdates = Array.from(memoLinesByInstructorId.entries())
  .map(([instructorDbId, incomingLines]) => {
    const sample = targets.find((row) => row.instructorDbId === instructorDbId);
    if (!sample) return null;

    const mergedMemo = dedupeMemoText(
      mergeMemoNonDestructive(
        dedupeMemoText(sample.instructor.memoRaw),
        dedupeMemoLines(incomingLines).join("\n")
      )
    );

    return {
      instructorDbId,
      instructorName: sample.instructor.name,
      currentMemo: sample.instructor.memoRaw,
      mergedMemo,
    };
  })
  .filter(
    (
      value
    ): value is NonNullable<typeof value> =>
      value !== null && value.mergedMemo !== value.currentMemo
  );

console.log(
  JSON.stringify(
    {
      scanned: rows.length,
      targets: targets.length,
      courseUpdates: courseUpdates.map((row) => ({
        id: row.id,
        instructorName: row.instructorName,
        courseId: row.courseId,
        nextCourseName: row.nextCourseName,
      })),
      memoUpdates: memoUpdates.map((row) => ({
        instructorName: row.instructorName,
        lineCount: row.mergedMemo?.split("\n").length ?? 0,
      })),
    },
    null,
    2
  )
);

if (!dryRun) {
  for (const row of courseUpdates) {
    await prisma.teachingHistory.update({
      where: { id: row.id },
      data: { courseName: row.nextCourseName },
    });
  }

  for (const row of memoUpdates) {
    await prisma.instructor.update({
      where: { id: row.instructorDbId },
      data: { memoRaw: row.mergedMemo },
    });
  }

  if (refreshSnapshot && (courseUpdates.length > 0 || memoUpdates.length > 0)) {
    const snapshot = await buildStoredFallbackSnapshot();
    await writeStoredFallbackSnapshot(snapshot);
  }
}

await prisma.$disconnect();
