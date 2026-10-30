// One category list for every feature: what ledger lines are posted with, what activity filters and re-categorizes to,
// what insights group by, and what a parent can turn off on a minor's account (a subset). Add a category here, once.
export const CATEGORIES = ['Income', 'Transfers', 'Payments', 'Housing', 'Bills & Utilities', 'Groceries', 'Food & Dining',
  'Auto & Transport', 'Travel', 'Shopping', 'Online marketplaces', 'Home', 'Health', 'Entertainment', 'Gaming', 'Education',
  'Personal Care', 'Gifts & Donations', 'ATM cash', 'Loans', 'Disputes', 'Fees & Charges', 'Other'];

// Merchant categories a parent can turn off on a minor's account (names match the categories on ledger lines).
export const CONTROL_CATEGORIES = ['Food & Dining', 'Groceries', 'Shopping', 'Entertainment', 'Gaming', 'Online marketplaces',
  'Auto & Transport', 'Travel', 'ATM cash'];

// Names lines were posted under before the list was shared. The activity filter still finds them.
export const LEGACY = { Fees: 'Fees & Charges', Cash: 'ATM cash' };

export const isCategory = c => CATEGORIES.includes(c);
/** The category and the older names that mean the same, for filters over lines already posted. */
export const namesFor = c => [c, ...Object.entries(LEGACY).filter(([, to]) => to === c).map(([from]) => from)];
