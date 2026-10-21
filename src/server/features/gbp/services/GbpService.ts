import { keys, mapValues, sumBy } from "remeda";
import {
  inclusiveGa4Days,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import {
  GbpConnectionRepository,
  type GbpConnection,
} from "@/server/features/gbp/repositories/GbpConnectionRepository";
import {
  createGoogleAuthorizationUrl,
  GBP_INTEGRATION,
} from "@/server/features/google/googleOAuth";
import { AppError } from "@/server/lib/errors";
import { createGbpClient, type GbpLocation } from "@/server/lib/gbpClient";
import {
  GbpApiError,
  GbpNotConnectedError,
  GbpTokenError,
} from "@/server/lib/gbpErrors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { safeHostname } from "@/shared/safe-url";

// Google Business Profile for the owner's own listings. Self-hosted only:
// the scope is write-capable and hosted has no Business Profile API approval,
// so every entry point refuses hosted mode before doing anything else.

const PERFORMANCE_DEFAULT_DAYS = 28;
// Business Profile performance data settles a few days after the fact.
const PERFORMANCE_LAG_DAYS = 3;
const PERFORMANCE_MAX_DAYS = 92;
const REVIEWS_MAX = 200;

/** Output key → Business Profile Performance API DailyMetric. */
const GBP_DAILY_METRICS = {
  impressionsMobileSearch: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  impressionsDesktopSearch: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  impressionsMobileMaps: "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  impressionsDesktopMaps: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  directionRequests: "BUSINESS_DIRECTION_REQUESTS",
  callClicks: "CALL_CLICKS",
  websiteClicks: "WEBSITE_CLICKS",
  messagingClicks: "MESSAGING_CLICKS",
  bookings: "BUSINESS_BOOKINGS",
  foodMenuClicks: "BUSINESS_FOOD_MENU_CLICKS",
} as const;

type GbpMetricKey = keyof typeof GBP_DAILY_METRICS;

export async function requireSelfHosted() {
  if (await isHostedServerAuthMode()) {
    throw new AppError(
      "NOT_FOUND",
      "Google Business Profile is available on self-hosted installs only.",
    );
  }
}

async function getConnection(projectId: string): Promise<GbpConnection | null> {
  await requireSelfHosted();
  return GbpConnectionRepository.getByProjectId(projectId);
}

async function userHasGrant(userId: string): Promise<boolean> {
  await requireSelfHosted();
  const grants = await GbpConnectionRepository.listGrantsForUser(userId);
  return grants.length > 0;
}

async function startLink(input: {
  userId: string;
  callbackURL: string;
  publicOrigin: string;
}) {
  await requireSelfHosted();
  return createGoogleAuthorizationUrl({
    integration: GBP_INTEGRATION,
    ...input,
  });
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof GbpTokenError ||
    (error instanceof GbpApiError && error.reason === "reconnect")
  );
}

async function listAccountsForUserWithGrantStatus(userId: string) {
  await requireSelfHosted();
  const grants = await GbpConnectionRepository.listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createGbpClient({
        userId,
        googleAccountId: grant.accountId,
      });
      try {
        const businessAccounts = await client.listAccounts();
        const email = await client.getUserInfoEmail().catch(() => null);
        return {
          accountId: grant.accountId,
          email,
          requiresReconnect: false,
          unavailable: false,
          unavailableMessage: null,
          businessAccounts,
        };
      } catch (error) {
        const reconnect = requiresReconnect(error);
        if (!reconnect) {
          console.error("gbp.account_discovery_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            status: error instanceof GbpApiError ? error.status : undefined,
            reason: error instanceof GbpApiError ? error.reason : undefined,
          });
        }
        return {
          accountId: grant.accountId,
          email: null,
          requiresReconnect: reconnect,
          unavailable: !reconnect,
          // Until Google approves API access every call fails the same way;
          // say so instead of a generic retry prompt.
          unavailableMessage:
            error instanceof GbpApiError &&
            error.reason === "api_access_pending"
              ? "Business Profile API access is pending Google's approval"
              : null,
          businessAccounts: [],
        };
      }
    }),
  );
  return { accounts };
}

