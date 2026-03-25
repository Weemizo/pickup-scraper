import { chromium } from "playwright";
import fs from "fs-extra";
import path from "path";
import { createAuthContext } from "./auth.js";
import { toSlug, lessonOutputDir, log } from "./utils.js";
import * as dotenv from "dotenv";

dotenv.config();

const SLOW_MS = 900;
const BASE_COURSE_URL = `${process.env.BASE_URL}${process.env.COURSE_PATH}`;
const SCRAPE_GRADE_FILTER = normalizeText(process.env.SCRAPE_GRADE || "");
const SCRAPE_DAY_FILTER = normalizeText(process.env.SCRAPE_DAY || "");

async function saveCourseSnapshot(course) {
  await fs.writeJson("./output/course.json", course, { spaces: 2 });
}

function upsertGrade(course, gradeOut) {
  const idx = (course.grades || []).findIndex(
    (g) =>
      normalizeText(g.gradeNum || "") ===
      normalizeText(gradeOut.gradeNum || ""),
  );

  if (idx >= 0) {
    course.grades[idx] = gradeOut;
  } else {
    course.grades.push(gradeOut);
  }
}

function isGradedLessonUrl(url = '') {
  return /\/class\/[^/]+\/grade\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url);
}

function isPlaylistLessonUrl(url = '') {
  return /\/class\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url);
}

function isAnyLessonUrl(url = '') {
  return isGradedLessonUrl(url) || isPlaylistLessonUrl(url);
}

function isGradedOverviewUrl(url = '') {
  return /\/class\/[^/]+\/grade\/[^/]+$/.test(url);
}

function isPlaylistOverviewUrl(url = '') {
  return /\/class\/[^/]+$/.test(url);
}

