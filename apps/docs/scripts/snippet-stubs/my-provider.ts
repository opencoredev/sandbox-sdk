// Stand-in for a third-party provider adapter in the conformance example.
import { memory } from "@opencoredev/sandbox-sdk/memory";

export const myProvider = () => memory();
