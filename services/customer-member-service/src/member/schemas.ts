import { z } from "zod";

export const memberRequestSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).default(200),
  updated_after: z.string().trim().min(1).optional(),
  last_update: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  refresh: z.coerce.boolean().default(false),
  include_inactive: z.coerce.boolean().default(false)
});

export const partnerParamsSchema = z.object({
  partnerId: z.coerce.number().int().positive()
});

export type MemberRequest = z.infer<typeof memberRequestSchema>;
