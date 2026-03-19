import { chromium } from "playwright";
import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { createAuthContext } from "./auth.js";
import { log, toSlug, lessonOutputDir } from "./utils.js";
import * as dotenv from "dotenv";

dotenv.config();

const NAV_TIMEOUT_MS = 60000;
const TAB_SETTLE_MS = 1400;
const MEDIA_WAIT_MS = 22000;
const BAD_DURATION_SEC = 7;
const WRITE_DEBUG_JSON = false;
const ONLY_MISSING_OR_BAD = true;

export async function downloadVideos() {
  const coursePath = "./output/course.json";

  if (!(await fs.pathExists(coursePath))) {
    throw new Error(
      "Brak output/course.json. Najpierw odpal npm.cmd run scrape",
    );
  }

  const course = await fs.readJson(coursePath);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 35,
  });

  const context = await createAuthContext(browser);
  const page = await context.newPage();

  try {
    for (const grade of course.grades || []) {
      const gradeSlug = grade.gradeSlug || toSlug(grade.gradeNum || "grade");

      for (const lesson of grade.lessons || []) {
        if (lesson?.error || !lesson?.url) continue;

        const lessonDay = lesson.day || lesson.lesson?.day || "";
        const lessonTitle = lesson.title || lesson.lesson?.title || "";
        const lessonSlug = lesson.slug || toSlug(`${lessonDay}-${lessonTitle}`);
        const outDir =
          lesson.outputDir || lessonOutputDir(gradeSlug, lessonSlug);
        await fs.ensureDir(outDir);

        const isWorkout = /workout/i.test(lessonTitle);
        const labelBase = `${grade.gradeNum} / ${lessonDay} / ${lessonTitle}`;

        log("🎬", labelBase);

        const units = await discoverPlayableUnits(page, lesson.url, isWorkout);
        if (!units.length) {
          log("⚠️", `${labelBase}: nie udało się zbudować listy zakładek`);
          continue;
        }

        const queue = [];
        for (const unit of units) {
          const outputFile = path.join(outDir, unitToVideoFilename(unit));
          const retry = ONLY_MISSING_OR_BAD
            ? await shouldRedownloadVideo(outputFile)
            : true;

          if (retry) {
            queue.push({
              ...unit,
              outputFile,
              debugFile: path.join(
                outDir,
                `${unitToDebugBasename(unit)}-video-debug.json`,
              ),
            });
          }
        }

        if (!queue.length) {
          log("✅", `${labelBase}: nic do retry`);
          continue;
        }

        for (const unit of queue) {
          const unitLabel = `${labelBase} / ${unit.label}`;
          log("🎬", unitLabel);

          const capture = await captureCandidatesForUnit(
            context,
            lesson.url,
            unit,
          );

          if (WRITE_DEBUG_JSON) {
            await fs
              .writeJson(unit.debugFile, capture, { spaces: 2 })
              .catch(() => {});
          }

          if (!capture.candidates.length) {
            log("⚠️", `${unitLabel}: brak sensownych media URL`);
            continue;
          }

          const cookies = await context
            .cookies(process.env.BASE_URL || undefined)
            .catch(() => []);
          let success = false;

          for (const candidate of capture.candidates) {
            try {
              await fs.remove(unit.outputFile).catch(() => {});
              await downloadWithFfmpeg(
                candidate.url,
                unit.outputFile,
                lesson.url,
                cookies,
              );

              const duration = await getVideoDurationSec(unit.outputFile);
              if (!Number.isFinite(duration) || duration <= BAD_DURATION_SEC) {
                await fs.remove(unit.outputFile).catch(() => {});
                log(
                  "⚠️",
                  `${unit.label}: odrzucono ${Math.round(duration || 0)}s (${candidate.source})`,
                );
                continue;
              }

              log(
                "✅",
                `${unit.label}: zapisano ${path.basename(unit.outputFile)}`,
              );
              success = true;
              break;
            } catch (err) {
              await fs.remove(unit.outputFile).catch(() => {});
              log("⚠️", `${unit.label}: ${candidate.source} -> ${err.message}`);
            }
          }

          if (!success) {
            log("❌", `${unitLabel}: nie udało się pobrać poprawnego pliku`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
}

async function discoverPlayableUnits(page, lessonUrl, workoutOnly = false) {
  await page.goto(lessonUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });

  await waitForTabs(page);
  await page.waitForTimeout(TAB_SETTLE_MS);

  const tabs = await readTabs(page);
  if (!tabs.length) {
    return [
      {
        kind: "lesson",
        index: 0,
        label: "Lesson",
        tabIndex: 0,
        url: lessonUrl,
      },
    ];
  }

  const units = [];

  for (const tab of tabs) {
    if (tab.disabled) continue;

    const kind = detectUnitKind(tab.label, tab.subtitle, tab.index);
    if (workoutOnly && kind !== "lesson") continue;

    await openTab(page, tab.index);
    const currentUrl = page.url();

    units.push({
      kind,
      index: kind === "exercise" ? extractFirstNumber(tab.label) : 0,
      label: formatUnitLabel(kind, tab.label),
      subtitle: tab.subtitle || "",
      tabIndex: tab.index,
      url: currentUrl || lessonUrl,
    });
  }

  const dedup = new Map();
  for (const unit of units) {
    dedup.set(`${unit.kind}:${unit.index}:${unit.url}`, unit);
  }

  const ordered = Array.from(dedup.values()).sort(
    (a, b) => a.tabIndex - b.tabIndex,
  );
  return ordered.length
    ? ordered
    : [
        {
          kind: "lesson",
          index: 0,
          label: "Lesson",
          tabIndex: 0,
          url: lessonUrl,
        },
      ];
}

async function captureCandidatesForUnit(context, lessonUrl, unit) {
  const page = await context.newPage();
  const candidates = new Map();

  const remember = (url, source, meta = {}) => {
    const normalized = normalizeCandidateUrl(url);
    if (!normalized) return;
    if (isIgnoredMediaUrl(normalized)) return;

    const prev = candidates.get(normalized) || {
      url: normalized,
      source,
      score: -999,
      durationHint: null,
    };

    const score = scoreCandidate(normalized, source, meta.durationHint);
    if (score > prev.score) {
      candidates.set(normalized, {
        ...prev,
        source,
        score,
        durationHint: meta.durationHint ?? prev.durationHint ?? null,
      });
    }
  };

  const onResponse = async (response) => {
    try {
      const url = response.url();
      const type = String(
        response.headers()["content-type"] || "",
      ).toLowerCase();

      if (looksLikePlayableMedia(url, type)) {
        remember(url, `response:${type || "unknown"}`);
      }
    } catch {}
  };

  page.on("response", onResponse);

  try {
    await page.goto(unit.url || lessonUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    await waitForTabs(page).catch(() => {});
    await page.waitForTimeout(TAB_SETTLE_MS);

    if (
      (page.url() === lessonUrl || !page.url().includes("/item/")) &&
      unit.kind !== "lesson"
    ) {
      await openTab(page, unit.tabIndex).catch(() => {});
    }

    await waitForVideoOrPlayer(page);
    await startPlayback(page);

    const deadline = Date.now() + MEDIA_WAIT_MS;
    while (Date.now() < deadline) {
      const videoState = await readVideoState(page);
      if (videoState?.src) {
        remember(videoState.src, "video.currentSrc", {
          durationHint: videoState.duration,
        });
      }

      const perfUrls = await readPerformanceUrls(page);
      for (const perfUrl of perfUrls) {
        remember(perfUrl, "performance");
      }

      await page.waitForTimeout(500);
    }

    const ordered = Array.from(candidates.values())
      .sort((a, b) => b.score - a.score)
      .map(({ url, source, score, durationHint }) => ({
        url,
        source,
        score,
        durationHint,
      }));

    return {
      unit,
      finalUrl: page.url(),
      candidates: ordered,
      videoState: await readVideoState(page),
    };
  } finally {
    page.off("response", onResponse);
    await page.close().catch(() => {});
  }
}

function detectUnitKind(label = "", subtitle = "", index = 0) {
  const text = `${label} ${subtitle}`.toLowerCase();
  if (/^lesson$/i.test(label) || text.includes(" lesson")) return "lesson";
  if (/^jam$/i.test(label) || text.includes(" jam")) return "jam";
  if (/exercise\s*\d+/i.test(text)) return "exercise";
  return index === 0 ? "lesson" : "exercise";
}

function formatUnitLabel(kind, label = "") {
  if (kind === "lesson") return "Lesson";
  if (kind === "jam") return "Jam";

  const n = extractFirstNumber(label);
  return Number.isFinite(n) ? `Exercise ${n}` : label || "Exercise";
}

function extractFirstNumber(text = "") {
  const n = Number(String(text).match(/(\d+)/)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

function unitToVideoFilename(unit) {
  if (unit.kind === "lesson") return "video-lesson.mp4";
  if (unit.kind === "jam") return "video-jam.mp4";
  if (unit.kind === "exercise") return `video-exercise-${unit.index || 1}.mp4`;
  return `video-${toSlug(unit.label || "unit")}.mp4`;
}

function unitToDebugBasename(unit) {
  if (unit.kind === "lesson") return "lesson";
  if (unit.kind === "jam") return "jam";
  if (unit.kind === "exercise") return `exercise-${unit.index || 1}`;
  return toSlug(unit.label || "unit");
}

async function readTabs(page) {
  return page
    .locator('[role="tab"]')
    .evaluateAll((nodes) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      return nodes.map((tab, index) => {
        const texts = Array.from(
          tab.querySelectorAll('[dir="auto"], h1, h2, h3, [role="heading"]'),
        )
          .map((el) => clean(el.textContent))
          .filter(Boolean);

        return {
          index,
          label:
            clean(tab.getAttribute("aria-label")) ||
            texts[0] ||
            `tab-${index + 1}`,
          heading: texts[0] || null,
          subtitle: texts[1] || null,
          disabled: tab.getAttribute("aria-disabled") === "true",
        };
      });
    })
    .catch(() => []);
}

async function waitForTabs(page) {
  await page
    .waitForFunction(
      () => {
        return document.querySelectorAll('[role="tab"]').length > 0;
      },
      { timeout: 15000 },
    )
    .catch(() => {});
}

async function openTab(page, index) {
  const tabs = page.locator('[role="tab"]');
  const count = await tabs.count().catch(() => 0);
  if (index >= count) return false;

  await tabs
    .nth(index)
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(TAB_SETTLE_MS);
  return true;
}

async function waitForVideoOrPlayer(page) {
  const selectors = [
    "main video",
    "video",
    'button[aria-label*="Play" i]',
    '[role="button"][aria-label*="Play" i]',
  ];

  const started = Date.now();
  while (Date.now() - started < 15000) {
    for (const selector of selectors) {
      const count = await page
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count > 0) return true;
    }
    await page.waitForTimeout(400);
  }

  return false;
}

async function startPlayback(page) {
  const video = page.locator("video").first();
  if (await video.count().catch(() => 0)) {
    await video.scrollIntoViewIfNeeded().catch(() => {});
    await video.click({ force: true, timeout: 2000 }).catch(() => {});
  }

  const buttons = [
    page.locator('button[aria-label*="Play" i]').first(),
    page.locator('[role="button"][aria-label*="Play" i]').first(),
  ];

  for (const btn of buttons) {
    if (await btn.count().catch(() => 0)) {
      await btn.click({ force: true, timeout: 2000 }).catch(() => {});
      break;
    }
  }

  await page
    .evaluate(() => {
      const video = document.querySelector("video");
      if (!video) return;
      video.muted = true;
      const p = video.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    })
    .catch(() => {});

  await page.waitForTimeout(1800);
}

async function readVideoState(page) {
  return page
    .evaluate(() => {
      const video = document.querySelector("video");
      if (!video) return null;

      return {
        src: video.currentSrc || video.src || null,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        currentTime: Number.isFinite(video.currentTime)
          ? video.currentTime
          : null,
        readyState: video.readyState,
      };
    })
    .catch(() => null);
}

async function readMuxPlayerState(page) {
  return await page
    .evaluate(() => {
      const mux = document.querySelector("mux-player");
      if (!mux) return null;

      const src = mux.getAttribute("src") || mux.src || null;

      return { src };
    })
    .catch(() => null);
}

async function readPerformanceUrls(page) {
  return await page
    .evaluate(() => {
      return performance
        .getEntriesByType("resource")
        .map((x) => x.name)
        .filter(Boolean)
        .filter((url) => {
          const u = String(url).toLowerCase();

          const blocked = [
            "sentry.io",
            "posthog",
            "customer.io",
            "intercom",
            "facebook.net",
            "tiktok",
            "analytics",
            "fonts/",
            "/_next/static/",
            "/_next/data/",
            ".js",
            ".css",
            ".ttf",
            ".woff",
            ".woff2",
            ".webp",
            ".png",
            ".jpg",
            ".jpeg",
            "storyboard",
            "404.json",
          ];

          if (blocked.some((x) => u.includes(x))) return false;

          return (
            /https:\/\/stream\.mux\.com\/.+\.m3u8/i.test(url) ||
            /https:\/\/stream\.mux\.com\/.+\.mp4/i.test(url) ||
            /\.m3u8(\?|$)/i.test(url) ||
            /\.mp4(\?|$)/i.test(url) ||
            /master\.m3u8/i.test(url) ||
            /playlist\.m3u8/i.test(url)
          );
        });
    })
    .catch(() => []);
}

function looksLikePlayableMedia(url, contentType = "") {
  const lower = String(url || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();

  if (isIgnoredMediaUrl(lower)) return false;

  return (
    lower.includes(".m3u8") ||
    lower.includes("master.m3u8") ||
    lower.includes("playlist.m3u8") ||
    lower.includes(".mp4") ||
    lower.includes(".mpd") ||
    type.startsWith("video/") ||
    type.includes("application/vnd.apple.mpegurl") ||
    type.includes("application/x-mpegurl") ||
    type.includes("dash+xml")
  );
}

function isIgnoredMediaUrl(url = "") {
  const lower = String(url).toLowerCase();

  return (
    !lower ||
    lower.includes("_buildmanifest.js") ||
    lower.includes("_ssgmanifest.js") ||
    lower.endsWith(".js") ||
    lower.endsWith(".css") ||
    lower.endsWith(".vtt") ||
    lower.includes(".m4s") ||
    lower.includes(".ts?") ||
    /\/seg[-_]/.test(lower) ||
    /\/frag[-_]/.test(lower) ||
    /\/chunk[-_]/.test(lower) ||
    lower.includes("init.mp4") ||
    lower.includes("sprite") ||
    lower.includes("thumb") ||
    lower.includes("storyboard") ||
    lower.includes("preview")
  );
}

function normalizeCandidateUrl(url = "") {
  return String(url).trim();
}

function scoreCandidate(url, source = "", durationHint = null) {
  const lower = url.toLowerCase();
  let score = 0;

  if (lower.includes("master.m3u8")) score += 120;
  else if (lower.includes(".m3u8")) score += 110;
  else if (lower.includes(".mpd")) score += 100;
  else if (lower.includes(".mp4")) score += 80;

  if (source.startsWith("video.currentSrc")) score += 40;
  if (source.startsWith("response:video/")) score += 30;
  if (source.startsWith("performance")) score += 10;

  if (Number.isFinite(durationHint) && durationHint > BAD_DURATION_SEC)
    score += 25;

  if (lower.includes("audio")) score -= 50;
  if (lower.includes("subtitle")) score -= 50;

  return score;
}

async function shouldRedownloadVideo(filePath) {
  if (!(await fs.pathExists(filePath))) return true;

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) return true;

  const duration = await getVideoDurationSec(filePath);
  return !Number.isFinite(duration) || duration <= BAD_DURATION_SEC;
}

async function getVideoDurationSec(filePath) {
  if (!(await fs.pathExists(filePath))) return 0;

  return new Promise((resolve) => {
    const ffprobeBin = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const proc = spawn(
      ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { shell: false },
    );

    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });

    proc.on("error", () => resolve(0));
    proc.on("close", () => {
      const value = Number(String(out).trim());
      resolve(Number.isFinite(value) ? value : 0);
    });
  });
}

function downloadWithFfmpeg(mediaUrl, outputPath, referer, cookies = []) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const headers = [];
    if (cookieStr) headers.push(`Cookie: ${cookieStr}`);
    if (referer) headers.push(`Referer: ${referer}`);
    if (process.env.BASE_URL) headers.push(`Origin: ${process.env.BASE_URL}`);

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-stats",
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
      "-headers",
      headers.join("\r\n") + "\r\n",
      "-i",
      mediaUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-sn",
      "-dn",
      "-c",
      "copy",
    ];

    if (mediaUrl.includes(".m3u8")) {
      args.push("-bsf:a", "aac_adtstoasc");
    }

    args.push("-movflags", "+faststart");
    args.push("-y", outputPath.replace(/\\/g, "/"));

    const child = spawn(ffmpegBin, args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) =>
      reject(new Error(`ffmpeg launch error: ${err.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

async function tryStartPlayback(page) {
  const muxPlayer = page.locator("mux-player").first();
  if (await muxPlayer.count().catch(() => 0)) {
    await muxPlayer.scrollIntoViewIfNeeded().catch(() => {});
    await muxPlayer.click({ force: true, timeout: 2000 }).catch(() => {});
  }

  const video = page.locator("video").first();
  if (await video.count().catch(() => 0)) {
    await video.scrollIntoViewIfNeeded().catch(() => {});
    await video.click({ force: true, timeout: 2000 }).catch(() => {});
  }

  const playButtonSelectors = [
    'button[aria-label*="Play" i]',
    '[role="button"][aria-label*="Play" i]',
    "mux-player",
  ];

  for (const selector of playButtonSelectors) {
    const loc = page.locator(selector).first();
    const count = await loc.count().catch(() => 0);

    if (count > 0) {
      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      break;
    }
  }

  await page
    .evaluate(() => {
      const v = document.querySelector("video");
      if (v) {
        v.muted = true;
        const p = v.play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    })
    .catch(() => {});

  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(1800);
}

async function captureRealVideoUrl(context, url) {
  const page = await context.newPage();

  const found = {
    pageUrl: url,
    videoUrl: null,
    currentSrc: null,
    muxSrc: null,
    allMediaCandidates: [],
  };

  const seen = new Set();

  const remember = (candidateUrl, source) => {
    if (!candidateUrl) return;
    if (seen.has(candidateUrl)) return;
    if (!looksLikeVideo(candidateUrl)) return;

    seen.add(candidateUrl);

    found.allMediaCandidates.push({
      url: candidateUrl,
      source,
    });

    if (!found.videoUrl) {
      found.videoUrl = candidateUrl;
    }
  };

  page.on("response", async (response) => {
    try {
      const responseUrl = response.url();
      const type = (response.headers()["content-type"] || "").toLowerCase();

      if (
        looksLikeVideo(responseUrl) ||
        type.startsWith("video/") ||
        type.includes("application/vnd.apple.mpegurl") ||
        type.includes("application/x-mpegurl")
      ) {
        remember(responseUrl, `response:${type || "unknown"}`);
      }
    } catch {}
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(2500);
    await waitForAnyVideoPresence(page, 20000);
    await tryStartPlayback(page);

    const deadline = Date.now() + 25000;

    while (Date.now() < deadline) {
      const mux = await readMuxPlayerState(page);
      if (mux?.src) {
        found.muxSrc = mux.src;
        remember(mux.src, "mux-player.src");
      }

      const direct = await readVideoState(page);
      if (direct?.src) {
        found.currentSrc = direct.src;
        remember(direct.src, "video.currentSrc");
      }

      const perfUrls = await readPerformanceUrls(page);
      for (const perfUrl of perfUrls) {
        remember(perfUrl, "performance");
      }

      if (found.videoUrl) break;

      await page.waitForTimeout(700);
    }

    return found;
  } finally {
    await page.close().catch(() => {});
  }
}

async function waitForAnyVideoPresence(page, timeoutMs = 12000) {
  const selectors = [
    "mux-player",
    "video",
    "iframe",
    '[aria-label*="Play" i]',
    'button[aria-label*="Play" i]',
  ];

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      const count = await page
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count > 0) return;
    }

    await page.waitForTimeout(400);
  }
}

function looksLikeVideo(url) {
  if (!url) return false;

  const u = String(url).toLowerCase();

  const blocked = [
    "sentry.io",
    "posthog",
    "customer.io",
    "intercom",
    "facebook.net",
    "tiktok",
    "analytics",
    "fonts/",
    "/_next/static/",
    "/_next/data/",
    ".js",
    ".css",
    ".ttf",
    ".woff",
    ".woff2",
    ".webp",
    ".png",
    ".jpg",
    ".jpeg",
    "storyboard",
    "404.json",
  ];

  if (blocked.some((x) => u.includes(x))) return false;

  return (
    /https:\/\/stream\.mux\.com\/.+\.m3u8/i.test(url) ||
    /https:\/\/stream\.mux\.com\/.+\.mp4/i.test(url) ||
    /\.m3u8(\?|$)/i.test(url) ||
    /\.mp4(\?|$)/i.test(url) ||
    /master\.m3u8/i.test(url) ||
    /playlist\.m3u8/i.test(url)
  );
}
