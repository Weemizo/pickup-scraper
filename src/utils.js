import path from "path";
import fs from "fs-extra";

export function log(prefix, message) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  console.log(`[${hh}:${mm}:${ss}] ${prefix}  ${message}`);
}

export function toSlug(input = "") {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function lessonOutputDir(gradeSlug, lessonSlug) {
  return path.join("./output", "lessons", gradeSlug, lessonSlug);
}

export async function ensureDir(dir) {
  await fs.ensureDir(dir);
}