async function setAccount(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  accountId: string;
  accountName: string;
}): Promise<GbpConnection> {
  await requireSelfHosted();
  const grants = await GbpConnectionRepository.listGrantsForUser(input.userId);
  if (!grants.some((grant) => grant.accountId === input.accountId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }
  const client = createGbpClient({
    userId: input.userId,
    googleAccountId: input.accountId,
  });
  const businessAccount = (await client.listAccounts()).find(
    (candidate) => candidate.name === input.accountName,
  );
  if (!businessAccount) {
    throw new AppError(
      "NOT_FOUND",
      "That Business Profile account isn't available on your connected Google account.",
    );
  }
  const connectedAccountEmail = await client
    .getUserInfoEmail()
    .catch(() => null);
  return GbpConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    accountName: businessAccount.name,
    accountDisplayName: businessAccount.accountName,
    connectedByUserId: input.userId,
    googleAccountId: input.accountId,
    connectedAccountEmail,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  await requireSelfHosted();
  await GbpConnectionRepository.deleteByProjectId(input.projectId);
}

export async function connectedClient(projectId: string) {
  const connection = await GbpConnectionRepository.getByProjectId(projectId);
  if (!connection) throw new GbpNotConnectedError(projectId);
  const client = createGbpClient({
    userId: connection.connectedByUserId,
    googleAccountId: connection.googleAccountId,
  });
  return { connection, client };
}

async function listLocations(projectId: string) {
  await requireSelfHosted();
  const { connection, client } = await connectedClient(projectId);
  return {
    accountName: connection.accountName,
    accountDisplayName: connection.accountDisplayName,
    locations: await client.listLocations(connection.accountName),
  };
}

/**
 * The location a call works on: the requested one (it must belong to the
 * bound account), else the account's only location, else the one whose
 * website is the project's domain. One account can hold several brands, so
 * anything ambiguous asks the caller to choose. An edit may only target the
 * project's own listing when its website identifies one.
 */
function pickLocation(
  locations: GbpLocation[],
  requested: string | undefined,
  projectDomain: string | null,
  edit: boolean,
): GbpLocation {
  const choices = locations
    .map((location) => `${location.location} — ${location.title}`)
    .join("; ");
  const projectHost = projectDomain
    ? safeHostname(`https://${projectDomain}`)
    : null;
  const byWebsite = projectHost
    ? locations.filter(
        (location) => safeHostname(location.websiteUri) === projectHost,
      )
    : [];
  const own = byWebsite.length === 1 ? byWebsite[0] : undefined;
  if (requested) {
    const match = locations.find((location) => location.location === requested);
    if (!match) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${requested} is not a location of the connected Business Profile account. Its locations: ${choices || "none"}.`,
      );
    }
    if (edit && own && own !== match) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${requested} (${match.title}) is not this project's listing: its website ${projectDomain} belongs to ${own.location} — ${own.title}. Edit another restaurant's listing from its own project.`,
      );
    }
    return match;
  }
  if (locations.length === 1 && locations[0]) return locations[0];
  if (own) return own;
  throw new AppError(
    "VALIDATION_ERROR",
    locations.length === 0
      ? "The connected Business Profile account has no locations."
      : `Pass location: the connected Business Profile account has ${locations.length} locations: ${choices}.`,
  );
}

export async function resolveLocation(input: {
  projectId: string;
  location?: string;
  projectDomain: string | null;
  /** Restricts an explicit location to the project's own listing. */
  edit?: boolean;
}) {
  const { connection, client } = await connectedClient(input.projectId);
  const locations = await client.listLocations(connection.accountName);
  return {
    connection,
    client,
    location: pickLocation(
      locations,
      input.location,
      input.projectDomain,
      input.edit ?? false,
    ),
  };
}

