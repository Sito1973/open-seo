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

### Google Business Profile

A self-hosted install can connect your own Google Business Profile account so MCP clients can read your locations, reviews, daily performance and search terms. It reuses the Search Console OAuth client and needs Google to approve Business Profile API access for your Cloud project first. It is not available on hosted OpenSEO. See the [Google Business Profile guide on GitHub](https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_BUSINESS_PROFILE.md).

### Free Google APIs

A Docker install without a DataForSEO key can run the site audit's Lighthouse checks through Google's free PageSpeed Insights API instead. Set `GOOGLE_PAGESPEED_API_KEY` and leave `DATAFORSEO_API_KEY` unset. When both are set, OpenSEO uses DataForSEO.

With the Chrome UX Report API enabled on it, the same key runs the `get_core_web_vitals` MCP tool, which compares real-user Core Web Vitals across your sites and your competitors'. The Chrome UX Report API is free and cannot add charges.

The same install can run the Maps rank grid, local SERP and local business search MCP tools on the Google Places API. Set `GOOGLE_PLACES_API_KEY`. The Places API needs a billing account, and OpenSEO keeps usage under Google's free monthly allowance with built-in budgets. See the [free Google APIs guide on GitHub](https://github.com/Sito1973/open-seo/blob/main/docs/SELF_HOSTING_GOOGLE_APIS.md).
