// Every API module. A feature adds one import and one entry here.
import * as session from './session.mjs';
import * as accounts from './accounts.mjs';
import * as servicing from './servicing.mjs';
import * as health from './health.mjs';
import * as accountsFamily from './accounts-family.mjs';
import * as loansCredit from './loans-credit.mjs';
import * as moneyMovement from './money-movement.mjs';
import * as cards from './cards.mjs';
import * as payIn4 from './pay-in-4.mjs';

export const modules = [session, accounts];
modules.push(servicing);
modules.push(moneyMovement);
modules.push(health);
modules.push(accountsFamily);
modules.push(loansCredit);
modules.push(cards);
modules.push(payIn4);