export async function scrapeCourse() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 40,
  });

  const context = await createAuthContext(browser);
  const page = await context.newPage();
  wireBrowserLogs(page);

  try {
    await fs.ensureDir("./output");
    await gotoCourseOverview(page);
                const courseKind = await detectCourseKind(page);
            log('ℹ️', `Wykryty typ kursu: ${courseKind}`);

    const course = {
    title: process.env.COURSE_TITLE || 'Pickup Music Course',
    scrapedAt: new Date().toISOString(),
    kind: courseKind,
    grades: []
  };

  if (courseKind === 'pathway') {
    const grades = await extractGradeStructure(page);
    log('✅', `Znaleziono ${grades.length} gradów`);

  // zostawiasz tutaj swój dotychczasowy kod pathway 1:1

    course.title =
      process.env.COURSE_TITLE || course.title || "Learning Pathway";
    course.scrapedAt = new Date().toISOString();
    if (!Array.isArray(course.grades)) course.grades = [];

    for (const grade of grades) {
      const gradeFilterText = normalizeText(
        `${grade.gradeNum} ${grade.gradeTitle || ""}`,
      );
      if (
        SCRAPE_GRADE_FILTER &&
        !gradeFilterText.includes(SCRAPE_GRADE_FILTER)
      ) {
        continue;
      }

      const gradeSlug = toSlug(grade.gradeNum);
      const gradeOut = {
        gradeNum: grade.gradeNum,
        gradeTitle: grade.gradeTitle,
        gradeSlug,
        lessons: [],
      };

      upsertGrade(course, gradeOut);
      await saveCourseSnapshot(course);

      try {
        await gotoCourseOverview(page);
        const expanded = await expandGradeAccordion(
          page,
          grade.gradeNum,
          grade.gradeTitle,
        );
        if (!expanded) {
          throw new Error(`Nie udało się rozwinąć ${grade.gradeNum}`);
        }
        await page.waitForTimeout(1000);
      } catch (err) {
        log("❌", `Grade failed: ${grade.gradeNum}: ${err.message}`);
        await saveCourseSnapshot(course);
        continue;
      }

      for (const lesson of grade.lessons) {
        const lessonFilterText = normalizeText(`${lesson.day} ${lesson.title}`);
        if (
          SCRAPE_DAY_FILTER &&
          !lessonFilterText.includes(SCRAPE_DAY_FILTER)
        ) {
          continue;
        }
        const lessonSlug = toSlug(`${lesson.day}-${lesson.title}`);
        const outDir = lessonOutputDir(gradeSlug, lessonSlug);
        await fs.ensureDir(outDir);
        await cleanupLessonDir(outDir);

        log("  📝", `${lesson.day}: ${lesson.title}`);

        try {
          await openExactLesson(page, grade, lesson);

          const url = page.url();
          log("  🔗", url);

          await resetLessonViewport(page);
          const notationPdf = await downloadLessonNotationPdf(page, outDir);

          await resetLessonViewport(page);
          const tabs = await getTopTabs(page);

          const units = [];
          for (const tab of tabs) {
            if (tab.disabled) continue;

            if (!tab.synthetic) {
              await openTab(page, tab.index);
              await waitForPanelStable(page, tab.label || tab.heading || "tab");
            } else {
              await page.waitForTimeout(600);
            }

            const panel = await extractCurrentPanel(
              page,
              tab.label || tab.heading || "Lesson",
            );

            const notationShots = await captureNotationScreenshots(
              page,
              outDir,
              toSlug(tab.label || tab.heading || "lesson"),
            );

            units.push({
              label: tab.label || null,
              heading: tab.heading || null,
              subtitle: tab.subtitle || null,
              url: page.url(),
              descriptions: panel.descriptions,
              htmlBlocks: panel.htmlBlocks,
              notationShots,
            });
          }

          const lessonUnit =
            units.find(
              (u) => normalizeText(u.label || u.heading || "") === "lesson",
            ) ||
            units[0] ||
            null;

          const exerciseUnits = units.filter(
            (u) => normalizeText(u.label || u.heading || "") !== "lesson",
          );

          const markdown = buildLessonMarkdown({
            grade,
            lesson,
            url,
            notationPdf,
            lessonUnit,
            exerciseUnits,
          });

          const html = buildLessonHtml({
            grade,
            lesson,
            url,
            notationPdf,
            lessonUnit,
            exerciseUnits,
          });

          await fs.writeFile(path.join(outDir, "lesson.md"), markdown, "utf8");
          await fs.writeFile(path.join(outDir, "lesson.html"), html, "utf8");

          gradeOut.lessons.push({
            day: lesson.day,
            title: lesson.title,
            slug: lessonSlug,
            url,
            outputDir: outDir,
            notationPdf: notationPdf || null,
            units: units.map((u) => ({
              label: u.label,
              heading: u.heading,
              subtitle: u.subtitle,
              url: u.url,
              notationShots: u.notationShots,
            })),
          });
        } catch (err) {
          log("  ❌", `Błąd: ${err.message}`);

          gradeOut.lessons.push({
            day: lesson.day,
            title: lesson.title,
            slug: lessonSlug,
            outputDir: outDir,
            error: err.message,
          });

          try {
            await gotoCourseOverview(page);
            await expandGradeAccordion(page, grade.gradeNum, grade.gradeTitle);
            await page.waitForTimeout(1000);
          } catch {}
        }

        await saveCourseSnapshot(course);
        await delay();
      }

      await saveCourseSnapshot(course);
      await delay(1200);
    }
  } else if (courseKind === 'playlist') {
  const playlist = await extractPlaylistStructure(page);
  log('✅', `Znaleziono ${playlist.lessons.length} dni w playliście`);

  const pseudoGrade = {
    gradeNum: 'Playlist',
    gradeTitle: playlist.title || course.title,
    gradeSlug: 'playlist',
    typeLabel: playlist.typeLabel || 'Challenge',
    performances: playlist.performances || [],
    lessons: []
  };

  for (const lesson of playlist.lessons) {
    const lessonFilterText = normalizeText(`${lesson.day} ${lesson.title}`);
    if (SCRAPE_DAY_FILTER && !lessonFilterText.includes(SCRAPE_DAY_FILTER)) {
      continue;
    }

    const lessonSlug = toSlug(`${lesson.day}-${lesson.title}`);
    const outDir = lessonOutputDir('playlist', lessonSlug);
    await fs.ensureDir(outDir);
    await cleanupLessonDir(outDir);

    log('  📝', `${lesson.day}: ${lesson.title}`);

    try {
      await gotoCourseOverview(page);
      await openPlaylistLessonFromSidebar(page, lesson);
      await waitForLessonStable(page, lesson);

      const validation = await validateLessonView(page, lesson);
      if (!validation.accepted) {
        throw new Error(`Widok nie zgadza się z playlist lesson: ${JSON.stringify(validation)}`);
      }

      const url = page.url();
      log('  🔗', url);

      await resetLessonViewport(page);
      const notationPdf = await downloadLessonNotationPdf(page, outDir);

      await resetLessonViewport(page);
      const header = await extractPageHeader(page);
      const menuOptions = await extractHeaderMenuOptions(page);
      const tabs = await getTopTabs(page);

      await activateTopTab(page, 'Lesson').catch(() => {});
      const lessonUnit = await extractLessonPanel(page, outDir, 'lesson');
      const exerciseUnits = await extractExercisePanels(page, outDir);

      const markdown = buildLessonMarkdown({
        grade: { gradeNum: 'Playlist', gradeTitle: playlist.title || course.title },
        lesson,
        url,
        notationPdf,
        lessonUnit,
        exerciseUnits,
      });

      const html = buildLessonHtml({
        grade: { gradeNum: 'Playlist', gradeTitle: playlist.title || course.title },
        lesson,
        url,
        notationPdf,
        lessonUnit,
        exerciseUnits,
      });

      const meta = {
        kind: 'playlist',
        playlistTitle: playlist.title || course.title,
        typeLabel: playlist.typeLabel || 'Challenge',
        day: lesson.day,
        title: lesson.title,
        ariaLabel: lesson.ariaLabel || null,
        slug: lessonSlug,
        outputDir: outDir,
        url,
        notationPdf: notationPdf || null,
        validation,
        header,
        menuOptions,
        tabs,
        lessonUnit,
        exerciseUnits,
      };

      await fs.writeJson(path.join(outDir, 'meta.json'), meta, { spaces: 2 });
      await fs.writeFile(path.join(outDir, 'lesson.md'), markdown, 'utf8');
      await fs.writeFile(path.join(outDir, 'lesson.html'), html, 'utf8');

      pseudoGrade.lessons.push({
        day: lesson.day,
        title: lesson.title,
        slug: lessonSlug,
        url,
        outputDir: outDir,
        notationPdf: notationPdf || null,
        units: [lessonUnit, ...exerciseUnits].filter(Boolean).map((u) => ({
          label: u.label || null,
          heading: u.heading || null,
          subtitle: u.subtitle || null,
          url,
          notationShots: u.notationShots || [],
        })),
      });
    } catch (err) {
      log('  ❌', `Błąd: ${err.message}`);

      const failed = {
        kind: 'playlist',
        day: lesson.day,
        title: lesson.title,
        slug: lessonSlug,
        outputDir: outDir,
        error: err.message,
      };

      await fs.writeJson(path.join(outDir, 'meta.json'), failed, { spaces: 2 });
      pseudoGrade.lessons.push(failed);
    }

    await saveCourseSnapshot({ ...course, grades: [...course.grades, pseudoGrade] });
    await delay();
  }

  course.grades.push(pseudoGrade);
}
else {
  throw new Error('Nie udało się rozpoznać typu kursu.');
}

    await fs.writeJson("./output/course.json", course, { spaces: 2 });
    log("💾", "Zapisano → output/course.json");
    return course;
  } finally {
    await browser.close();
  }
}

function wireBrowserLogs(page) {
  page.on("console", (msg) => {
    const text = msg.text() || "";
    const ignored = [
      "screen-wake-lock is not allowed in this document",
      "Failed to load resource: the server responded with a status of 429",
    ];

    if (msg.type() === "error" && !ignored.some((x) => text.includes(x))) {
      log("🔴", `Browser: ${text}`);
    }
  });

  page.on("response", (resp) => {
    const status = resp.status();
    const url = resp.url();
    const ignore =
      url.includes("sentry.io") ||
      url.includes("/avatar.png?token=") ||
      url.includes("/api/functions/v1/playlists?") ||
      (status === 404 && url === BASE_COURSE_URL);

    if (status >= 400 && !ignore) {
      log("🟠", `${status} ${url.slice(0, 180)}`);
    }
  });
}

