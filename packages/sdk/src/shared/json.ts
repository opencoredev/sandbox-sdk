/** A value JSON can carry: the raw tool arguments an AI framework passes on from the model,
 * before the tool's schema parses them. An `undefined` member is an absent key.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
