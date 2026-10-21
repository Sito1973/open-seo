import { z } from "zod";

// Zod schemas for the Google Business Profile API responses gbpClient reads.
// Only the fields OpenSEO uses are declared; the rest are ignored.

export const gbpAccountNameSchema = z.string().regex(/^accounts\/\d+$/);
export const gbpLocationNameSchema = z.string().regex(/^locations\/\d+$/);

export const accountsResponseSchema = z.object({
  accounts: z
    .array(
      z.object({
        name: gbpAccountNameSchema,
        accountName: z.string().default(""),
        type: z.string().optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

export const postalAddressSchema = z.object({
  addressLines: z.array(z.string()).optional(),
  locality: z.string().optional(),
  administrativeArea: z.string().optional(),
  postalCode: z.string().optional(),
  regionCode: z.string().optional(),
});

export const locationsResponseSchema = z.object({
  locations: z
    .array(
      z.object({
        name: gbpLocationNameSchema,
        title: z.string().default(""),
        storefrontAddress: postalAddressSchema.optional(),
        websiteUri: z.string().optional(),
        categories: z
          .object({
            primaryCategory: z
              .object({ displayName: z.string().optional() })
              .optional(),
          })
          .optional(),
        metadata: z
          .object({
            placeId: z.string().optional(),
            mapsUri: z.string().optional(),
          })
          .optional(),
        openInfo: z.object({ status: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

export const reviewsResponseSchema = z.object({
  reviews: z
    .array(
      z.object({
        reviewId: z.string(),
        reviewer: z
          .object({
            displayName: z.string().optional(),
            isAnonymous: z.boolean().optional(),
          })
          .optional(),
        starRating: z.string().optional(),
        comment: z.string().optional(),
        createTime: z.string(),
        updateTime: z.string().optional(),
        reviewReply: z
          .object({ comment: z.string(), updateTime: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
  averageRating: z.number().optional(),
  totalReviewCount: z.number().int().optional(),
  nextPageToken: z.string().optional(),
});

export const googleDateSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int().optional(),
});

export const dailyMetricsResponseSchema = z.object({
  multiDailyMetricTimeSeries: z
    .array(
      z.object({
        dailyMetricTimeSeries: z
          .array(
            z.object({
              dailyMetric: z.string(),
              timeSeries: z
                .object({
                  datedValues: z
                    .array(
                      // Google omits `value` on days where it is zero.
                      z.object({
                        date: googleDateSchema,
                        value: z.string().optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export const searchKeywordsResponseSchema = z.object({
  searchKeywordsCounts: z
    .array(
      z.object({
        searchKeyword: z.string(),
        // Exactly one is set: the count, or the threshold it falls below.
        insightsValue: z
          .object({
            value: z.string().optional(),
            threshold: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

export const googleErrorSchema = z.object({
  error: z.object({
    details: z
      .array(
        z.object({
          reason: z.string().optional(),
          metadata: z.record(z.string(), z.string()).optional(),
        }),
      )
      .optional(),
  }),
});