async function waitForCourseShell(page) {
  await page.waitForFunction(
    () => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const hasMain = !!document.querySelector("main");
      const hasOverviewButton = !!document.querySelector(
        'button[aria-label="Class overview"]',
      );
      const hasGradeAccordion = !!document.querySelector('[role="menuitem"]');
      const hasLessonButtons = Array.from(
        document.querySelectorAll('button[aria-label]'),
      ).some((btn) => /day \d+/i.test(clean(btn.innerText || btn.textContent || "")));
      const text = clean(document.body?.innerText || "");
      const hasPlaylistOverview = text.includes('Lessons') && /Day 1/i.test(text);
      const hasPathwayHeading = Array.from(
        document.querySelectorAll('h1,[role="heading"],[dir="auto"]'),
      ).some((el) => /^Grade \d+$/i.test(clean(el.textContent || "")));

      return (
        hasMain &&
        (hasOverviewButton || hasGradeAccordion || hasLessonButtons || hasPlaylistOverview || hasPathwayHeading)
      );
    },
    { timeout: 30000 },
  );

  await page.waitForTimeout(1500);
}

async function waitForOverviewReady(page) {
  await page.waitForFunction(
    () => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const url = location.href;
      const urlOk =
        /\/class\/[^/]+$/.test(url) ||
        /\/class\/[^/]+\/overview$/.test(url) ||
        /\/class\/[^/]+\/grade\/[^/]+$/.test(url) ||
        /\/class\/[^/]+\/grade\/[^/]+\/overview$/.test(url);

      const lessonButtons = Array.from(
        document.querySelectorAll('button[aria-label]'),
      ).filter((btn) => /day \d+/i.test(clean(btn.innerText || btn.textContent || "")));

      const hasGradeAccordion = !!document.querySelector('[role="menuitem"]');
      const hasLessonList = lessonButtons.length > 0;
      return urlOk && (hasGradeAccordion || hasLessonList);
    },
    { timeout: 20000 },
  ).catch(() => {});

  await page.waitForTimeout(800);
}

async function gotoCourseOverview(page) {
  log("🌐", "Otwieram stronę kursu...");
  await page.goto(BASE_COURSE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await waitForCourseShell(page);

  const overviewButton = page
    .locator('button[aria-label="Class overview"]')
    .first();

  if (await overviewButton.count()) {
    await overviewButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  await waitForOverviewReady(page);
}

async function extractPageHeader(page) {
  return page.evaluate(() => {
    const clean = (s) => s?.replace(/\s+/g, ' ').trim() || null;
    const headings = Array.from(
      document.querySelectorAll('main h1, main h2, main h3, main [role="heading"]')
    )
      .map((el) => clean(el.textContent))
      .filter(Boolean);

    return {
      gradeHeading: headings.find((t) => /^Grade \d+\./.test(t)) || null,
      lessonHeading: headings.find((t) => /^Day \d+\./.test(t)) || null,
      pageHeading: headings[0] || null
    };
  });
}

async function detectCourseKind(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const allText = clean(document.body?.innerText || '');

    const hasGrades = Array.from(document.querySelectorAll('h1,[role="heading"],div[dir="auto"]'))
      .map((el) => clean(el.textContent))
      .some((t) => /^Grade \d+$/i.test(t));

    if (hasGrades) return 'pathway';

    const hasChallengeBadge = Array.from(document.querySelectorAll('[dir="auto"], h1, h2, h3'))
      .map((el) => clean(el.textContent))
      .some((t) => t === 'Challenge');

    const hasLessonsList = /Lessons/.test(allText) && /Day 1/.test(allText);

    if (hasChallengeBadge || hasLessonsList) return 'playlist';

    return 'unknown';
  });
}

async function extractGradeStructure(page) {
  return page.evaluate(() => {
    const clean = (s) => s?.replace(/\s+/g, " ").trim() || "";
    const grades = [];

    for (const item of Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    )) {
      const headings = Array.from(item.querySelectorAll('h1,[role="heading"]'))
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      const gradeNum = headings.find((t) => /^Grade \d+$/.test(t));
      if (!gradeNum) continue;

      const gradeTitle =
        headings.find(
          (t) => t !== gradeNum && t !== "Lessons" && t !== "Performances",
        ) || null;
      const lessons = [];
      const seen = new Set();

      for (const btn of Array.from(
        item.querySelectorAll("button[aria-label]"),
      )) {
        const parts = Array.from(
          btn.querySelectorAll('[dir="auto"], h1, h2, h3'),
        )
          .map((el) => clean(el.textContent))
          .filter(Boolean);

        const day = parts.find((t) => /^Day \d+$/.test(t));
        const title = parts.find(
          (t) => t !== day && t !== "Lessons" && t !== "Performances",
        );
        if (!day || !title) continue;

        const key = `${day}__${title}`;
        if (seen.has(key)) continue;
        seen.add(key);

        lessons.push({
          day,
          title,
          ariaLabel: clean(btn.getAttribute("aria-label")),
        });
      }

      grades.push({ gradeNum, gradeTitle, lessons });
    }

    return grades;
  });
}