async function getReviews(input: {
  projectId: string;
  location?: string;
  projectDomain: string | null;
  orderBy: "newest" | "lowest" | "highest";
  limit: number;
  unansweredOnly: boolean;
}) {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation(input);
  const page = await client.listReviews({
    accountName: connection.accountName,
    location: location.location,
    orderBy:
      input.orderBy === "lowest"
        ? "rating"
        : input.orderBy === "highest"
          ? "rating desc"
          : "updateTime desc",
    // Unanswered reviews are filtered here, so read the full window first.
    max: input.unansweredOnly ? REVIEWS_MAX : input.limit,
  });
  const unanswered = page.reviews.filter((review) => !review.reply);
  return {
    location: location.location,
    title: location.title,
    averageRating: page.averageRating,
    totalReviewCount: page.totalReviewCount,
    fetchedCount: page.reviews.length,
    unansweredCount: unanswered.length,
    reviews: (input.unansweredOnly ? unanswered : page.reviews).slice(
      0,
      input.limit,
    ),
  };
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDateRange(startDate?: string, endDate?: string) {
  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide both startDate and endDate, or neither.",
    );
  }
  const end = endDate ?? shiftGa4Date(utcToday(), -PERFORMANCE_LAG_DAYS);
  const start = startDate ?? shiftGa4Date(end, 1 - PERFORMANCE_DEFAULT_DAYS);
  const days = inclusiveGa4Days(start, end);
  // Negated so an unparseable date (NaN days) is rejected too.
  if (!(days >= 1 && days <= PERFORMANCE_MAX_DAYS)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `startDate and endDate must be valid dates, start on or before end, at most ${PERFORMANCE_MAX_DAYS} days apart.`,
    );
  }
  return { startDate: start, endDate: end, days };
}

async function getPerformance(input: {
  projectId: string;
  location?: string;
  projectDomain: string | null;
  startDate?: string;
  endDate?: string;
}) {
  await requireSelfHosted();
  const range = resolveDateRange(input.startDate, input.endDate);
  const { client, location } = await resolveLocation(input);
  const points = await client.fetchDailyMetrics({
    location: location.location,
    metrics: Object.values(GBP_DAILY_METRICS),
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const keyByMetric = new Map<string, GbpMetricKey>(
    keys(GBP_DAILY_METRICS).map((key) => [GBP_DAILY_METRICS[key], key]),
  );
  // Google drops zero days from the series; every day in range gets a row.
  const byDate = new Map<string, Record<GbpMetricKey, number>>();
  for (let day = 0; day < range.days; day += 1) {
    byDate.set(
      shiftGa4Date(range.startDate, day),
      mapValues(GBP_DAILY_METRICS, () => 0),
    );
  }
  for (const point of points) {
    const key = keyByMetric.get(point.metric);
    const row = byDate.get(point.date);
    if (key && row) row[key] = point.value;
  }
  const daily = [...byDate].map(([date, values]) => ({ date, ...values }));
  const totals = mapValues(GBP_DAILY_METRICS, (_, key) =>
    sumBy(daily, (row) => row[key]),
  );
  return {
    location: location.location,
    title: location.title,
    range: { startDate: range.startDate, endDate: range.endDate },
    totals,
    daily,
  };
}

/** YYYY-MM shifted by whole months. */
function shiftMonth(month: string, delta: number) {
  const [year = 0, monthNumber = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
    .toISOString()
    .slice(0, 7);
}

async function getSearchKeywords(input: {
  projectId: string;
  location?: string;
  projectDomain: string | null;
  startMonth?: string;
  endMonth?: string;
  limit: number;
}) {
  await requireSelfHosted();
  if (Boolean(input.startMonth) !== Boolean(input.endMonth)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide both startMonth and endMonth, or neither.",
    );
  }
  // Default: the last three complete months.
  const endMonth = input.endMonth ?? shiftMonth(utcToday().slice(0, 7), -1);
  const startMonth = input.startMonth ?? shiftMonth(endMonth, -2);
  if (startMonth > endMonth) {
    throw new AppError(
      "VALIDATION_ERROR",
      "startMonth must be on or before endMonth.",
    );
  }
  const { client, location } = await resolveLocation(input);
  const keywords = await client.listSearchKeywords({
    location: location.location,
    startMonth,
    endMonth,
    max: input.limit,
  });
  return {
    location: location.location,
    title: location.title,
    range: { startMonth, endMonth },
    keywords,
  };
}

export const GbpService = {
  getConnection,
  userHasGrant,
  startLink,
  listAccountsForUserWithGrantStatus,
  setAccount,
  disconnect,
  listLocations,
  getReviews,
  getPerformance,
  getSearchKeywords,
};
