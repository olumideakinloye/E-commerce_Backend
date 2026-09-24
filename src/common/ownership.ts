import { isValidObjectId, type FilterQuery, type HydratedDocument, type Model } from 'mongoose';
import { NotFoundError } from './errors.js';

/**
 * Anti-IDOR helper for customer-owned resources (orders, carts, addresses, …).
 *
 * The rule: never `Model.findById(id)` and then compare `doc.userId === userId`
 * in application code. That's a fetch-then-check — it works today, but it's one
 * missed `if` in a future refactor away from leaking another user's data, and
 * nothing enforces it at the call site. Instead, bake the owner into the query
 * filter itself, so a route that forgets this helper simply has no way to fetch
 * cross-user data — there's no separate check to omit.
 *
 * Not-found and not-yours are made indistinguishable on purpose: both return a
 * plain 404 (never 403), and with the same message. A customer enumerating
 * order ids that belong to someone else learns nothing — not even that the id
 * exists. Admin routes that intentionally look up *any* user's resource should
 * query the model directly, not through this helper.
 *
 * A malformed id (wrong length/format) is treated exactly like a well-formed
 * id that doesn't match: still a 404. Mongoose would otherwise throw a
 * `CastError` for `findOne({ _id: 'not-an-id' })`, which the global error
 * handler would turn into a 500 — an infra failure is not the right response to
 * a client typo or a probing request.
 */
export async function findOwnedOrThrow<T>(
  model: Model<T>,
  id: string,
  userId: string,
  notFoundMessage = 'Resource not found',
): Promise<HydratedDocument<T>> {
  if (!isValidObjectId(id)) {
    throw new NotFoundError(notFoundMessage);
  }

  const doc = await model.findOne({ _id: id, userId } as FilterQuery<T>);

  if (!doc) {
    throw new NotFoundError(notFoundMessage);
  }

  return doc as HydratedDocument<T>;
}
