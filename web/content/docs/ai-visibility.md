---
title: "AI Visibility"
description: "Research prompts, compare AI answers, and track brand mentions and citations."
---

AI Visibility helps you choose questions to track and see whether AI answers mention your brand, cite your website, or include competitors.

## Set up your project

Add your website, then complete the setup shown on the AI visibility pages. Research fills missing project context and generates keywords; existing context and competitors are preserved. Generating keywords does not automatically run paid prompt research for each one.

## Research, explore, and track

- **Prompt Research:** analyze a keyword to find the questions people ask about it, with ChatGPT's answers and cited sources. Research currently covers US English. The questions come from DataForSEO's dataset, built mostly from Google "People also ask" questions; they are not logged ChatGPT prompts, and OpenSEO does not estimate how often they are asked in AI. A self-hosted install without DataForSEO lists Google's own candidates instead, described below.
- **Prompt Explorer:** try one prompt in ChatGPT, or add Claude, Gemini, and Perplexity to compare answers and available citations. These are API model answers and can differ from consumer-site answers collected by tracking.
- **Prompt Tracking:** save exact questions under topics, select engines and a market, then run a check or enable daily, weekly, or monthly tracking. Editing a question's wording starts a new question, so earlier answers keep the wording they were collected for. ChatGPT and Gemini are selected by default; Google AI Overviews, Claude, and Perplexity are also supported. A self-hosted install without DataForSEO can track Google AI Mode instead, through SerpApi, and Google AI Overviews through Bright Data. When you open a Google AI Mode answer, each of its citations shows whether the answer text links it (and which it links first) or only lists it among its sources. Enabling tracking starts an initial check.
- **Competitors and Citations:** open these tabs in Prompt Tracking to review saved brand mentions, competitor appearances, and cited pages. Competitors come from shared Project context. Your brand counts as mentioned when its name or domain appears in an answer, and as cited when the answer links to your site. A failed check is not evidence that your brand was absent.

The trend chart includes manual and scheduled checks, using the latest finished run per day. Review and export saved results without using credits.

## Credits and cost

Prompt research costs about $0.25 in credits per keyword. Explorer charges actual usage for uncached answers. Tracking shows a cost estimate before a check or schedule is started and bills each check as it collects answers. Run now collects live answers, which usually arrive within a minute and cost more per answer than scheduled checks. Checks stop when your credits run out.

Tracking collects ChatGPT and Gemini answers from their consumer sites. Claude and Perplexity have no consumer-site collection, so every check, scheduled or Run now, asks their model API at live API pricing, which costs more per answer.

On hosted OpenSEO, Prompt Research and Prompt Explorer require the paid plan; prompt tracking only needs credits. Setup research uses available credits and is billed after completion.

Self-hosted users pay providers directly: set `DATAFORSEO_API_KEY` for research and answer collection, and `OPENROUTER_API_KEY` for setup research and generated prompt suggestions. Without `OPENROUTER_API_KEY`, setup shows the raw material instead of drafts (your website's text, and with Bright Data, Google results and related searches for the keywords you track), and **Generate** fills in Google's "People also ask" questions for the topic; you edit them, or ask your assistant over [MCP](/docs/mcp) to draft and save them. Without DataForSEO, `SERPAPI_API_KEY` collects Google AI Mode answers on SerpApi's free plan: each answer costs $0 but uses one of a monthly budget of 240 searches shared by every tracker on the install, a check can use at most 50 (SerpApi's hourly limit), and the estimate shows how many a check and the schedules use. With `BRIGHTDATA_API_KEY` and `BRIGHTDATA_SERP_ZONE`, Google AI Overviews answers come from Bright Data's free tier the same way: $0 each, one request per prompt from the 4,500 a month that rank tracking also uses. A page where Google showed an AI Overview but Bright Data returned no text counts as no answer, with a note, never as an answer that leaves your brand out.

Without DataForSEO, Prompt Research lists Google's candidates for the keyword in the tracker's market, with no AI model involved: People Also Ask questions with Google's answer and related searches (one Bright Data request per keyword, cached 7 days), autocomplete for the keyword's question forms and city, your site's Search Console questions, your Business Profile searches, and the prompts you already track about it with their last answer. Each row says where it came from and is ranked by a labeled signal: Business Profile impressions, then Search Console impressions, then Keyword Planner searches. None of them is AI prompt volume. Reword the candidates you pick before tracking them, or ask your assistant over [MCP](/docs/mcp) to rewrite and save them. See the [self-hosting guides](/docs/self-hosting).

## Use your assistant

Connect [OpenSEO MCP](/docs/mcp) to research prompts, configure tracking and read saved results from your assistant. For a one-off answer, ask the assistant to use `explore_prompt`; it defaults to ChatGPT.

Use [AI Prompt Research](/docs/skills/ai-prompt-research) to find questions before tracking, or [AI Visibility Audit](/docs/skills/ai-visibility-audit) to investigate improvements using answers and cited pages.
