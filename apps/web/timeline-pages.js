export async function loadTimelinePages({
  pageCount,
  totalEntries,
  readPage,
  concurrency = 6,
}) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    throw new Error("timeline page count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(totalEntries) || totalEntries < 0) {
    throw new Error("timeline total entries must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("timeline concurrency must be a positive safe integer");
  }
  const pages = new Array(pageCount);
  let nextPage = 0;
  const workerCount = Math.max(1, Math.min(pageCount, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextPage < pageCount) {
      const page = nextPage;
      nextPage += 1;
      const entries = await readPage(page);
      if (!Array.isArray(entries)) throw new Error(`timeline page ${page} is invalid`);
      pages[page] = entries;
    }
  }));
  const timeline = pages.flat();
  if (timeline.length !== totalEntries) {
    throw new Error(`timeline expected ${totalEntries} entries, received ${timeline.length}`);
  }
  return timeline;
}