async function extractPlaylistStructure(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const title =
      Array.from(document.querySelectorAll('h1,[role="heading"]'))
        .map((el) => clean(el.textContent))
        .find(
          (t) =>
            t &&
            t !== 'Class overview' &&
            t !== 'Lessons' &&
            t !== 'Performances' &&
            t !== 'Challenge' &&
            t !== 'Playlist' &&
            !/^Day \d+/i.test(t),
        ) || null;

    const typeLabel =
      Array.from(document.querySelectorAll('[dir="auto"], h1, h2, h3'))
        .map((el) => clean(el.textContent))
        .find((t) => t === 'Challenge' || t === 'Playlist') ||
      null;

    const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
    const lessons = [];
    const performances = [];
    const seenLessons = new Set();
    const seenPerf = new Set();

    for (const btn of buttons) {
      const aria = clean(btn.getAttribute('aria-label'));
      const texts = Array.from(btn.querySelectorAll('[dir="auto"], h1, h2, h3'))
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      const day = texts.find((t) => /^Day \d+$/i.test(t));
      const itemTitle = texts.find((t) => t !== day);

      if (day && itemTitle) {
        const key = `${day}__${itemTitle}`;
        if (!seenLessons.has(key)) {
          seenLessons.add(key);
          lessons.push({
            day,
            title: itemTitle,
            ariaLabel: aria || itemTitle,
          });
        }
        continue;
      }

      if (texts.length >= 2) {
        const perfName = texts[0];
        const artist = texts[1];
        const ignored = [
          'Lessons',
          'Performances',
          'Class overview',
          'Start class',
          'Complete class',
          'Challenge',
          'Playlist',
        ];

        if (!ignored.includes(perfName) && !ignored.includes(artist)) {
          const key = `${perfName}__${artist}`;
          if (!seenPerf.has(key)) {
            seenPerf.add(key);
            performances.push({
              title: perfName,
              artist,
              ariaLabel: aria || perfName,
            });
          }
        }
      }
    }

    return {
      title,
      typeLabel,
      lessons,
      performances,
    };
  });
}


async function waitForLessonStable(page, lesson = null) {
  await waitForLessonShell(page);

  await page.waitForFunction(
    ({ day, title }) => {
      const normalize = (s = '') => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const text = normalize(document.body?.innerText || '');
      const url = location.href;
      const urlOk =
        /\/class\/[^/]+\/grade\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url) ||
        /\/class\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url);
      const hasPlayer =
        !!document.querySelector('main mux-player') ||
        !!document.querySelector('main video') ||
        !!document.querySelector('main iframe[src*="soundslice"]') ||
        !!document.querySelector('main [src*=".m3u8"]');
      const hasTabs = !!document.querySelector('[role="tab"]');
      const hasUi =
        hasPlayer ||
        hasTabs ||
        text.includes('complete lesson') ||
        text.includes('complete class') ||
        text.includes('start class');
      const hasDay = !!day && text.includes(normalize(String(day)));
      const hasTitle = !!title && text.includes(normalize(String(title)));
      return urlOk && hasUi && (!day && !title ? true : hasDay || hasTitle);
    },
    lesson || {},
    { timeout: 25000 },
  ).catch(() => {});

  await page.waitForTimeout(1200);
}

async function activateTopTab(page, tabLabel) {
  const wanted = normalizeText(tabLabel || '');
  const tabs = await getTopTabs(page);
  const tab = tabs.find((t) => normalizeText(t.label || t.heading || '') === wanted);

  if (!tab) return false;
  if (!tab.synthetic) {
    await openTab(page, tab.index);
    await waitForPanelStable(page, tab.label || tab.heading || tabLabel || 'tab');
  } else {
    await resetLessonViewport(page);
    await page.waitForTimeout(500);
  }

  return true;
}

async function extractLessonPanel(page, outDir, prefix = 'lesson') {
  const tabs = await getTopTabs(page).catch(() => []);
  const lessonTab = tabs.find((t) => normalizeText(t.label || t.heading || '') === 'lesson') || tabs[0] || null;

  if (lessonTab && !lessonTab.synthetic) {
    await openTab(page, lessonTab.index);
    await waitForPanelStable(page, lessonTab.label || lessonTab.heading || 'Lesson');
  } else {
    await resetLessonViewport(page);
  }

  const panel = await extractCurrentPanel(page, lessonTab?.label || lessonTab?.heading || 'Lesson');
  const notationShots = await captureNotationScreenshotsForCurrentView(
    page,
    outDir,
    toSlug(prefix || lessonTab?.label || lessonTab?.heading || 'lesson'),
  );

  return {
    label: lessonTab?.label || 'Lesson',
    heading: lessonTab?.heading || 'Lesson',
    subtitle: lessonTab?.subtitle || null,
    descriptions: panel.descriptions || [],
    htmlBlocks: panel.htmlBlocks || [],
    notationShots,
  };
}

async function captureNotationScreenshotsForCurrentView(page, outDir, prefix = 'lesson') {
  await resetLessonViewport(page);
  return captureNotationScreenshots(page, outDir, prefix);
}

async function extractExercisePanels(page, outDir) {
  const tabs = await getTopTabs(page).catch(() => []);
  const exerciseTabs = tabs.filter(
    (t) => !t.disabled && normalizeText(t.label || t.heading || '') !== 'lesson',
  );

  const units = [];
  for (const tab of exerciseTabs) {
    if (!tab.synthetic) {
      await openTab(page, tab.index);
      await waitForPanelStable(page, tab.label || tab.heading || 'Exercise');
    } else {
      await resetLessonViewport(page);
      await page.waitForTimeout(500);
    }

    const panel = await extractCurrentPanel(page, tab.label || tab.heading || 'Exercise');
    const notationShots = await captureNotationScreenshotsForCurrentView(
      page,
      outDir,
      toSlug(tab.label || tab.heading || 'exercise'),
    );

    units.push({
      label: tab.label || null,
      heading: tab.heading || null,
      subtitle: tab.subtitle || null,
      descriptions: panel.descriptions || [],
      htmlBlocks: panel.htmlBlocks || [],
      notationShots,
    });
  }

  return units;
}

async function extractHeaderMenuOptions(page) {
  const opened = await openLessonOptionsMenu(page).catch(() => false);
  if (!opened) return [];

  const options = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 20 && r.height > 12;
    };

    return Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a, div'))
      .filter(visible)
      .map((el) => clean(el.textContent || el.getAttribute('aria-label') || ''))
      .filter(Boolean)
      .filter((text) => /download|notation|pdf/i.test(text))
      .slice(0, 10);
  }).catch(() => []);

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return [...new Set(options)];
}

