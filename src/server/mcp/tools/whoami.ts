import {
  getOrCreateOrganizationCustomer,
  getUsageCreditsRemaining,
} from "@/server/billing/subscription";
import { mcpResponse } from "@/server/mcp/formatters";
import { type ToolContext } from "@/server/mcp/context";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getDataSources } from "@/server/lib/data-sources";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

export const whoamiTool = {
  name: "whoami",
  config: {
    title: "Who am I",
    description:
      "Confirms the connected OpenSEO account, server mode, token scopes, and current credit balance when the user asks to check their account or connection. Initializes billing for new hosted accounts. Uses no credits — does not call DataForSEO. Returns creditsRemaining: null when the balance is unavailable. On a self-hosted server without DataForSEO, also returns dataSources: what serves each section there (ready, partial, needs_setup or unavailable) and the monthly budgets used so far.",
    inputSchema: {} as Record<string, never>,
    outputSchema: z.looseObject({
      userEmail: z.string(),
      scopes: z.array(z.string()),
      mode: z.enum(["hosted", "self-hosted"]),
      creditsRemaining: z.number().nullable(),
      dataSources: z
        .looseObject({
          sections: z.array(z.looseObject({})),
          budgets: z.array(z.looseObject({})),
        })
        .optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (_args: Record<string, never>, context: ToolContext) => {
    const auth = context.auth;
    const isHosted = await isHostedServerAuthMode();
    let creditsRemaining: number | null = null;
    if (isHosted) {
      try {
        const customer = await getOrCreateOrganizationCustomer(auth);
        const { monthlyRemaining, topupRemaining } =
          await getUsageCreditsRemaining(customer.id);
        creditsRemaining = monthlyRemaining + topupRemaining;
      } catch {
        // Account identity is still available when billing is unavailable.
      }
    }
    const lines = [
      `Account: ${auth.userEmail}`,
      `Mode: ${isHosted ? "hosted" : "self-hosted"}`,
      `Scopes: ${auth.scopes.length > 0 ? auth.scopes.join(", ") : "none"}`,
    ];
    if (isHosted) {
      lines.push(
        `Credits remaining: ${creditsRemaining != null ? creditsRemaining.toLocaleString() : "unknown"}`,
      );
    }
    // Null on hosted and wherever DataForSEO serves every feature.
    const dataSources = isHosted ? null : await getDataSources();
    if (dataSources) {
      lines.push(
        "Data sources on this server (no credits are billed):",
        ...dataSources.sections.map(
          (section) =>
            `- ${section.label}: ${section.state.replace("_", " ")} (${section.source})`,
        ),
        "Monthly budgets used:",
        ...dataSources.budgets.map(
          (budget) =>
            `- ${budget.label}: ${budget.used.toLocaleString("en-US")} of ${budget.limit.toLocaleString("en-US")} (resets ${budget.resets})${budget.note ? `. ${budget.note}` : ""}`,
        ),
      );
    }
    return mcpResponse({
      text: lines.join("\n"),
      meta: {
        creditsRemaining: creditsRemaining ?? undefined,
      },
      structuredContent: {
        userEmail: auth.userEmail,
        scopes: auth.scopes,
        mode: isHosted ? "hosted" : "self-hosted",
        creditsRemaining,
        ...(dataSources ? { dataSources } : {}),
      },
    });
  },
};
