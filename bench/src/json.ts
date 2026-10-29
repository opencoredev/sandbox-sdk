/** A parsed JSON value, such as an HTTP response body. A missing key reads as `undefined`. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
