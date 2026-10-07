import { z } from "zod";

import type { TransactionService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

const transactionId = z.string().uuid();

export function registerTransactionTools(registry: ToolRegistry, transactions: TransactionService): void {
  registry.register(
    coreDescriptor("transaction_begin", "Begin transaction", "Creates a persisted staged change set without mutating targets.", 1),
    async (args, context) => ({ schemaVersion: 1, transaction: await transactions.begin({
      ownerId: owner(context),
      ...(args.workspaceId === undefined ? {} : { workspaceId: String(args.workspaceId) }),
      changes: args.changes as Array<{ changeId: string; kind: string; target: string; payload: unknown }>
    }) }),
    {
      inputSchema: {
        workspaceId: z.string().min(1).optional(),
        changes: z.array(z.object({
          changeId: z.string().min(1).max(256),
          kind: z.literal("file.replace"),
          target: z.string().min(1),
          payload: z.object({ content: z.string(), encoding: z.enum(["utf8", "base64"]).optional() })
        })).min(1).max(10_000)
      }
    }
  );

  registry.register(
    { ...coreDescriptor("transaction_preview", "Preview transaction", "Prepares recovery points and returns explicit evidence without mutating targets.", 1), supportsDryRun: true },
    async (args, context) => ({ schemaVersion: 1, ...(await transactions.preview(String(args.transactionId), owner(context))) }),
    { inputSchema: { transactionId } }
  );

  registry.register(
    coreDescriptor("transaction_commit", "Commit transaction", "Applies, verifies, and automatically compensates a persisted change set on failure.", 2),
    async (args, context) => ({ schemaVersion: 1, transaction: await transactions.commit({
      transactionId: String(args.transactionId),
      ownerId: owner(context),
      ...(args.previewEvidence === undefined ? {} : { previewEvidence: String(args.previewEvidence) })
    }) }),
    { inputSchema: { transactionId, previewEvidence: z.string().regex(/^[0-9a-f]{64}$/u).optional() } }
  );

  registry.register(
    coreDescriptor("transaction_rollback", "Roll back transaction", "Compensates prepared or applied changes in reverse order from persisted recovery points.", 2),
    async (args, context) => ({
      schemaVersion: 1,
      transaction: await transactions.rollback(String(args.transactionId), owner(context))
    }),
    { inputSchema: { transactionId } }
  );

  registry.register(
    coreDescriptor("transaction_status", "Get transaction status", "Reads an owned transaction and its per-change state.", 0),
    (args, context) => ({
      schemaVersion: 1,
      transaction: transactions.status(String(args.transactionId), owner(context))
    }),
    { inputSchema: { transactionId } }
  );

  registry.register(
    coreDescriptor("transaction_reconcile", "Recover interrupted transactions", "Rolls back interrupted transactions from persisted recovery points.", 2),
    async (_args, context) => ({ schemaVersion: 1, ...(await transactions.reconcile(owner(context))) })
  );
}
