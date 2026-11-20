// Recipient suggestions for the compose address fields.
//
// Pure and in shared/ for the same reason as composeModel.ts: the .tsx that
// uses it cannot be type-stripped by `node --test`, and the token arithmetic
// here is exactly the kind of thing that is off by one in a way review misses.
//
// There is no address book behind this. The contacts are the people already in
// the mailbox -- whoever wrote to the operator, and whoever the operator wrote
// to -- so the list is never stale and never needs maintaining.

import { isOwnAddress } from "./composeModel.ts";
import type { RecentContact } from "./ipcContract.ts";

/** The address fields of one cached message, newest first by the caller. */
export interface ContactRow {
  date: string;
  from: string;
  to: string[];
  cc: string[];
}

/** Separators, matching parseAddresses -- and so matching Pat. */
const SEPARATOR = /[\s,;]/;

/**
 * Everyone the operator has exchanged traffic with, most recent first.
 *
 * Direction is read from the sender rather than the folder: a message FROM the
 * operator is outgoing, so its recipients are the contacts; any other message
 * is incoming, so its sender is. That one rule is right for every folder,
 * Archive included, which holds both directions.
 *
 * The other recipients of an incoming message are deliberately left out. Being
 * copied on a net bulletin alongside forty stations is not traffic with them,
 * and a list that offers all forty buries the people the operator writes to.
 */
export function collectRecentContacts(rows: readonly ContactRow[], mycall: string, limit: number): RecentContact[] {
  const byKey = new Map<string, RecentContact>();

  const add = (raw: string, date: string) => {
    const address = raw.trim();
    if (!address || isOwnAddress(address, mycall)) return;
    const key = address.toUpperCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { address, lastUsed: date, count: 1 });
      return;
    }
    existing.count += 1;
    // The most recent spelling wins: an internet mail server may treat the
    // local part as case-sensitive, so the form that last worked is the one
    // to offer.
    if (date > existing.lastUsed) {
      existing.lastUsed = date;
      existing.address = address;
    }
  };

  for (const row of rows) {
    if (isOwnAddress(row.from, mycall)) {
      for (const address of [...row.to, ...row.cc]) add(address, row.date);
    } else {
      add(row.from, row.date);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (a.lastUsed === b.lastUsed ? b.count - a.count : a.lastUsed < b.lastUsed ? 1 : -1))
    .slice(0, limit);
}

/** The address under the caret: where it starts, where it ends, what it says. */
export interface AddressToken {
  start: number;
  end: number;
  text: string;
}

export function tokenAtCaret(value: string, caret: number): AddressToken {
  const at = Math.max(0, Math.min(caret, value.length));
  let start = at;
  while (start > 0 && !SEPARATOR.test(value[start - 1]!)) start -= 1;
  let end = at;
  while (end < value.length && !SEPARATOR.test(value[end]!)) end += 1;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Does this contact match what has been typed so far?
 *
 * A prefix of the whole address, of the part before the "@", or of the domain.
 * The domain matters more than it sounds: an operator often remembers
 * "the one at the county EOC" long after the mailbox name.
 */
function matches(address: string, query: string): boolean {
  const candidate = address.toUpperCase();
  if (candidate.startsWith(query)) return true;
  const at = candidate.indexOf("@");
  return at >= 0 && candidate.slice(at + 1).startsWith(query);
}

/**
 * The suggestions for one field, in recency order.
 *
 * An empty query returns the most recent contacts -- what ArrowDown in an
 * empty field shows. Addresses already in the field are never offered again.
 */
export function suggestContacts(
  contacts: readonly RecentContact[],
  query: string,
  presentInField: readonly string[],
  limit = 8,
): RecentContact[] {
  const wanted = query.trim().toUpperCase();
  const present = new Set(presentInField.map((address) => address.toUpperCase()));

  const out: RecentContact[] = [];
  for (const contact of contacts) {
    if (out.length >= limit) break;
    const key = contact.address.toUpperCase();
    if (present.has(key)) continue;
    if (wanted && !matches(contact.address, wanted)) continue;
    out.push(contact);
  }
  return out;
}

/**
 * Puts the chosen address where the partial one was.
 *
 * Followed by ", " so the next recipient can be typed straight away -- unless
 * a separator already follows, which would leave the operator a doubled comma
 * to clean up after editing a recipient in the middle of the field.
 */
export function applySuggestion(
  value: string,
  token: Pick<AddressToken, "start" | "end">,
  address: string,
): { value: string; caret: number } {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end);
  const joiner = /^[\s,;]/.test(after) ? "" : ", ";
  const inserted = address + joiner;
  return { value: before + inserted + after, caret: before.length + inserted.length };
}