async function openExactLesson(page, grade, lesson) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        await gotoCourseOverview(page);

        const expanded = await expandGradeAccordion(
          page,
          grade.gradeNum,
          grade.gradeTitle,
        );
        if (!expanded) {
          throw new Error(`Nie udało się rozwinąć ${grade.gradeNum}`);
        }

        await page.waitForTimeout(900);
      }

      const clicked = await clickLessonInGrade(
        page,
        grade.gradeNum,
        grade.gradeTitle,
        lesson.title,
        lesson.ariaLabel,
      );

      if (!clicked) {
        throw new Error(`Brak skutecznego kliknięcia lesson: ${lesson.title}`);
      }

      await page.waitForFunction(
        ({ day, title }) => {
          const txt = (document.querySelector("main")?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

          return (
            /\/lesson\/[^/]+/.test(location.href) &&
            txt.includes((day || "").toLowerCase()) &&
            txt.includes((title || "").toLowerCase())
          );
        },
        lesson,
        { timeout: 20000 },
      );

      await page.waitForTimeout(1800);

      const ok = await validateLessonView(page, lesson);
      if (!ok.accepted) {
        throw new Error(`Widok nie zgadza się z lesson: ${JSON.stringify(ok)}`);
      }

      return;
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(1200 + attempt * 600);
    }
  }

  throw (
    lastError || new Error(`Nie udało się otworzyć lesson: ${lesson.title}`)
  );
}

async function expandGradeAccordion(page, gradeNum, gradeTitle) {
  const ok = await page.evaluate(
    ({ gradeNum, gradeTitle }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));

      const container = items.find((item) => {
        const text = norm(item.innerText || item.textContent || "");
        return (
          text.includes(norm(gradeNum)) &&
          (!gradeTitle || text.includes(norm(gradeTitle)))
        );
      });

      if (!container) return false;
      if (/day 1/i.test(container.innerText || "")) return true;

      container.scrollIntoView({ block: "center" });

      const buttons = Array.from(container.querySelectorAll("button"));
      const toggle =
        buttons.find((btn) => {
          const aria = norm(btn.getAttribute("aria-label"));
          const txt = norm(btn.innerText || btn.textContent || "");
          return (
            aria.includes("expand") ||
            aria.includes("collapse") ||
            (btn.querySelector("svg") && txt === "")
          );
        }) ||
        buttons[buttons.length - 1] ||
        container;

      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    },
    { gradeNum, gradeTitle },
  );

  if (!ok) return false;

  await page
    .waitForFunction(
      ({ gradeNum, gradeTitle }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"]'),
        );
        const container = items.find((item) => {
          const text = norm(item.innerText || item.textContent || "");
          return (
            text.includes(norm(gradeNum)) &&
            (!gradeTitle || text.includes(norm(gradeTitle)))
          );
        });
        return !!container && /day 1/i.test(container.innerText || "");
      },
      { gradeNum, gradeTitle },
      { timeout: 8000 },
    )
    .catch(() => {});

  return true;
}

async function clickLessonInGrade(
  page,
  gradeNum,
  gradeTitle,
  lessonTitle,
  ariaLabel,
) {
  const clicked = await page.evaluate(
    ({ gradeNum, gradeTitle, lessonTitle, ariaLabel }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));

      const container = items.find((item) => {
        const text = norm(item.innerText || item.textContent || "");
        return (
          text.includes(norm(gradeNum)) &&
          (!gradeTitle || text.includes(norm(gradeTitle)))
        );
      });
      if (!container) return false;

      const buttons = Array.from(
        container.querySelectorAll("button[aria-label]"),
      );
      const exact = buttons.find(
        (btn) => norm(btn.getAttribute("aria-label")) === norm(ariaLabel || ""),
      );
      const byTitle = buttons.find((btn) => {
        const text = norm(btn.innerText || btn.textContent || "");
        return text.includes(norm(lessonTitle));
      });

      const target = exact || byTitle;
      if (!target) return false;

      target.scrollIntoView({ block: "center" });
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    },
    { gradeNum, gradeTitle, lessonTitle, ariaLabel },
  );

  if (!clicked) return false;
  await page.waitForTimeout(1200);
  return true;
}

async function validateLessonView(page, lesson) {
  return page.evaluate(({ day, title }) => {
    const normalize = (s = '') => s.replace(/\s+/g, ' ').trim().toLowerCase();

    const pageText = normalize(document.body?.innerText || '');
    const url = location.href;

    const urlOk =
      /\/class\/[^/]+\/grade\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url) ||
      /\/class\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url);

    const hasDay = !!day && pageText.includes(normalize(day || ''));
    const hasTitle = !!title && pageText.includes(normalize(title || ''));

    const hasUi =
      !!document.querySelector('[role="tab"]') ||
      !!document.querySelector('main iframe[src*="soundslice"]') ||
      !!document.querySelector('main video') ||
      !!document.querySelector('main mux-player') ||
      !!document.querySelector('main [src*=".m3u8"]') ||
      pageText.includes('complete lesson') ||
      pageText.includes('performances') ||
      pageText.includes('start class') ||
      pageText.includes('complete class');

    return {
      urlOk,
      hasDay,
      hasTitle,
      hasUi,
      accepted: urlOk && hasUi && (!day && !title ? true : hasDay || hasTitle),
    };
  }, lesson);
}

async function getTopTabs(page) {
  const realTabs = await page.locator('[role="tab"]').evaluateAll((nodes) => {
    const clean = (s) => s?.replace(/\s+/g, " ").trim() || "";
    return nodes.map((tab, index) => {
      const texts = Array.from(
        tab.querySelectorAll('[dir="auto"], h1, h2, h3, [role="heading"]')
      )
        .map((el) => clean(el.textContent))
        .filter(Boolean);

      return {
        index,
        label: clean(tab.getAttribute("aria-label")) || texts[0] || `tab-${index + 1}`,
        heading: texts[0] || null,
        subtitle: texts[1] || null,
        disabled: tab.getAttribute("aria-disabled") === "true",
        synthetic: false,
      };
    });
  });

  if (realTabs.length) return realTabs;

  const synthetic = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return [];

    const hasStandaloneLesson =
      !!main.querySelector("mux-player") ||
      !!main.querySelector("video") ||
      !!main.querySelector("iframe") ||
      !!Array.from(main.querySelectorAll("button, [role='button']")).find((el) => {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        return (
          txt.includes("complete lesson") ||
          aria.includes("complete lesson") ||
          txt.includes("performances") ||
          aria.includes("performances")
        );
      });

    if (!hasStandaloneLesson) return [];

    return [
      {
        index: -1,
        label: "Lesson",
        heading: "Lesson",
        subtitle: null,
        disabled: false,
        synthetic: true,
      },
    ];
  });

  return synthetic;
}

