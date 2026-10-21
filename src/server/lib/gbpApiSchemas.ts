import { z } from "zod";

// Zod schemas for the Google Business Profile API responses gbpClient reads.
// Only the fields OpenSEO uses are declared; the rest are ignored, except in
// the food menu, which is written back whole.

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

export const reviewSchema = z.object({
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
});

export const reviewsResponseSchema = z.object({
  reviews: z.array(reviewSchema).optional(),
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
    message: z.string().optional(),
    details: z
      .array(
        z.object({
          // google.rpc.ErrorInfo (Business Information, quota, auth errors).
          reason: z.string().optional(),
          metadata: z.record(z.string(), z.string()).optional(),
          // google.mybusiness.v4.ValidationError.
          errorDetails: z
            .array(
              z.object({
                field: z.string().optional(),
                message: z.string().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
});

// --- Listing edits (Business Information API v1 and the v4 API) ---

export const gbpReviewIdSchema = z.string().regex(/^[\w-]{1,200}$/);

export const dayOfWeekSchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);

// Google omits zero fields, so midnight can arrive as {}.
const timeOfDaySchema = z.object({
  hours: z.number().int().optional(),
  minutes: z.number().int().optional(),
});

export const timePeriodSchema = z.object({
  openDay: dayOfWeekSchema,
  openTime: timeOfDaySchema.optional(),
  closeDay: dayOfWeekSchema,
  closeTime: timeOfDaySchema.optional(),
});

export const specialHourPeriodSchema = z.object({
  startDate: googleDateSchema,
  endDate: googleDateSchema.optional(),
  openTime: timeOfDaySchema.optional(),
  closeTime: timeOfDaySchema.optional(),
  closed: z.boolean().optional(),
});

const categorySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
});

export const listingLocationSchema = z.object({
  name: gbpLocationNameSchema,
  title: z.string().default(""),
  categories: z
    .object({
      primaryCategory: categorySchema.optional(),
      additionalCategories: z.array(categorySchema).optional(),
    })
    .optional(),
  profile: z.object({ description: z.string().optional() }).optional(),
  regularHours: z
    .object({ periods: z.array(timePeriodSchema).optional() })
    .optional(),
  specialHours: z
    .object({ specialHourPeriods: z.array(specialHourPeriodSchema).optional() })
    .optional(),
  moreHours: z
    .array(
      z.object({
        hoursTypeId: z.string(),
        periods: z.array(timePeriodSchema).optional(),
      }),
    )
    .optional(),
  websiteUri: z.string().optional(),
  phoneNumbers: z
    .object({
      primaryPhone: z.string().optional(),
      additionalPhones: z.array(z.string()).optional(),
    })
    .optional(),
  openInfo: z.object({ status: z.string().optional() }).optional(),
  serviceItems: z
    .array(
      z.object({
        freeFormServiceItem: z
          .object({
            label: z.object({ displayName: z.string().optional() }).optional(),
          })
          .optional(),
        structuredServiceItem: z
          .object({ serviceTypeId: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
  metadata: z
    .object({
      placeId: z.string().optional(),
      mapsUri: z.string().optional(),
      newReviewUri: z.string().optional(),
      hasVoiceOfMerchant: z.boolean().optional(),
      hasPendingEdits: z.boolean().optional(),
      hasGoogleUpdated: z.boolean().optional(),
      canOperateLocalPost: z.boolean().optional(),
      canHaveFoodMenus: z.boolean().optional(),
    })
    .optional(),
});

export const googleUpdatedSchema = z.object({
  diffMask: z.string().optional(),
  pendingMask: z.string().optional(),
});

export const rawAttributeSchema = z.object({
  name: z.string(),
  valueType: z.string().optional(),
  values: z.array(z.unknown()).optional(),
  repeatedEnumValue: z
    .object({
      setValues: z.array(z.string()).optional(),
      unsetValues: z.array(z.string()).optional(),
    })
    .optional(),
  uriValues: z.array(z.object({ uri: z.string() })).optional(),
});

export const attributesSchema = z.object({
  attributes: z.array(rawAttributeSchema).optional(),
});

export const attributeMetadataResponseSchema = z.object({
  attributeMetadata: z
    .array(
      z.object({
        parent: z.string(),
        valueType: z.string().optional(),
        displayName: z.string().optional(),
        groupDisplayName: z.string().optional(),
        repeatable: z.boolean().optional(),
        deprecated: z.boolean().optional(),
        valueMetadata: z
          .array(
            z.object({
              value: z.unknown(),
              displayName: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

export const categoriesResponseSchema = z.object({
  categories: z
    .array(z.object({ name: z.string(), displayName: z.string().default("") }))
    .optional(),
  nextPageToken: z.string().optional(),
});

export const localPostsResponseSchema = z.object({
  localPosts: z
    .array(
      z.object({
        name: z.string(),
        topicType: z.string().optional(),
        summary: z.string().optional(),
        state: z.string().optional(),
        createTime: z.string().optional(),
        searchUrl: z.string().optional(),
      }),
    )
    .optional(),
});

export const createdLocalPostSchema = z.object({
  name: z.string(),
  state: z.string().optional(),
  searchUrl: z.string().optional(),
});

// The food menu is read, edited and written back whole (updateMask=menus
// replaces the array), so every level is a looseObject: a key stripped here
// would be deleted on Google (allergens, options, photos, nutrition facts).
const menuLabelSchema = z.looseObject({
  displayName: z.string(),
  description: z.string().optional(),
  languageCode: z.string().optional(),
});

const moneySchema = z.looseObject({
  currencyCode: z.string().optional(),
  // int64 arrives as a JSON string.
  units: z.union([z.string(), z.number()]).optional(),
  nanos: z.number().optional(),
});

const foodMenuItemSchema = z.looseObject({
  labels: z.array(menuLabelSchema),
  attributes: z.looseObject({ price: moneySchema.optional() }).optional(),
});

const foodMenuSectionSchema = z.looseObject({
  labels: z.array(menuLabelSchema),
  items: z.array(foodMenuItemSchema).optional(),
});

export const foodMenuSchema = z.looseObject({
  labels: z.array(menuLabelSchema),
  sections: z.array(foodMenuSectionSchema).optional(),
});

export const foodMenusSchema = z.looseObject({
  menus: z.array(foodMenuSchema).optional(),
});
