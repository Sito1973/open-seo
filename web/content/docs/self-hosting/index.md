---
title: "Self-Hosting OpenSEO"
description: "Run OpenSEO yourself with Docker or Cloudflare, bring your own DataForSEO API key, and pay only for what you use."
---

OpenSEO is free and open source. Self-hosting means the app costs $0. You bring your own DataForSEO API key and pay DataForSEO directly for API usage.

There are two self-hosting paths:

- **Simple: [Docker](/docs/self-hosting/docker)**, recommended for personal use on your own machine. Easiest way to get started.
- **Advanced: [Cloudflare](/docs/self-hosting/cloudflare)**, for internet-facing self-hosting across multiple devices or with your team. A SaaS-like experience with automatic database backups, and it works on Cloudflare's free plan. Slightly more setup if you're unfamiliar with Cloudflare.

## DataForSEO API key setup

OpenSEO uses [DataForSEO](https://dataforseo.com/?aff=255379) to fetch SEO data. DataForSEO is a paid third-party service unaffiliated with OpenSEO. You need an API key to connect OpenSEO to it.

1. Go to [DataForSEO API Access](https://app.dataforseo.com/api-access?aff=255379).
2. Click "Send by email" to get your credentials.
3. Copy the longer credentials labelled "Base64" credentials.
4. Set this as `DATAFORSEO_API_KEY` in your environment:
   - Docker: `.env`
   - Cloudflare: as a Worker secret in the dashboard
   - Local development: `.env.local`

New DataForSEO accounts include $1 of free credit to test with, and the minimum top-up is $50. See [pricing](/pricing) for cost estimates. Self-hosted costs run slightly lower, since the hosted service adds a 28% fee on DataForSEO requests.

## Optional features

### Google Search Console

Search Console is optional and works in self-hosted deployments using your own Google OAuth client. It takes about 10 minutes of one-time setup. See the [Google Search Console guide on GitHub](https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md).

Without DataForSEO, Domain Overview and new rank trackers' keyword suggestions read your own sites from their connected Search Console properties: real clicks and the queries Search Console lists for the last 28 days. Competitor domains still need DataForSEO. See the [free Google APIs guide on GitHub](https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_APIS.md#search-console-domain-overview-for-your-own-sites).

### Google Business Profile

A self-hosted install can connect your own Google Business Profile account so MCP clients can read your locations, reviews, daily performance and search terms. After you approve each change in chat, they can also edit the listing, reply to reviews, publish posts and update the food menu. It reuses the Search Console OAuth client and needs Google to approve Business Profile API access for your Cloud project first. It is not available on hosted OpenSEO. See the [Google Business Profile guide on GitHub](https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_BUSINESS_PROFILE.md).

### Free Google APIs

A Docker install without a DataForSEO key can run the site audit's Lighthouse checks through Google's free PageSpeed Insights API instead. Set `GOOGLE_PAGESPEED_API_KEY` and leave `DATAFORSEO_API_KEY` unset. When both are set, OpenSEO uses DataForSEO.

With the Chrome UX Report API enabled on it, the same key runs the `get_core_web_vitals` MCP tool, which compares real-user Core Web Vitals across your sites and your competitors'. DataForSEO has no equivalent, so this tool runs whether or not `DATAFORSEO_API_KEY` is set. The Chrome UX Report API is free and cannot add charges.

The same install can run the Maps rank grid, local SERP and local business search MCP tools on the Google Places API, plus a place details tool that reads a competitor's Google Maps listing with up to 5 reviews. Set `GOOGLE_PLACES_API_KEY`. The Places API needs a billing account, and OpenSEO keeps usage under Google's free monthly allowance with built-in budgets. See the [free Google APIs guide on GitHub](https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_APIS.md).

Google has no API for its own search results. With a [Bright Data](https://docs.brightdata.com/scraping-automation/serp-api/send-your-first-request) SERP API zone, set `BRIGHTDATA_API_KEY` and `BRIGHTDATA_SERP_ZONE` to run rank tracking and the `get_serp_results` and `find_serp_competitors` MCP tools on Bright Data's live Google results instead. Bright Data's free tier covers 5,000 requests a month, and OpenSEO stays under it with a built-in budget. The same guide covers it.

Keyword research can read search volumes and keyword ideas from your own Google Ads account's Keyword Planner, which is free. Set `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` and `GOOGLE_ADS_CUSTOMER_ID` (plus `GOOGLE_ADS_LOGIN_CUSTOMER_ID` when you reach the account through a manager account), then connect Google Ads under a project's **Settings → Integrations**. Google only opens the Keyword Planner to Cloud projects with Basic Google Ads API access; until then, keyword research lists your site's Search Console queries for the seed, with impressions instead of search volume. CPC is shown in US dollars, converted from a Colombian peso account at the day's official exchange rate, and Spanish keywords get OpenSEO's own search intent. The same guide covers the setup.

Without a DataForSEO key, AI visibility tracking can collect Google AI Mode answers through [SerpApi](https://serpapi.com/google-ai-mode-api). Set `SERPAPI_API_KEY`; Google AI Mode is then the only engine a tracker can use. SerpApi's free plan covers 250 searches a month, one per prompt in each check, and OpenSEO stays under it with a built-in budget of 240. Each cited page records whether the answer text links it or only lists it among its sources. The same guide covers it.

No Google API reports backlinks, so they still need DataForSEO. To pay DataForSEO for backlinks alone, set `DATAFORSEO_SCOPE=backlinks` next to `DATAFORSEO_API_KEY`. The Backlinks page, the dashboard's backlink cards and the backlinks MCP tools then use DataForSEO's pay-as-you-go Backlinks API ($0.024 per request plus $0.000036 per row), and every other feature runs as if the key were unset, on the keys above. OpenSEO sends at most 300 backlinks requests a month (UTC) of up to 1,000 rows each, so a month costs at most $18; `DATAFORSEO_BACKLINKS_MONTHLY_REQUESTS` changes the 300. The same guide covers it.
