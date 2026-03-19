import fs from "fs-extra";
import { authenticate } from "./auth.js";
import { scrapeCourse } from "./scraper.js";
import { log } from "./utils.js";

const args = process.argv.slice(2);

async function main() {
  await fs.ensureDir("./output");
  await fs.ensureDir("./output/lessons");

  if (args.includes("--auth-only")) {
    await authenticate();
    return;
  }

  if (args.includes("--scrape-only")) {
    await scrapeCourse();
    return;
  }

  if (args.includes("--videos-only")) {
    const { downloadVideos } = await import("./video-downloader.js");
    await downloadVideos();
    return;
  }

  if (args.includes("--full")) {
    await authenticate();

    await scrapeCourse();

    const { downloadVideos } = await import("./video-downloader.js");
    await downloadVideos();
    return;
  }

  log("ℹ️", "Użycie:");
  log("ℹ️", "node src/index.js --auth-only");
  log("ℹ️", "node src/index.js --scrape-only");
  log("ℹ️", "node src/index.js --videos-only");
  log("ℹ️", "node src/index.js --full");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
