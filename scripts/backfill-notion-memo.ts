import { prisma } from "@/lib/prisma";
import { enrichMemoFromNotionPage } from "@/lib/notion-enrichment";
import { collectFromNotionWithProgress } from "@/lib/pipeline/notion-collector";
import { normalizeNotionData } from "@/lib/pipeline/normalizer";
import { storeInstructors } from "@/lib/pipeline/store";

const CONCURRENCY = 2;
const RETRY_DELAYS_MS = [1000, 2500, 5000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryEnrichMemo(args: {
  existingMemo: string | null;
  notionPageId: string;
}) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await enrichMemoFromNotionPage(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retriable =
        message.includes("429") ||
        message.includes("503") ||
        message.includes("timeout");
      if (!retriable || attempt === RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw new Error("unreachable");
}

async function main() {
  console.log("[1/3] Notion collect -> normalize -> store 시작");
  const rawData = await collectFromNotionWithProgress({
    onProgress: (event) => {
      if (event.stage === "page_complete" || event.stage === "done") {
        console.log(
          `[notion] stage=${event.stage} page=${event.page} fetched_rows=${event.fetchedRows}`
        );
      }
    },
  });
  const normalized = normalizeNotionData(rawData);
  const storeResult = await storeInstructors(normalized);
  console.log(
    JSON.stringify(
      {
        stage: "store_complete",
        fetched: rawData.length,
        normalized: normalized.length,
        created: storeResult.created,
        updated: storeResult.updated,
        skipped: storeResult.skipped,
        store_errors: storeResult.errors.length,
      },
      null,
      2
    )
  );

  console.log("[2/3] Notion source link가 있는 강사 조회");
  const instructors = await prisma.instructor.findMany({
    where: {
      sourceLinks: {
        some: {
          sourceType: "notion",
          externalKey: {
            not: null,
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      memoRaw: true,
      sourceLinks: {
        where: {
          sourceType: "notion",
          externalKey: {
            not: null,
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
        select: {
          externalKey: true,
        },
      },
    },
    orderBy: {
      name: "asc",
    },
  });

  console.log(
    JSON.stringify(
      {
        stage: "backfill_prepare",
        linked_instructors: instructors.length,
        concurrency: CONCURRENCY,
      },
      null,
      2
    )
  );

  console.log("[3/3] memo_raw backfill 시작");
  let attempted = 0;
  let updated = 0;
  let failed = 0;
  let pageCommentTotal = 0;
  let blockCommentTotal = 0;
  let blockTextTotal = 0;
  let incomingLineTotal = 0;
  const failures: Array<{ name: string; message: string }> = [];

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= instructors.length) return;

      const instructor = instructors[currentIndex];
      const notionPageId = instructor.sourceLinks[0]?.externalKey;
      if (!notionPageId) continue;

      attempted += 1;
      try {
        const enriched = await retryEnrichMemo({
          existingMemo: instructor.memoRaw,
          notionPageId,
        });

        pageCommentTotal += enriched.pageCommentCount;
        blockCommentTotal += enriched.blockCommentCount;
        blockTextTotal += enriched.blockTextCount;
        incomingLineTotal += enriched.incomingLineCount;

        if (enriched.updated) {
          await prisma.instructor.update({
            where: { id: instructor.id },
            data: { memoRaw: enriched.mergedMemo },
          });
          updated += 1;
        }
      } catch (error) {
        failed += 1;
        failures.push({
          name: instructor.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (attempted % 25 === 0 || attempted === instructors.length) {
        console.log(
          JSON.stringify(
            {
              stage: "backfill_progress",
              attempted,
              updated,
              failed,
              remaining: Math.max(0, instructors.length - attempted),
            },
            null,
            2
          )
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    JSON.stringify(
      {
        stage: "backfill_complete",
        linked_instructors: instructors.length,
        attempted,
        updated,
        failed,
        page_comment_total: pageCommentTotal,
        block_comment_total: blockCommentTotal,
        block_text_total: blockTextTotal,
        incoming_line_total: incomingLineTotal,
        failures: failures.slice(0, 20),
      },
      null,
      2
    )
  );
}

await main();
