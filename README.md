# Pickup Music Learning Pathway Scraper

Playwright-based scraper for Pickup Music **Learning Pathway** courses.

The project does three things:

1. logs into Pickup Music and saves an authenticated browser session,
2. scrapes the course structure and lesson content,
3. downloads lesson and exercise videos from the real player media URLs.

It is designed for courses that follow the same UI model as Pickup Music learning pathways:

- **Class overview**
- **Grade 1, Grade 2, ...**
- **Day 1, Day 2, ...**
- lesson tabs such as **Lesson**, **Exercise 1**, **Exercise 2**, **Jam**
- video delivered through the in-page player, typically Mux/HLS (`.m3u8`)

---

## What it outputs

For each lesson, the scraper writes files into:

```text
output/lessons/<grade-slug>/<lesson-slug>/
```

Typical outputs:

- `lesson.md` — markdown version of the lesson
- `lesson.html` — HTML export of the lesson
- `*.pdf` — downloaded notation PDF, when available
- `*.png` — notation / fretboard screenshots, when captured
- `video-lesson.mp4` — main lesson video
- `video-exercise-1.mp4`, `video-exercise-2.mp4`, ...
- `video-jam.mp4`
- `output/course.json` — the scraped course structure used later by the video downloader
- `output/storage.json` — authenticated Playwright session

---

## Requirements

- **Node.js** 20+
- **ffmpeg** available in `PATH`
- **ffprobe** available in `PATH`
- Chromium installed through Playwright

Install dependencies:

```bash
npm install
npx playwright install chromium
```

On Windows, if PowerShell blocks `npm` or `npx`, use:

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

---

## Environment variables

Create a `.env` file in the project root.

Example:

```env
BASE_URL=https://my.pickupmusic.com
PICKUP_EMAIL=your@email.com
PICKUP_PASSWORD=your_password
COURSE_TITLE=X Learning Pathway
COURSE_PATH=/guitar/class/<class-id>/grade/<grade-id>
CONCURRENCY=1
```

### Required

- `BASE_URL` — Pickup Music base URL
- `PICKUP_EMAIL` — account email
- `PICKUP_PASSWORD` — account password
- `COURSE_PATH` — path to the target course / learning pathway

### Optional

- `COURSE_TITLE` — used in `output/course.json`
- `SCRAPE_GRADE` — scrape only a specific grade, for example `Grade 5`
- `SCRAPE_DAY` — scrape only a specific day, for example `Day 3`
- `CONCURRENCY` — currently safe to keep at `1`

### Notes about `COURSE_PATH`

`COURSE_PATH` can point either to:

- a class URL, or
- a grade URL inside the class

The scraper still works as long as the page exposes the standard **Class overview** sidebar and the course uses the normal learning pathway structure.

---

## Commands

### Authenticate only

Logs into Pickup Music and saves browser state to `output/storage.json`.

```bash
npm run auth
```

### Scrape lesson structure and content

```bash
npm run scrape
```

This creates or updates:

- `output/course.json`
- lesson markdown / HTML exports
- notation PDFs and screenshots

### Download videos only

```bash
npm run videos
```

This requires `output/course.json` from the scrape step.

### Full pipeline

```bash
npm run full
```

This runs:

1. authentication,
2. scraping,
3. video download.

---

## Recommended workflow

### First run

```bash
npm run auth
npm run scrape
npm run videos
```

### Re-run after interruption

Usually you only need:

```bash
npm run scrape
npm run videos
```

The scraper writes `output/course.json` incrementally, and the video downloader is built to skip files that already exist and look valid.

---

## Scraping only a specific grade or day

You can filter scraping with environment variables.

### PowerShell

```powershell
$env:SCRAPE_GRADE='Grade 5'
npm.cmd run scrape
```

Specific day inside a grade:

```powershell
$env:SCRAPE_GRADE='Grade 5'
$env:SCRAPE_DAY='Day 3'
npm.cmd run scrape
```

Clear filters:

