// Every action name written to audit_events, in one place. The value is the plain-words label the security center shows for
// sign-in events, or null when the action is not listed there. audit() refuses unknown names when AUDIT_STRICT is set (tests do),
// and tests/api/audit-actions.test.mjs checks every action named in lib/ against this list.
export const ACTIONS = {
  // sign-in, codes, passwords (the security center lists the ones with a label)
  'login.ok': 'Signed in', 'login.password_ok': null, 'login.bad_password': 'Wrong password', 'login.lock': 'Sign-in paused after too many tries',
  'login.locked': 'Sign-in tried while paused', 'login.unknown_user': null, 'login.ip_throttled': null, 'login.code_ok': null, 'login.code_bad': 'Wrong one-time code', 'login.code_resent': null,
  'login.code_throttled': 'Sign-in codes paused after too many wrong codes',
  'stepup.code_ok': null, 'stepup.code_bad': 'Wrong step-up code', 'stepup.code_throttled': 'Step-up codes paused after too many wrong codes',
  'password.change': 'Password changed', 'password.change_bad_current': 'Wrong current password',
  'password.change_throttled': 'Password changes paused after too many tries',
  logout: 'Logged out', 'logout.everywhere': 'Logged out everywhere', 'session.revoke': 'Device signed out',
  // servicing
  'activity.recategorize': null, 'alert_rule.change': null, 'alert_rule.create': null, 'alert_rule.delete': null, 'message.send': null,
  'overdraft.change': null, 'profile.change': null, 'profile.estatements': null, 'security.mfa_change': null,
  // accounts and family
  'account.application': null, 'account.fund': null, 'account.joint_accept': null, 'account.joint_decline': null, 'account.joint_invite': null,
  'account.lookup_failed': null, 'account.lookup_throttled': null, 'account.open': null,
  'family.allowance.create': null, 'family.allowance.stop': null, 'family.allowance.paid': null, 'family.allowance.skipped': null,
  'family.chore.cancel': null, 'family.chore.create': null, 'family.chore.paid': null, 'family.chore.submit': null, 'family.controls.update': null,
  'family.goal.create': null, 'family.goal.release': null, 'family.goal.set_aside': null, 'family.mode': null, 'family.purchase': null,
  'family.freeze': null, 'family.unfreeze': null, 'family.spend.allowed': null, 'family.spend.declined': null,
  // money movement
  'ach.link': null, 'ach.link_instant_failed': null, 'ach.link_removed': null, 'ach.processing': null, 'ach.send': null, 'ach.verify_bad': null,
  'ach.verify_ok': null, 'ach.returned': null, 'ach.settled': null, 'billpay.paid': null, 'billpay.scheduled': null, 'billpay.send': null,
  'limit.change': null, 'limit.check': null, 'payee.add': null, 'payee.remove': null, 'settlement.simulated': null,
  'p2p.enroll': null, 'p2p.enroll_code_bad': null, 'p2p.enroll_code_sent': null, 'p2p.enroll_refused': null, 'p2p.enroll_throttled': null,
  'p2p.expired': null, 'p2p.pending': null, 'p2p.released': null, 'p2p.request': null, 'p2p.request_canceled': null, 'p2p.request_declined': null,
  'p2p.send': null, 'p2p.split': null,
  'transfer.cancel_refused': null, 'transfer.canceled': null, 'transfer.failed': null, 'transfer.internal': null, 'transfer.refused': null,
  'transfer.scheduled': null, 'wire.send': null, 'wire.sent': null,
  // cards, loans
  'cards.autopay.cancel': null, 'cards.autopay.set': null, 'cards.autopay.run': null, 'cards.autopay.skip': null, 'cards.controls.set': null,
  'cards.counteroffer_accept': null, 'cards.decision': null, 'cards.dispute.open': null, 'cards.dispute.resolve': null, 'cards.issue': null,
  'cards.lock': null, 'cards.unlock': null, 'cards.minor_refused': null, 'cards.payment': null, 'cards.prequalify': null,
  'cards.purchase.approved': null, 'cards.purchase.declined': null, 'cards.purchase.refused': null, 'cards.replace': null,
  'cards.rewards.clawback': null, 'cards.rewards.redeem': null, 'cards.rewards.reverse': null, 'cards.statement.close': null,
  'cards.travel_notice.add': null, 'cards.travel_notice.cancel': null, 'cards.view_only_refused': null, 'cards.virtual_number.view': null,
  'loan.accept': null, 'loan.decision': null, 'loan.disburse': null, 'loan.paid_off': null, 'loan.payment': null, 'loan.prequalify': null,
  // round-up savings
  'roundup.enable': null, 'roundup.pause': null, 'roundup.resume': null, 'roundup.disable': null, 'roundup.accrue': null,
  'roundup.sweep_posted': null, 'roundup.sweep_deferred': null, 'roundup.refund': null, 'roundup.reverse': null
};
/** Labels the security center shows for sign-in events: { action: label } for the actions that have one. */
export const SIGNIN_LABELS = Object.fromEntries(Object.entries(ACTIONS).filter(([, label]) => label));
