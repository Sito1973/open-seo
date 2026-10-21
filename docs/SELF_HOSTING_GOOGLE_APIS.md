# Free Google APIs for self-hosted installs

Some OpenSEO features can run on free Google APIs when your self-hosted install
has no DataForSEO key. Each one is opt-in: set its key and leave
`DATAFORSEO_API_KEY` unset.

When `DATAFORSEO_API_KEY` is set, OpenSEO keeps using DataForSEO and ignores
these keys, except for the
[Chrome UX Report tool](#chrome-ux-report-real-user-core-web-vitals): DataForSEO
has no real-user field data, so that tool runs on the PageSpeed Insights key
either way. Features that have no Google replacement still need DataForSEO.

These keys work on Docker self-hosting, including platforms that run the Docker
image for you. The Cloudflare deploy requires a DataForSEO key, so it always
uses DataForSEO.

## PageSpeed Insights: site audit Lighthouse checks

With `GOOGLE_PAGESPEED_API_KEY` set, the site audit runs its Lighthouse checks
through the [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/about).
It returns the same Lighthouse report DataForSEO does, so the audit shows the
same scores, metrics and issues. The API is free and needs no billing account,
but Google rejects requests without a key.

Each audit checks up to 10 pages, each on mobile and desktop, so it makes at
most 20 requests. Google loads those pages from its own servers, so they must be
publicly reachable.

### 1) Enable the API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. Enable the
   [PageSpeed Insights API](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com)
   for that project.

### 2) Create and restrict a key

Under **APIs & Services → Credentials → Create credentials → API key**, create a
key, then edit it:

- **API restrictions:** choose **Restrict key** and select only the
  **PageSpeed Insights API**, plus the **Chrome UX Report API** if you want
  [real-user Core Web Vitals](#chrome-ux-report-real-user-core-web-vitals).
- **Application restrictions:** choose **None**, or **IP addresses** if your
  server's outbound IP address never changes. Do not use **Websites** (HTTP
  referrers): OpenSEO calls the API from the server, not from a browser, so
  every request would be refused.

### 3) Set the environment variable

Add the key to `.env` and recreate the container:

```bash
GOOGLE_PAGESPEED_API_KEY=your-key
```

```bash
docker compose up -d --force-recreate open-seo
```

On a platform that runs the image for you, set the variable in its environment
settings and redeploy.

`/api/health` confirms the key reached the app: with DataForSEO unset, the
`dataforseo` check says that free Google APIs cover the Lighthouse checks.

### 4) Check your quota

The API's **Quotas** page in the Cloud Console shows your daily and per-minute
limits and how much you have used. The defaults are far above what audits use.
If a check fails (quota, timeout, or a page Lighthouse could not load), the
audit marks that one check as failed and carries on.

## Chrome UX Report: real-user Core Web Vitals

The PageSpeed Insights key also runs the `get_core_web_vitals` MCP tool, with or
without `DATAFORSEO_API_KEY`. It reads real-user field data from the
[Chrome UX Report (CrUX) API](https://developer.chrome.com/docs/crux/api) and
the [CrUX History API](https://developer.chrome.com/docs/crux/history-api). It
works for any public site, so you can compare your sites with your competitors'.
The site audit's Lighthouse checks measure one lab page load from Google's
servers; CrUX reports what real Chrome visitors experienced.

For up to 5 sites per call, on phone and desktop (or all devices combined), the
tool returns:

- the 75th percentile (p75) of LCP, INP, CLS, FCP and TTFB over the last 28
  days, rated good, needs improvement or poor with Google's thresholds;
- the share of page loads in each of those three ratings;
- Google's Core Web Vitals assessment: passed when LCP, CLS and INP (when INP
  has data) are all good;
- with `historyWeeks`, up to 40 weekly p75 values, each over the 28 days ending
  that week.

Ask for a single page with `level: "url"`. It needs far more traffic than the
whole site.

### 1) Enable the API

1. In the Google Cloud project of your PageSpeed Insights key, enable the
   [Chrome UX Report API](https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com).
2. If the key has API restrictions, add the **Chrome UX Report API** to them.

No new environment variable is needed, and the change applies without a
restart. Until the API is enabled, the tool answers with an error that names
the key.

### 2) Cost and quota

The CrUX API is free. Google allows 150 queries per minute per Cloud project,
shared by both CrUX endpoints, and does not sell more, so it cannot add charges.
A call sends one query per site and device, one more when a bare domain is
retried with `www.`, and one more for history: at most 30 queries for 5 sites.
When the per-minute quota runs out, the tool says so; wait a minute and retry.

### No data for a site

CrUX only includes sites and pages with enough Chrome visits in the last 28
days, and Google does not publish the threshold. Small sites often have none,
so the tool answers "no field data" for them instead of failing. Combining
devices (`device: "all"`) has data more often than phone or desktop alone. For
sites without field data, use the site audit's Lighthouse checks.

CrUX keys its data by the exact address visitors land on: `https://example.com`
and `https://www.example.com` are different sites. A bare domain such as
`example.com`, the form projects store their domain in, is tried as
`https://example.com` and then as `https://www.example.com`.

### What the numbers cover

- Chrome users worldwide on desktop and Android. Chrome on iOS, Android WebViews
  and other Chromium browsers such as Edge are not counted, and the CrUX APIs
  have no country filter.
- The daily data runs about two days behind. The history updates on Mondays.
- OpenSEO stores nothing from CrUX. For trends, ask for `historyWeeks` instead
  of keeping snapshots.

## Google Places: Maps rank grid, local SERP, business search and place details

With `GOOGLE_PLACES_API_KEY` set, three MCP tools run on the
[Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview)
Text Search instead of DataForSEO:

- `get_local_rank_grid`: one search per grid point. When the target has a
  `placeId`, each search asks Google for place IDs only, which Google does not
  bill. The target is then matched by `placeId` alone, and the grid's top
  results come back as place IDs without names. A target with only a `cid` or
  a `name` needs the business names and Maps links, which Google bills.
  `list_google_business_profile_locations` gives the place IDs of your own
  locations.
- `get_local_serp_results`: the `maps` search type only. `local_finder` still
  needs DataForSEO.
- `search_local_businesses`: searches by `query`, or by the first category when
  no query is given. The `isClaimed` filter still needs DataForSEO, because
  Places does not say whether a listing is claimed.

The tools keep their names and output shapes. Their responses add
`provider: "google_places"`, the Google Maps attribution and the month's budget
(null on a place-ID grid, which uses none).

A fourth tool, `get_place_details`, exists only on self-hosted installs that
use Google Places. It reads one place live from
[Place Details](https://developers.google.com/maps/documentation/places/web-service/place-details):
rating, review count, price level, primary type, opening hours, website,
whether it offers delivery, dine-in, takeout, reservations and outdoor seating,
and up to 5 reviews with their authors. Google picks the reviews by relevance,
so they are a sample, not the newest reviews or the full history. Pass it a
`place_id` from the other local tools to look at a competitor.

These tools still need DataForSEO: `get_business_profile` and
`get_business_reviews` (on Places, use `get_place_details`),
`get_business_updates`, `get_google_business_questions` and
`list_business_categories`.

### Built-in monthly budget

Unlike PageSpeed Insights, the Places API needs a billing account. Google gives
each billing account a free monthly allowance per SKU, and OpenSEO stays under
it with hard-coded budgets that reset at the start of each month, Pacific time:

| What OpenSEO sends                                                          | Google SKU                            | Free per month | OpenSEO budget |
| --------------------------------------------------------------------------- | ------------------------------------- | -------------- | -------------- |
| One rank grid point for a target with a `placeId`                           | Text Search Essentials (IDs Only)     | Unlimited      | None needed    |
| One rank grid point for a target with only a `cid` or `name` (3x3 grid = 9) | Text Search Pro                       | 5,000          | 4,500          |
| One page of up to 20 local SERP or business search rows (at most 3 pages)   | Text Search Enterprise                | 1,000          | 900            |
| One `get_place_details` call                                                | Place Details Enterprise + Atmosphere | 1,000          | 900            |

Except for place-ID rank grids, which Google does not bill, OpenSEO counts
each request before sending it. When the budget for a SKU runs out, the tool
says so and sends nothing until next month. A rank grid billed as Text Search
Pro reserves all of its points up front, so it either runs whole or not at all. Failed
requests still count, so the counter can run slightly ahead of Google's.

There is no setting to raise the budgets. The free allowance belongs to the
billing account, so use a billing account that no other Google Maps Platform
project shares. Otherwise the other project's usage counts against the same
allowance and you can be charged.

The counter covers one OpenSEO database. Do not put the same key, or a key
billed to the same account, on a second install (local development, staging):
each install counts only its own requests, so together they can pass the free
allowance. Give that install no Places key, or a key on a different billing
account.

The counter lives in OpenSEO's database. With Docker Compose that is the
`open_seo_data` volume mounted at `/app/.wrangler`. On a platform that runs the
image for you, mount a persistent volume at `/app/.wrangler`. If the volume is
lost, the counter starts again at 0 for the current month.

### 1) Set up billing and enable the API

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project for OpenSEO and link it to a billing account that no other Maps
   project uses.
2. Enable the
   [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com).
   The legacy Places API is a different API and does not work.

### 2) Create and restrict a key

Create a separate API key under **APIs & Services → Credentials → Create
credentials → API key**, then edit it:

- **API restrictions:** choose **Restrict key** and select only the
  **Places API (New)**.
- **Application restrictions:** choose **None**, or **IP addresses** if your
  server's outbound IP address never changes. Do not use **Websites** (HTTP
  referrers).

### 3) Add a backstop

The built-in budget is the main guard. Add two more in the Cloud Console:

- On the Places API (New) **Quotas** page, lower the Text Search and Place
  Details request quotas so a runaway client cannot send many requests at
  once. Keep the Text Search per-minute quota at 60 or more: a 5x5 grid sends
  25 requests at once, and requests over the quota fail but still count
  against the monthly budget.
- Under **Billing → Budgets & alerts**, create a budget of $1 with an email
  alert. Google only sends the alert; it does not stop charges.

### 4) Set the environment variable

```bash
GOOGLE_PLACES_API_KEY=your-key
```

Recreate the container as in the PageSpeed Insights section. With DataForSEO
unset, the `dataforseo` check in `/api/health` lists Google Places among the
free Google APIs in use.

### Accuracy

Text Search is not the Maps app. It has no zoom, personalization or ads, so
ranks approximate what a person sees in Google Maps. Each grid point favors
results within one grid spacing of the point. Compare Google Places grids only with other
Google Places grids, not with grids from DataForSEO.

### What OpenSEO stores

OpenSEO stores only the monthly request counters. It keeps no Places results,
no cache and no rank history, and it adds no Places data to the app UI. Google's
terms limit how Places content can be stored and shown, so every response tells
your AI agent to keep listing details (names, addresses, phones, websites,
ratings, review counts, hours, coordinates and reviews) in the chat and out of
`save_report` and `update_project_context`. Reports can keep place IDs, ranks,
grid coordinates, your own business details and the agent's conclusions. Show
the "Google Maps" attribution when you present the results. When you show a
review, credit its author and Google Maps and link to the review on Google Maps.
`get_place_details` returns each review's author, author profile link and
Google Maps link for this.

SAM, the in-app agent, saves its chat history, which would store Places results.
So while Google Places is in use, SAM refuses the three search tools, and it
does not offer `get_place_details` at all. Run them from an MCP client instead.