async function exitFullscreenIfNeeded(page) {
  const isFs = await page
    .evaluate(() => !!document.fullscreenElement)
    .catch(() => false);

  if (!isFs) return;

  await page
    .evaluate(async () => {
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await document.exitFullscreen();
        } catch {}
      }
    })
    .catch(() => {});

  await page.waitForTimeout(300);
}

async function resetLessonViewport(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await exitFullscreenIfNeeded(page);

  await page
    .evaluate(() => {
      try {
        document.activeElement?.blur?.();
      } catch {}

      try {
        window.scrollTo(0, 0);
      } catch {}

      try {
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        if (document.documentElement) document.documentElement.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
      } catch {}
    })
    .catch(() => {});

  await page.waitForTimeout(350);
}

async function openTab(page, index) {
  await resetLessonViewport(page);

  const clicked = await page
    .evaluate(
      ({ index }) => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const tab = tabs[index];
        if (!tab) return false;

        tab.scrollIntoView({ block: "center", inline: "center" });
        tab.click();
        return true;
      },
      { index },
    )
    .catch(() => false);

  if (!clicked) {
    const tab = page.locator('[role="tab"]').nth(index);
    await tab.scrollIntoViewIfNeeded().catch(() => {});
    await tab.click().catch(() => {});
  }

  await page.waitForTimeout(900);
  await exitFullscreenIfNeeded(page);
  await page.keyboard.press("Escape").catch(() => {});
}

