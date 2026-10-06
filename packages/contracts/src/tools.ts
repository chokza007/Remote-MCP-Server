import { z } from "zod";

export const toolDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
    title: z.string().min(1),
    description: z.string().min(1),
    riskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    requiredScope: z.string().min(1),
    supportsDryRun: z.boolean(),
    defaultTimeoutMs: z.number().int().positive(),
    cancellable: z.boolean(),
    deprecated: z
      .object({
        since: z.string().min(1),
        replacement: z.string().min(1).optional(),
        removal: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type ToolDescriptorV1 = z.infer<typeof toolDescriptorV1Schema>;

export function parseToolDescriptor(value: unknown): ToolDescriptorV1 {
  const result = toolDescriptorV1Schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid tool schema: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}
