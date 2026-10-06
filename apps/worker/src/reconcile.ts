import type { JobReconciler, ReconcileResult } from "@remote-mcp/runtime";

export interface ReconcilerLike {
  reconcile(): Promise<ReconcileResult>;
}

export async function reconcileAtStartup(reconciler: ReconcilerLike): Promise<ReconcileResult> {
  return reconciler.reconcile();
}

export type { JobReconciler };
