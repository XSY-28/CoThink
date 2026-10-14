import { hashJson, sha256 } from "../peer/hash.js";
export { hashJson as discussionHash, sha256 as discussionSha256 };
/** JSON domain snapshots contain no mutable dates, maps or sets. */
export function freezeDiscussionValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDiscussionValue(child);
    Object.freeze(value);
  }
  return value;
}
