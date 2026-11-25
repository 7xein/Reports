/**
 * The signed-in user's branch access, for server components and route handlers.
 *
 * The middleware gates tabs only; it does not know about branches. Branch
 * access is enforced where the data is assembled — each page and route reads
 * this view and filters through lib/branch-scope before anything leaves the
 * server.
 */

import { getCurrentUser } from './auth';
import { branchAccessOf, type BranchAccessView } from './branch-scope';

export type { BranchAccessView } from './branch-scope';

/** The current request's access view. Signed out, or a session that cannot be resolved, sees no branch. */
export async function currentBranchAccess(): Promise<BranchAccessView> {
  return branchAccessOf(await getCurrentUser());
}