async function waitForPanelStable(page, expectedText) {
  const norm = normalizeText(expectedText || "");

  await page
    .waitForFunction(
      ({ norm }) => {
        const txt = (document.querySelector("main")?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

        return !norm || txt.includes(norm);
      },
      { norm },
      { timeout: 12000 },
    )
    .catch(() => {});

  await exitFullscreenIfNeeded(page);
  await page.waitForTimeout(900);
}

async function extractCurrentPanel(page, expectedHeading) {
  return page.evaluate(({ expectedHeading }) => {
    const clean = (s) => s?.replace(/\s+/g, " ").trim() || "";
    const norm = (s) => clean(s).toLowerCase();

    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && r.width > 40 && r.height > 18;
    };

    const uniq = (arr) => [...new Set(arr.map(clean).filter(Boolean))];
    const main = document.querySelector("main") || document.body;
    const wanted = norm(expectedHeading);

    let root = null;

    const hasTabs = !!main.querySelector('[role="tab"]');

    if (hasTabs) {
      const anchors = Array.from(
        main.querySelectorAll("h1,h2,h3,[role='heading'],[dir='auto']")
      ).filter(visible);

      for (const anchor of anchors) {
        const text = norm(anchor.textContent);
        if (!text || (wanted && !text.includes(wanted))) continue;

        let cur = anchor.parentElement;
        for (let i = 0; i < 8 && cur; i++) {
          const textNodes = Array.from(cur.querySelectorAll("[dir='auto'], p, li")).filter(visible);
          const mediaNodes = Array.from(cur.querySelectorAll("iframe, img, canvas, svg, mux-player, video")).filter(visible);

          if (textNodes.length >= 2 || mediaNodes.length >= 1) {
            root = cur;
            break;
          }
          cur = cur.parentElement;
        }
        if (root) break;
      }
    }

    if (!root) {
      const media =
        main.querySelector("mux-player") ||
        main.querySelector("video") ||
        main.querySelector("iframe");

      if (media) {
        let cur = media.parentElement;
        for (let i = 0; i < 10 && cur; i++) {
          const textNodes = Array.from(cur.querySelectorAll("[dir='auto'], p, li")).filter(visible);
          const imageNodes = Array.from(cur.querySelectorAll("img")).filter(visible);

          if (textNodes.length >= 3 || imageNodes.length >= 1) {
            root = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }
    }

    if (!root) root = main;

    const commentsHeading = Array.from(
      root.querySelectorAll("h1,h2,h3,[role='heading'],[dir='auto']")
    ).find((el) => visible(el) && norm(el.textContent) === "comments");

    const shouldKeep = (el) => {
      if (!visible(el)) return false;
      if (!commentsHeading) return true;

      const a = el.getBoundingClientRect();
      const b = commentsHeading.getBoundingClientRect();

      return a.top < b.top - 10;
    };

    const descriptions = uniq(
      Array.from(root.querySelectorAll("[dir='auto'], p, li"))
        .filter(shouldKeep)
        .map((el) => clean(el.textContent))
        .filter((t) => t.length > 10)
        .filter((t) => norm(t) !== "comments")
    );

    const htmlBlocks = Array.from(
      root.querySelectorAll("mux-player, video, iframe, img, h1, h2, h3, p, li, [dir='auto']")
    )
      .filter(shouldKeep)
      .map((el) => el.outerHTML);

    return { descriptions, htmlBlocks };
  }, { expectedHeading });
}

async function captureNotationScreenshots(page, outDir, prefix) {
  const files = [];

  const candidates = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        st.display !== "none" &&
        st.visibility !== "hidden" &&
        r.width > 160 &&
        r.height > 60
      );
    };

    const score = (el) => {
      let s = 0;
      const tag = el.tagName.toLowerCase();
      const text =
        `${el.className || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
      const r = el.getBoundingClientRect();

      if (tag === "iframe") s += 6;
      if (tag === "img" || tag === "canvas" || tag === "svg") s += 4;
      if (
        text.includes("fretboard") ||
        text.includes("notation") ||
        text.includes("soundslice")
      )
        s += 8;
      if (el.scrollWidth > el.clientWidth + 80) s += 5;
      if (el.querySelector("iframe, canvas, svg, img")) s += 2;
      if (el.querySelector("video")) s -= 10;
      if (r.width > 500) s += 2;
      if (r.height > 100) s += 2;
      return s;
    };

    document
      .querySelectorAll("[data-oai-notation-candidate]")
      .forEach((el) => el.removeAttribute("data-oai-notation-candidate"));

    const main = document.querySelector("main") || document.body;
    const all = Array.from(
      main.querySelectorAll("iframe, img, canvas, svg, div, section, article"),
    )
      .filter(visible)
      .map((el) => ({ el, score: score(el) }))
      .filter((x) => x.score >= 7)
      .sort((a, b) => b.score - a.score);

    const picked = [];
    for (const item of all) {
      const r = item.el.getBoundingClientRect();
      const dup = picked.some((p) => {
        const pr = p.getBoundingClientRect();
        const overlapX =
          Math.abs(pr.left - r.left) < 40 && Math.abs(pr.width - r.width) < 80;
        const overlapY =
          Math.abs(pr.top - r.top) < 40 && Math.abs(pr.height - r.height) < 80;
        return overlapX && overlapY;
      });
      if (!dup) picked.push(item.el);
      if (picked.length >= 3) break;
    }

    return picked.map((el, index) => {
      el.setAttribute("data-oai-notation-candidate", String(index));
      return {
        index,
        tag: el.tagName.toLowerCase(),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
  });

  for (const candidate of candidates) {
    const loc = page
      .locator(`[data-oai-notation-candidate="${candidate.index}"]`)
      .first();
    if (!(await loc.count().catch(() => 0))) continue;

    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);

    const steps = await loc
      .evaluate((el) => {
        const width = Math.max(el.clientWidth || 0, 1);
        const scroll = Math.max(el.scrollWidth || width, width);
        if (scroll <= width + 40) return [0];
        const res = [];
        for (let left = 0; left < scroll; left += width) res.push(left);
        const last = Math.max(0, scroll - width);
        if (!res.includes(last)) res.push(last);
        return res;
      })
      .catch(() => [0]);

    let part = 1;
    for (const left of steps) {
      await loc
        .evaluate((el, val) => {
          if ("scrollLeft" in el) el.scrollLeft = val;
        }, left)
        .catch(() => {});
      await page.waitForTimeout(350);

      const fileName = `${prefix}-notation-${candidate.index + 1}-${part}.png`;
      const fullPath = path.join(outDir, fileName);

      try {
        await loc.screenshot({ path: fullPath, animations: "disabled" });
        if (await fs.pathExists(fullPath)) files.push(fileName);
        part += 1;
      } catch {}
    }
  }

  await page
    .evaluate(() => {
      document
        .querySelectorAll("[data-oai-notation-candidate]")
        .forEach((el) => el.removeAttribute("data-oai-notation-candidate"));
    })
    .catch(() => {});

  return [...new Set(files)];
}

async function cleanupLessonDir(outDir) {
  if (!(await fs.pathExists(outDir))) return;
  const entries = await fs.readdir(outDir).catch(() => []);
  for (const name of entries) {
    if (
      /^meta\.json$/i.test(name) ||
      /^fretboard\.json$/i.test(name) ||
      /^video\.json$/i.test(name) ||
      /^.*-video-debug\.json$/i.test(name) ||
      /^backing-.*\.(json|mp3|mp4)$/i.test(name) ||
      /^.*notation.*\.png$/i.test(name)
    ) {
      await fs.remove(path.join(outDir, name)).catch(() => {});
    }
  }
}

async function downloadLessonNotationPdf(page, outDir) {
  const existing = await findExistingNotationPdf(outDir);
  if (existing) return path.basename(existing);

  await resetLessonViewport(page);

  const tabs = await getTopTabs(page).catch(() => []);
  const lessonTab = tabs.find(
    (t) => normalizeText(t.label || t.heading || "") === "lesson",
  );

  if (lessonTab) {
    await openTab(page, lessonTab.index).catch(() => {});
    await waitForPanelStable(
      page,
      lessonTab.label || lessonTab.heading || "Lesson",
    );
    await resetLessonViewport(page);
  }

  const menuOpened = await openLessonOptionsMenu(page);
  if (!menuOpened) return null;

  const item = page.getByText("Download notation", { exact: true }).first();
  const visible = await item.isVisible().catch(() => false);
  if (!visible) {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }

  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
    await item.click().catch(() => {});
    const download = await downloadPromise.catch(() => null);

    if (!download) {
      await page.keyboard.press("Escape").catch(() => {});
      return null;
    }

    const suggested = sanitizeFilename(
      download.suggestedFilename() || "notation.pdf",
    );
    const finalName = suggested.toLowerCase().endsWith(".pdf")
      ? suggested
      : `${suggested}.pdf`;

    const finalPath = path.join(outDir, finalName);
    await download.saveAs(finalPath);

    await page.keyboard.press("Escape").catch(() => {});
    return finalName;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
}

async function findExistingNotationPdf(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries) {
    if (/\.pdf$/i.test(name)) return path.join(dir, name);
  }
  return null;
}

async function openLessonOptionsMenu(page) {
  await resetLessonViewport(page);

  const existing = await page
    .getByText("Download notation", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);

  if (existing) return true;

  const button = await findTopRightMenuButton(page);
  if (!button) return false;

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click().catch(() => {});
  await page.waitForTimeout(700);

  return await page
    .getByText("Download notation", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
}

async function openPlaylistLessonFromSidebar(page, lesson) {
  const target = await page.evaluate(({ lesson }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const lessonDay = clean(lesson?.day || '');
    const lessonTitle = clean(lesson?.title || lesson || '');
    const lessonAria = clean(lesson?.ariaLabel || '');

    const buttons = Array.from(document.querySelectorAll('button[aria-label]'));

    const scored = buttons
      .map((btn, index) => {
        const aria = clean(btn.getAttribute('aria-label'));
        const text = clean(btn.innerText || btn.textContent || '');
        const combined = `${aria} ${text}`;
        let score = 0;
        if (lessonAria && (aria === lessonAria || text === lessonAria)) score += 100;
        if (lessonDay && combined.includes(lessonDay)) score += 30;
        if (lessonTitle && combined.includes(lessonTitle)) score += 60;
        if (lessonDay && lessonTitle && combined.includes(lessonDay) && combined.includes(lessonTitle)) score += 50;
        return { index, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored.find((item) => item.score > 0) || null;
  }, { lesson });

  if (!target) {
    throw new Error(`Brak skutecznego kliknięcia playlist lesson: ${lesson?.day || ''} ${lesson?.title || lesson}`);
  }

  const locator = page.locator('button[aria-label]').nth(target.index);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true, timeout: 5000 }).catch(async () => {
    await page.evaluate(({ index }) => {
      const btn = Array.from(document.querySelectorAll('button[aria-label]'))[index];
      btn?.scrollIntoView({ block: 'center' });
      btn?.click();
    }, target);
  });

  await waitForLessonShell(page);
  await page.waitForTimeout(1200);

  const currentUrl = page.url();
  if (!isAnyLessonUrl(currentUrl)) {
    throw new Error(`Nie otwarto poprawnego lesson URL dla: ${lesson?.title || lesson}`);
  }
}

async function waitForLessonShell(page) {
  await page.waitForFunction(() => {
    const url = location.href;
    const urlOk =
      /\/class\/[^/]+\/grade\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url) ||
      /\/class\/[^/]+\/lesson\/[^/]+(?:\/item\/[^/]+)?$/.test(url);

    const hasMain = !!document.querySelector('main');
    const hasAnyPlayer =
      !!document.querySelector('iframe[src*="soundslice"]') ||
      !!document.querySelector('video') ||
      !!document.querySelector('mux-player') ||
      !!document.querySelector('[src*=".m3u8"]');

    return hasMain && (urlOk || hasAnyPlayer);
  }, { timeout: 25000 });

  await page.waitForTimeout(1500);
  return true;
}

async function findTopRightMenuButton(page) {
  const handles = await page
    .locator("main button, main [role='button']")
    .elementHandles();

  const viewport = page.viewportSize() || { width: 1600, height: 900 };
  let best = null;

  for (const handle of handles) {
    try {
      const box = await handle.boundingBox();
      if (!box) continue;

      const text = normalizeText(
        (await handle.innerText().catch(() => "")) || "",
      );
      const aria = normalizeText(
        (await handle.getAttribute("aria-label").catch(() => "")) || "",
      );
      const title = normalizeText(
        (await handle.getAttribute("title").catch(() => "")) || "",
      );

      const isPlayerControl =
        text === "play" ||
        aria.includes("play") ||
        aria.includes("pause") ||
        aria.includes("mute") ||
        aria.includes("fullscreen") ||
        aria.includes("seek") ||
        title.includes("play") ||
        title.includes("fullscreen");

      if (isPlayerControl) continue;

      const inZone =
        box.x >= viewport.width * 0.62 && box.y <= viewport.height * 0.35;

      const sizeOk =
        box.width >= 18 &&
        box.height >= 18 &&
        box.width <= 90 &&
        box.height <= 90;

      if (!inZone || !sizeOk) continue;

      const explicitMenu =
        text === "..." ||
        aria.includes("menu") ||
        aria.includes("more") ||
        title.includes("menu") ||
        title.includes("more");

      const score =
        (explicitMenu ? 10000 : 0) +
        box.x -
        box.y -
        Math.abs(box.width - box.height);

      if (!best || score > best.score) {
        best = { handle, score };
      }
    } catch {}
  }

  return best?.handle || null;
}

function buildLessonMarkdown({
  grade,
  lesson,
  url,
  notationPdf,
  lessonUnit,
  exerciseUnits,
}) {
  const lines = [];
  lines.push(`# ${grade.gradeNum} — ${grade.gradeTitle}`);
  lines.push(`## ${lesson.day} — ${lesson.title}`);
  lines.push("");
  lines.push(`URL: ${url}`);
  lines.push("");

  if (notationPdf) {
    lines.push(`Notation PDF: [${notationPdf}](./${notationPdf})`);
    lines.push("");
  }

  if (lessonUnit) {
    lines.push("---");
    lines.push("");
    lines.push("## Lesson");
    lines.push("");

    for (const text of lessonUnit.descriptions || []) {
      lines.push(text);
      lines.push("");
    }

    if ((lessonUnit.notationShots || []).length) {
      lines.push("### Fretboard / notation");
      lines.push("");
      for (const shot of lessonUnit.notationShots) {
        lines.push(`![](${shot})`);
        lines.push("");
      }
    }
  }

  for (const ex of exerciseUnits || []) {
    lines.push("---");
    lines.push("");
    lines.push(`## ${ex.label || ex.heading || "Exercise"}`);
    if (ex.subtitle) lines.push(`### ${ex.subtitle}`);
    lines.push("");

    for (const text of ex.descriptions || []) {
      lines.push(text);
      lines.push("");
    }

    if ((ex.notationShots || []).length) {
      lines.push("### Fretboard / notation");
      lines.push("");
      for (const shot of ex.notationShots) {
        lines.push(`![](${shot})`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

function buildLessonHtml({
  grade,
  lesson,
  url,
  notationPdf,
  lessonUnit,
  exerciseUnits,
}) {
  const esc = (s = "") =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const blocks = [];

  blocks.push(`<h1>${esc(grade.gradeNum)} — ${esc(grade.gradeTitle)}</h1>`);
  blocks.push(`<h2>${esc(lesson.day)} — ${esc(lesson.title)}</h2>`);
  blocks.push(`<p><strong>URL:</strong> ${esc(url)}</p>`);

  if (notationPdf) {
    blocks.push(
      `<p><strong>Notation PDF:</strong> <a href="${esc(notationPdf)}">${esc(notationPdf)}</a></p>`,
    );
  }

  const renderUnit = (title, unit) => {
    if (!unit) return;
    blocks.push("<hr>");
    blocks.push(`<h2>${esc(title)}</h2>`);
    for (const html of unit.htmlBlocks || []) blocks.push(html);
    for (const shot of unit.notationShots || [])
      blocks.push(`<p><img src="${esc(shot)}" alt="notation" /></p>`);
  };

  renderUnit("Lesson", lessonUnit);
  for (const ex of exerciseUnits || [])
    renderUnit(ex.label || ex.heading || "Exercise", ex);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(lesson.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1100px; margin: 40px auto; line-height: 1.5; }
    img { max-width: 100%; height: auto; display: block; margin: 16px 0; }
  </style>
</head>
<body>
${blocks.join("\n")}
</body>
</html>`;
}

function normalizeText(s = "") {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function delay(ms = SLOW_MS) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
