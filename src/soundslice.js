import { spawn } from "child_process";
import fs from "fs-extra";
import path from "path";
import { log } from "./utils.js";

export async function interceptMediaUrls(page, iframeSrc) {
  const found = {
    videoUrl: null,
    audioUrl: null,
    m3u8Url: null,
    tabData: null,
    allUrls: [],
  };

  const seen = new Set();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const type = response.headers()["content-type"] || "";

      if (url.includes("soundslice") && !seen.has(url)) {
        seen.add(url);
        found.allUrls.push({ url, type, status: response.status() });
      }

      if (
        !found.videoUrl &&
        (url.match(/\.(mp4|webm)(\?|$)/i) || type.startsWith("video/"))
      ) {
        found.videoUrl = url;
        log("🎯", `Video: ${url.substring(0, 120)}...`);
      }

      if (!found.m3u8Url && url.includes(".m3u8")) {
        found.m3u8Url = url;
        log("🎯", `HLS: ${url.substring(0, 120)}...`);
      }

      if (
        !found.audioUrl &&
        (url.match(/\.(mp3|aac|ogg|m4a)(\?|$)/i) || type.startsWith("audio/"))
      ) {
        found.audioUrl = url;
        log("🎯", `Audio: ${url.substring(0, 120)}...`);
      }

      if (
        !found.tabData &&
        url.includes("soundslice") &&
        (type.includes("application/json") || type.includes("text/javascript"))
      ) {
        const body = await response.json().catch(() => null);
        if (
          body &&
          (body.score_data || body.slices || body.notation || body.recordings)
        ) {
          found.tabData = body;
          log("📄", `Tab JSON: ${url.substring(0, 120)}...`);
        }
      }
    } catch {}
  });

  await page.goto(iframeSrc, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  await page.waitForTimeout(1200);

  const clickTargets = [
    page.locator("video").first(),
    page.locator('button[aria-label*="Play"]').first(),
    page.locator("button").filter({ hasText: /play/i }).first(),
  ];

  for (const loc of clickTargets) {
    try {
      if (await loc.count()) {
        await loc.click({ force: true, timeout: 1000 }).catch(() => {});
        break;
      }
    } catch {}
  }

  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(800);

  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (found.m3u8Url || found.videoUrl || found.audioUrl) break;
    await page.waitForTimeout(400);
  }

  await fs.writeJson("./output/debug-soundslice-urls.json", found.allUrls, {
    spaces: 2,
  });

  return found;
}

// ─────────────────────────────────────────────────────────
// alternatywne pobieranie przez ffmpeg (HLS / MP4)
// ─────────────────────────────────────────────────────────
export async function downloadWithFfmpeg(url, outputFile, cookies = []) {
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const safeOutput = outputFile.replace(/\\/g, "/");
  const ffmpegBin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  const headers = [];
  if (cookieStr) headers.push(`Cookie: ${cookieStr}`);
  headers.push("Referer: https://www.soundslice.com/");

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-stats",
    "-headers",
    headers.join("\r\n") + "\r\n",
    "-i",
    url,
    "-map",
    "0",
    "-dn",
    "-c",
    "copy",
  ];

  if (url.includes(".m3u8")) {
    args.push("-bsf:a", "aac_adtstoasc");
  }

  args.push("-y", safeOutput);

  log("📥", `ffmpeg → ${path.basename(safeOutput)}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, {
      stdio: "inherit",
      shell: false,
    });

    proc.on("error", (err) => {
      reject(new Error(`ffmpeg launch error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

// ─────────────────────────────────────────────────────────
//  screenrecording przez ffmpeg (Windows fallback) gdy DRM blokuje bezpośrednie pobieranie
// ─────────────────────────────────────────────────────────
export async function recordSoundsliceScreen(page, iframeSrc, outputFile) {
  log("🖥️", `Screen recording → ${path.basename(outputFile)}`);

  const safeOutput = outputFile.replace(/\\/g, "/");

  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-stats",
      "-f",
      "gdigrab",
      "-framerate",
      "30",
      "-i",
      "desktop",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      safeOutput,
      "-y",
    ],
    { shell: true },
  );

  ffmpeg.on("error", (err) => {
    log("❌", `ffmpeg error: ${err.message}`);
  });

  await page.goto(iframeSrc, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  await page.setViewportSize({ width: 1920, height: 1080 });

  const duration = await page.evaluate(() => {
    const v = document.querySelector("video");
    return v ? v.duration : 0;
  });

  log("⏱️", `Czas trwania: ${Math.round(duration)}s`);

  try {
    await page.click("video");
  } catch (_) {
    await page.keyboard.press("Space").catch(() => {});
  }

  const waitMs = (duration > 0 ? duration + 5 : 300) * 1000;
  await page.waitForTimeout(waitMs);

  ffmpeg.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 3000));

  log("✅", `Nagrano: ${path.basename(safeOutput)}`);
}

// ─────────────────────────────────────────────────────────
// yt-dlp jako backup dla trudnych przypadków
// ─────────────────────────────────────────────────────────
export async function downloadWithYtDlp(url, outputFile, cookies = []) {
  const safeOutput = outputFile.replace(/\\/g, "/");
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const ytDlpBin = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

  const args = ["--no-warnings", "-o", safeOutput];

  if (cookieStr) {
    args.push("--add-header", `Cookie:${cookieStr}`);
  }

  args.push(url);

  log("📥", `yt-dlp → ${path.basename(safeOutput)}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, args, {
      stdio: "inherit",
      shell: false,
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp launch error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exit ${code}`));
    });
  });
}