```powershell
Remove-Item Env:SCRAPE_GRADE -ErrorAction SilentlyContinue
Remove-Item Env:SCRAPE_DAY -ErrorAction SilentlyContinue
```

### Bash

```bash
SCRAPE_GRADE='Grade 5' npm run scrape
SCRAPE_GRADE='Grade 5' SCRAPE_DAY='Day 3' npm run scrape
```

---

## Grade-only wrapper

A small wrapper can be used to avoid setting env vars manually:

```bash
node src/run-grade-scrape.js --grade "Grade 5"
node src/run-grade-scrape.js --grade "Grade 5" --day "Day 3"
```

This simply sets `SCRAPE_GRADE` and `SCRAPE_DAY` before calling the main scraper.

---

## How video downloading works

The downloader does **not** rely on static URLs stored in the lesson export.

Instead, for each lesson tab it:

1. opens the lesson page,
2. finds lesson / exercise / jam tabs,
3. opens the tab,
4. waits for the player,
5. starts playback,
6. collects candidate media URLs from:
   - `video.currentSrc`
   - player/network responses
   - `performance.getEntriesByType('resource')`
7. filters out junk such as:
   - Sentry
   - PostHog
   - fonts
   - JS/CSS assets
   - analytics endpoints
8. downloads the selected media with `ffmpeg`
9. rejects broken or too-short files

The downloader is intentionally conservative and prefers retry-safe behavior over speed.

---

## File naming

Video files are saved as:

- `video-lesson.mp4`
- `video-exercise-1.mp4`
- `video-exercise-2.mp4`
- `video-exercise-3.mp4`
- `video-jam.mp4`

Workout lessons often contain only the lesson video and no separate exercise tabs.

---

## Troubleshooting

### `Brak output/course.json. Najpierw odpal npm.cmd run scrape`

Run the scrape step first:

```bash
npm run scrape
```

### `Brak sesji! Uruchom: npm run auth`

Your login session does not exist yet. Run:

```bash
npm run auth
```

### `brak sensownych media URL`

The downloader opened the tab but did not capture a valid media URL.

Typical causes:

- the player did not load in time,
- the session expired,
- the page structure changed,
- that lesson uses a slightly different player flow.

Start by re-authenticating:

```bash
npm run auth
```

Then retry the failing lesson or grade.

### ffmpeg tries to download Sentry / PostHog / analytics URLs

That means the media URL filter is too permissive or the player media URL was not captured. The downloader should only pass real video candidates such as Mux `.m3u8` / `.mp4` URLs into ffmpeg.

### Some `.mp4` files are broken or extremely short

Use `ffprobe` to validate durations. Broken files can be re-downloaded by deleting them and rerunning `npm run videos`.

Example PowerShell check:

```powershell
Get-ChildItem -Recurse -Filter *.mp4 | ForEach-Object {
  $d = ffprobe -v error -show_entries format=duration -of csv=p=0 "$($_.FullName)"
  if ($d) {
    [timespan]::FromSeconds([double]$d).ToString("hh\:mm\:ss") + "  " + $_.FullName
  } else {
    "INVALID  " + $_.FullName
  }
}
```

### Ctrl+C during scrape

`output/course.json` is written incrementally, so partial progress is often preserved. Rerun the scraper or continue with grade/day filters.

---

## Adapting the scraper to another Pickup Music learning pathway

In most cases, no code changes are needed. Just change the .env link, title and get rid of previous output files.

---

## Project structure

```text
src/
  auth.js                  # login + storageState handling
  index.js                 # CLI entrypoint
  scraper.js               # course scraping + markdown/html export
  video-downloader.js      # real media URL capture + ffmpeg download
  soundslice.js            # helper logic related to notation / Soundslice
  utils.js                 # logging, slugs, output paths
  run-grade-scrape.js      # optional wrapper for grade/day filtering

output/
  storage.json             # authenticated session
  course.json              # scraped course structure
  lessons/                 # per-grade / per-lesson exports and videos
```