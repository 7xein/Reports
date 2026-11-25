import { NO_BRANCH_ACCESS_MESSAGE } from '@/lib/access';

/** A tab's main content for a user who has been given no branch. Same card as the pages' other empty states. */
export function NoBranchAccess() {
  return (
    <div className="bg-white rounded-lg p-8 text-center text-sm text-ink-muted shadow-sm">
      {NO_BRANCH_ACCESS_MESSAGE}
    </div>
  );
}
