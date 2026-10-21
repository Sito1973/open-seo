import {
  requireSelfHosted,
  resolveLocation,
} from "@/server/features/gbp/services/GbpService";
import {
  editFoodMenus,
  type MenuChange,
} from "@/server/features/gbp/services/gbpFoodMenuEdits";
import {
  type EditResult,
  type LocationInput,
  type PostInput,
  toLocalPost,
  where,
} from "@/server/features/gbp/services/gbpListingShapes";
import { AppError } from "@/server/lib/errors";

// Previews or applies the owner's review replies, posts and food menu edits
// (the Google My Business API v4 content of a listing). Same contract as
// GbpListingService: preview by default, write only with apply: true, return
// the arguments that undo an applied change.

async function replyToReview(
  input: LocationInput & {
    reviewId: string;
    reply: string | null;
    apply: boolean;
  },
): Promise<EditResult> {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation({
    ...input,
    edit: true,
  });
  const target = {
    accountName: connection.accountName,
    location: location.location,
    reviewId: input.reviewId,
  };
  const review = await client.getReview(target);
  const before = review.reply?.comment ?? null;
  const result = {
    ...where(location),
    validatedBy: "openseo" as const,
    review: {
      rating: review.rating,
      comment: review.comment,
      reviewer: review.reviewer,
      createTime: review.createTime,
    },
  };
  if (before === input.reply) {
    return { ...result, mode: "unchanged", changes: [], revert: null };
  }
  const changes = [{ field: "reply", before, after: input.reply }];
  if (!input.apply) {
    return { ...result, mode: "preview", changes, revert: null };
  }
  if (input.reply === null) await client.deleteReviewReply(target);
  else await client.putReviewReply({ ...target, comment: input.reply });
  return {
    ...result,
    mode: "applied",
    changes,
    revert: {
      location: location.location,
      reviewId: input.reviewId,
      reply: before,
    },
  };
}

async function createPost(
  input: LocationInput & {
    post: PostInput;
    languageCode: string;
    apply: boolean;
  },
): Promise<EditResult> {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation({
    ...input,
    edit: true,
  });
  const body = toLocalPost(input.post, input.languageCode);
  const result = {
    ...where(location),
    validatedBy: "openseo" as const,
    changes: [{ field: "new post", before: null, after: body }],
    // A published post can only be deleted in Business Profile.
    revert: null,
  };
  if (!input.apply) return { ...result, mode: "preview" };
  const post = await client.createLocalPost({
    accountName: connection.accountName,
    location: location.location,
    post: body,
  });
  return { ...result, mode: "applied", post };
}

async function updateFoodMenu(
  input: LocationInput & {
    menu?: string;
    currencyCode?: string;
    languageCode: string;
    changes: MenuChange[];
    apply: boolean;
  },
): Promise<EditResult> {
  await requireSelfHosted();
  const { connection, client, location } = await resolveLocation({
    ...input,
    edit: true,
  });
  const { metadata } = await client.getLocation(
    location.location,
    "name,metadata.canHaveFoodMenus",
  );
  if (metadata?.canHaveFoodMenus !== true) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Google does not allow a food menu on ${location.title} (canHaveFoodMenus is false). Link the menu with the url_menu attribute instead.`,
    );
  }
  const v4 = {
    accountName: connection.accountName,
    location: location.location,
  };
  const edit = editFoodMenus({
    menus: await client.getFoodMenus(v4),
    menu: input.menu,
    currencyCode: input.currencyCode,
    languageCode: input.languageCode,
    changes: input.changes,
  });
  const result = {
    ...where(location),
    validatedBy: "openseo" as const,
    changes: edit.rows,
    note: edit.note,
  };
  if (edit.rows.length === 0) {
    return { ...result, mode: "unchanged", revert: null };
  }
  if (!input.apply) return { ...result, mode: "preview", revert: null };
  await client.updateFoodMenus({ ...v4, menus: edit.menus });
  return {
    ...result,
    mode: "applied",
    revert: {
      location: location.location,
      menu: edit.menuName,
      ...(edit.currencyCode ? { currencyCode: edit.currencyCode } : {}),
      changes: edit.revert,
    },
  };
}

export const GbpContentService = {
  replyToReview,
  createPost,
  updateFoodMenu,
};
